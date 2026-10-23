import { DriverSubscription, SUBSCRIPTION_PLANS } from "../models/DriverSubscription.js";
import { Payment } from "../models/Payment.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { ensureStripeCustomer, getStripe, isStripeMock } from "../lib/stripe.js";
import { applyStripeSubscription, priceIdForPlan } from "../utils/subscriptionBilling.js";

/** GET /api/subscriptions/plans */
export const listPlans = asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    plans: Object.values(SUBSCRIPTION_PLANS).map((p) => ({
      id: p.id,
      label: p.label,
      amountCents: p.amountCents,
      intervalDays: p.intervalDays,
    })),
  });
});

/** GET /api/subscriptions/me */
export const getMine = asyncHandler(async (req, res) => {
  const sub = await DriverSubscription.findOne({ userId: req.user._id });
  res.json({
    ok: true,
    mode: isStripeMock() ? "mock" : "stripe",
    subscription: sub ? sub.toSafeJSON() : null,
    plans: Object.values(SUBSCRIPTION_PLANS),
  });
});

/** Mock mode: no Stripe — activate instantly so local QA can drive (one simulated period). */
async function activateMock(user, plan) {
  const now = new Date();
  const end = new Date(now.getTime() + plan.intervalDays * 86400000);
  const sub = await DriverSubscription.findOneAndUpdate(
    { userId: user._id },
    {
      $set: {
        plan: plan.id,
        status: "active",
        amountCents: plan.amountCents,
        currentPeriodStart: now,
        currentPeriodEnd: end,
        cancelAtPeriodEnd: false,
        lastPaymentAt: now,
      },
    },
    { upsert: true, new: true },
  );
  await Payment.create({
    userId: user._id,
    purpose: "subscription",
    refId: sub._id,
    amountCents: plan.amountCents,
    status: "succeeded",
    provider: "mock",
    paymentMethodType: "card",
    metadata: { plan: plan.id },
  });
  return sub;
}

/** Client secret of the payment for a subscription's first invoice (API-version tolerant). */
function invoiceClientSecret(invoice) {
  if (!invoice || typeof invoice === "string") return null;
  const pi = invoice.payment_intent;
  if (pi && typeof pi === "object" && pi.client_secret) return pi.client_secret;
  return invoice.confirmation_secret?.client_secret || null;
}

/**
 * POST /api/subscriptions/subscribe — body: { plan: monthly|weekly }
 * Stripe: creates an `incomplete` Subscription and returns the first invoice's client secret
 * for the PaymentElement; `invoice.paid` (or /sync) activates it. Auto-renews in Stripe.
 * Mock: activates instantly. (`/activate` is kept as an alias.)
 */
