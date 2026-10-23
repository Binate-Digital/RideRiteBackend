import { DriverSubscription, SUBSCRIPTION_PLANS } from "../models/DriverSubscription.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { Payment } from "../models/Payment.js";
import { Trip } from "../models/Trip.js";
import { env } from "../config/env.js";
import { getStripe } from "../lib/stripe.js";
import { declineOffer } from "./dispatch.js";
import { notifyUser } from "../controllers/notifications.controller.js";

/**
 * Driver subscription billing on Stripe Billing (TRD 5.4). Stripe owns renewals; we mirror
 * its state on DriverSubscription from webhooks (and from /sync after the client confirms).
 */

const PLAN_INTERVAL = {
  monthly: { interval: "month", envPrice: () => env.stripePriceMonthly },
  weekly: { interval: "week", envPrice: () => env.stripePriceWeekly },
};

export const lookupKeyFor = (planId) => `riderite_driver_${planId}`;

const priceCache = new Map();

/** Price id for a plan: STRIPE_PRICE_DRIVER_* env, else by lookup_key, else created once. */
export async function priceIdForPlan(planId) {
  const plan = SUBSCRIPTION_PLANS[planId];
  const cfg = PLAN_INTERVAL[planId];
  if (!plan || !cfg) throw new Error(`Unknown plan ${planId}`);
  if (cfg.envPrice()) return cfg.envPrice();
  if (priceCache.has(planId)) return priceCache.get(planId);

  const stripe = getStripe();
  const key = lookupKeyFor(planId);
  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  let price = found.data[0];
  if (!price || price.unit_amount !== plan.amountCents) {
    price = await stripe.prices.create({
      currency: "usd",
      unit_amount: plan.amountCents,
      recurring: { interval: cfg.interval },
      lookup_key: key,
      // Moves the key over if an old price at a different amount still holds it
      transfer_lookup_key: true,
      product_data: { name: `${env.appName} driver membership (${plan.label})` },
      metadata: { app: "riderite", plan: planId },
    });
  }
  priceCache.set(planId, price.id);
  return price.id;
}

const STATUS_MAP = {
  active: "active",
  trialing: "active",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete: "incomplete",
  incomplete_expired: "expired",
  paused: "past_due",
};

/** Period bounds live on the subscription (older API versions) or on its items (newer). */
function periodOf(stripeSub) {
  const item = stripeSub.items?.data?.[0];
  const start = stripeSub.current_period_start ?? item?.current_period_start;
  const end = stripeSub.current_period_end ?? item?.current_period_end;
  return {
    start: start ? new Date(start * 1000) : null,
    end: end ? new Date(end * 1000) : null,
  };
}

function planFromStripe(stripeSub) {
  const fromMeta = stripeSub.metadata?.plan;
  if (SUBSCRIPTION_PLANS[fromMeta]) return fromMeta;
  const interval = stripeSub.items?.data?.[0]?.price?.recurring?.interval;
  return interval === "week" ? "weekly" : "monthly";
}

/** Copy a Stripe Subscription object onto our record. Returns the updated DriverSubscription. */
export async function applyStripeSubscription(stripeSub) {
  const existing = await DriverSubscription.findOne({ stripeSubscriptionId: stripeSub.id });
  const userId = existing?.userId || stripeSub.metadata?.userId;
  if (!userId) return null;
  const planId = planFromStripe(stripeSub);
  const { start, end } = periodOf(stripeSub);
  const status = STATUS_MAP[stripeSub.status] || "incomplete";
  const before = existing?.status;

  const sub = await DriverSubscription.findOneAndUpdate(
    { userId },
    {
      $set: {
        plan: planId,
        amountCents: SUBSCRIPTION_PLANS[planId].amountCents,
        status,
        stripeSubscriptionId: stripeSub.id,
        stripeCustomerId: typeof stripeSub.customer === "string" ? stripeSub.customer : stripeSub.customer?.id,
        cancelAtPeriodEnd: Boolean(stripeSub.cancel_at_period_end),
        ...(start ? { currentPeriodStart: start } : {}),
        ...(end ? { currentPeriodEnd: end } : {}),
      },
    },
    { upsert: true, new: true },
  );

  if (before === "active" && ["past_due", "canceled", "expired"].includes(status)) {
    await forceDriverOffline(sub.userId, status);
  }
  return sub;
}