export const subscribe = asyncHandler(async (req, res) => {
  const planId = String(req.body?.plan || "").trim();
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan) throw httpError(400, "plan must be monthly or weekly");

  const current = await DriverSubscription.findOne({ userId: req.user._id });
  if (current?.isActiveNow() && !current.cancelAtPeriodEnd) {
    throw httpError(409, "Your membership is already active", { code: "ALREADY_ACTIVE" });
  }

  if (isStripeMock()) {
    const sub = await activateMock(req.user, plan);
    return res.json({
      ok: true,
      mode: "mock",
      message: `Activated ${plan.label} plan (test mode)`,
      subscription: sub.toSafeJSON(),
    });
  }

  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(req.user);

  // Resume an unfinished checkout for the same plan instead of stacking subscriptions
  if (current?.stripeSubscriptionId && current.status === "incomplete" && current.plan === plan.id) {
    const existing = await stripe.subscriptions.retrieve(current.stripeSubscriptionId, {
      expand: ["latest_invoice.payment_intent"],
    });
    if (existing.status === "incomplete") {
      const clientSecret = invoiceClientSecret(existing.latest_invoice);
      if (clientSecret) {
        return res.json({
          ok: true,
          mode: "stripe",
          clientSecret,
          amountCents: plan.amountCents,
          subscription: current.toSafeJSON(),
        });
      }
    }
  }
  // A still-running Stripe subscription that was set to cancel: just un-cancel it
  if (current?.stripeSubscriptionId && current.isActiveNow() && current.cancelAtPeriodEnd) {
    const resumed = await stripe.subscriptions.update(current.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
    const sub = await applyStripeSubscription(resumed);
    return res.json({ ok: true, mode: "stripe", message: "Membership resumed", subscription: sub.toSafeJSON() });
  }

  const stripeSub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: await priceIdForPlan(plan.id) }],
    payment_behavior: "default_incomplete",
    payment_settings: { save_default_payment_method: "on_subscription", payment_method_types: ["card"] },
    expand: ["latest_invoice.payment_intent"],
    metadata: { userId: req.user._id.toString(), plan: plan.id, purpose: "subscription", app: "riderite" },
  });
  // Point our record at the new subscription first, so the old one's deletion webhook is ignored
  const sub = await applyStripeSubscription(stripeSub);
  // Abandon the previous unfinished / failed one so it can't be charged later
  if (
    current?.stripeSubscriptionId &&
    current.stripeSubscriptionId !== stripeSub.id &&
    ["incomplete", "past_due"].includes(current.status)
  ) {
    await stripe.subscriptions.cancel(current.stripeSubscriptionId).catch(() => {});
  }
  const clientSecret = invoiceClientSecret(stripeSub.latest_invoice);

  res.status(201).json({
    ok: true,
    mode: "stripe",
    clientSecret,
    amountCents: plan.amountCents,
    subscription: sub.toSafeJSON(),
  });
});

export const activate = subscribe;

/** POST /api/subscriptions/sync — after the client confirms the first payment */
export const sync = asyncHandler(async (req, res) => {
  const current = await DriverSubscription.findOne({ userId: req.user._id });
  if (!current) throw httpError(404, "No subscription found");
  if (isStripeMock() || !current.stripeSubscriptionId) {
    return res.json({ ok: true, subscription: current.toSafeJSON() });
  }
  const stripeSub = await getStripe().subscriptions.retrieve(current.stripeSubscriptionId);
  const sub = await applyStripeSubscription(stripeSub);
  if (sub.status === "active" && !sub.lastPaymentAt) {
    sub.lastPaymentAt = new Date();
    await sub.save();
  }
  res.json({ ok: true, subscription: sub.toSafeJSON() });
});

/** POST /api/subscriptions/cancel — cancel at period end (rides stay allowed until then) */
export const cancel = asyncHandler(async (req, res) => {
  const sub = await DriverSubscription.findOne({ userId: req.user._id });
  if (!sub) throw httpError(404, "No subscription found");
  if (!isStripeMock() && sub.stripeSubscriptionId) {
    if (sub.status === "incomplete") {
      await getStripe().subscriptions.cancel(sub.stripeSubscriptionId);
      sub.status = "canceled";
      await sub.save();
      return res.json({ ok: true, subscription: sub.toSafeJSON() });
    }
    const updated = await getStripe().subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    const saved = await applyStripeSubscription(updated);
    return res.json({ ok: true, subscription: saved.toSafeJSON() });
  }
  // Mock mode / DB-only (seeded QA) memberships
  sub.cancelAtPeriodEnd = true;
  await sub.save();
  res.json({ ok: true, subscription: sub.toSafeJSON() });
});

/** POST /api/subscriptions/resume — undo a pending cancel-at-period-end */
export const resume = asyncHandler(async (req, res) => {
  const sub = await DriverSubscription.findOne({ userId: req.user._id });
  if (!sub?.isActiveNow()) throw httpError(400, "No active membership to resume");
  if (!isStripeMock() && sub.stripeSubscriptionId) {
    const updated = await getStripe().subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
    const saved = await applyStripeSubscription(updated);
    return res.json({ ok: true, subscription: saved.toSafeJSON() });
  }
  sub.cancelAtPeriodEnd = false;
  await sub.save();
  res.json({ ok: true, subscription: sub.toSafeJSON() });
});

export async function driverHasActiveSubscription(userId) {
  const sub = await DriverSubscription.findOne({ userId });
  return Boolean(sub?.isActiveNow());
}