/** Subscription lapsed: take the driver offline (and pass on any offer they hold) and tell them. */
export async function forceDriverOffline(userId, status) {
  const profile = await DriverProfile.findOneAndUpdate(
    { userId, isOnline: true },
    { $set: { isOnline: false } },
    { new: true },
  );
  if (profile) {
    const holding = await Trip.find({ status: "requested", offeredDriverId: userId });
    for (const trip of holding) await declineOffer(trip, userId, "offline");
  }
  await notifyUser(userId, {
    category: "subscription",
    title: status === "past_due" ? "Membership payment failed" : "Membership ended",
    body:
      status === "past_due"
        ? "We couldn't renew your driver membership, so you've been taken offline. Update your card in Billing to keep driving."
        : "Your driver membership is no longer active. Subscribe again in Billing to receive ride requests.",
    data: { href: "/driver/billing", status },
    email: true,
  });
}

/** Subscription id an invoice belongs to, across API versions. */
function invoiceSubscriptionId(invoice) {
  const s = invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null;
  return typeof s === "string" ? s : s?.id || null;
}

/** invoice.paid — the period is paid: active until the invoice line's period end. */
export async function handleInvoicePaid(invoice) {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return null;
  let sub = await DriverSubscription.findOne({ stripeSubscriptionId: subId });
  // Pull the subscription for authoritative period/status (also covers a missed creation)
  try {
    const stripeSub = await getStripe().subscriptions.retrieve(subId);
    sub = await applyStripeSubscription(stripeSub);
  } catch (err) {
    if (!sub) throw err;
    const line = invoice.lines?.data?.[0];
    if (line?.period?.end) {
      sub.currentPeriodStart = new Date(line.period.start * 1000);
      sub.currentPeriodEnd = new Date(line.period.end * 1000);
    }
    sub.status = "active";
    await sub.save();
  }
  if (!sub) return null;
  sub.lastPaymentAt = new Date((invoice.status_transitions?.paid_at || Date.now() / 1000) * 1000);
  await sub.save();

  // A renewal charge (not the first invoice) → tell the driver once per invoice
  const isRenewal = invoice.billing_reason === "subscription_cycle";
  const alreadyRecorded = await Payment.exists({ stripeInvoiceId: invoice.id, status: "succeeded" });
  if (isRenewal && !alreadyRecorded) {
    await notifyUser(sub.userId, {
      category: "subscription",
      title: "Membership renewed",
      body: `$${((invoice.amount_paid ?? sub.amountCents) / 100).toFixed(2)} charged — your driver membership is active until ${sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString("en-US") : "the next renewal"}.`,
      data: { href: "/driver/billing", status: "active" },
      email: true,
    });
  }

  const piId = typeof invoice.payment_intent === "string" ? invoice.payment_intent : invoice.payment_intent?.id;
  await Payment.findOneAndUpdate(
    { stripeInvoiceId: invoice.id },
    {
      $set: { status: "succeeded" },
      $setOnInsert: {
        userId: sub.userId,
        purpose: "subscription",
        refId: sub._id,
        amountCents: invoice.amount_paid ?? sub.amountCents,
        currency: invoice.currency || "usd",
        provider: "stripe",
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: piId || null,
        paymentMethodType: "card",
        metadata: { plan: sub.plan },
      },
    },
    { upsert: true, new: true },
  );
  return sub;
}

/** invoice.payment_failed — renewal (or first charge) failed: past_due, driver offline. */
export async function handleInvoicePaymentFailed(invoice) {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return null;
  const sub = await DriverSubscription.findOne({ stripeSubscriptionId: subId });
  if (!sub) return null;
  // The first invoice of a new subscription failing just means checkout isn't done yet
  if (sub.status === "incomplete") return sub;
  sub.status = "past_due";
  await sub.save();
  await forceDriverOffline(sub.userId, "past_due");
  return sub;
}

/** customer.subscription.deleted — ended (canceled at period end, or by Stripe after dunning). */
export async function handleSubscriptionDeleted(stripeSub) {
  const sub = await DriverSubscription.findOne({ stripeSubscriptionId: stripeSub.id });
  if (!sub) return null;
  const wasActive = sub.status === "active";
  sub.status = "canceled";
  sub.cancelAtPeriodEnd = false;
  const { end } = periodOf(stripeSub);
  if (stripeSub.ended_at) sub.currentPeriodEnd = new Date(stripeSub.ended_at * 1000);
  else if (end) sub.currentPeriodEnd = end;
  await sub.save();
  if (wasActive) await forceDriverOffline(sub.userId, "canceled");
  return sub;
}
