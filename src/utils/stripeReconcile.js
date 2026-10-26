import { Payment } from "../models/Payment.js";
import { DriverSubscription } from "../models/DriverSubscription.js";
import { env } from "../config/env.js";
import { getStripe, isStripeMock } from "../lib/stripe.js";
import { applyStripeSubscription, handleInvoicePaid } from "./subscriptionBilling.js";

/**
 * Safety net for missed webhooks (e.g. STRIPE_WEBHOOK_SECRET not set, an outage, or the rider
 * closing the tab before the client's /sync call). Run from the payments sweeper:
 *  - card payments still `pending` here are re-read from Stripe; succeeded / failed intents go
 *    through exactly the handlers the webhook uses (all idempotent)
 *  - Stripe-billed memberships that look lapsed or unfinished are re-read, so a renewal Stripe
 *    charged is applied (and recorded) even without `invoice.paid`
 * Each object is re-checked at most every RECHECK_MS per instance.
 */

const RECHECK_MS = 2 * 60000;
const SUB_RECHECK_MS = 15 * 60000;
const lastChecked = new Map();

function due(key, every, now) {
  const at = lastChecked.get(key) || 0;
  if (now - at < every) return false;
  lastChecked.set(key, now);
  if (lastChecked.size > 5000) lastChecked.clear();
  return true;
}

export async function reconcilePendingIntents(now = new Date()) {
  if (isStripeMock()) return 0;
  const rows = await Payment.find({
    provider: "stripe",
    status: "pending",
    stripePaymentIntentId: { $ne: null },
    createdAt: { $gte: new Date(now.getTime() - 24 * 3600000), $lte: new Date(now.getTime() - 60000) },
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  const { onIntentFailed, onIntentSucceeded } = await import("../controllers/payments.controller.js");
  let fixed = 0;
  for (const p of rows) {
    if (!due(p.stripePaymentIntentId, RECHECK_MS, now.getTime())) continue;
    try {
      const pi = await getStripe().paymentIntents.retrieve(p.stripePaymentIntentId);
      if (pi.status === "succeeded") {
        await onIntentSucceeded(pi);
        fixed += 1;
      } else if (pi.status === "canceled") {
        await Payment.updateOne({ _id: p._id, status: "pending" }, { $set: { status: "canceled" } });
        fixed += 1;
      } else if (pi.status === "requires_payment_method" && pi.last_payment_error) {
        await onIntentFailed(pi);
        fixed += 1;
      }
    } catch (err) {
      console.error(`[stripe] reconcile ${p.stripePaymentIntentId}:`, err.message);
    }
  }
  return fixed;
}

export async function reconcileSubscriptions(now = new Date()) {
  if (isStripeMock()) return 0;
  const subs = await DriverSubscription.find({
    stripeSubscriptionId: { $ne: null },
    $or: [{ status: { $in: ["incomplete", "past_due"] } }, { status: "active", currentPeriodEnd: { $lte: now } }],
  }).limit(20);
  let n = 0;
  for (const sub of subs) {
    if (!due(`sub_${sub.stripeSubscriptionId}`, SUB_RECHECK_MS, now.getTime())) continue;
    try {
      const stripeSub = await getStripe().subscriptions.retrieve(sub.stripeSubscriptionId, { expand: ["latest_invoice"] });
      const invoice = stripeSub.latest_invoice;
      if (invoice && typeof invoice === "object" && invoice.status === "paid") await handleInvoicePaid(invoice);
      else await applyStripeSubscription(stripeSub);
      n += 1;
    } catch (err) {
      console.error(`[stripe] reconcile subscription ${sub.stripeSubscriptionId}:`, err.message);
    }
  }
  return n;
}

/** Loud startup notice when real Stripe runs without webhook signature verification. */
export function warnIfWebhookUnverified() {
  if (isStripeMock() || env.stripeWebhookSecret) return;
  console.warn(
    [
      "",
      "[stripe] ================================================================",
      "[stripe] STRIPE_WEBHOOK_SECRET is NOT set: /api/payments/webhook rejects every event.",
      "[stripe] Payments still settle via the app's confirm/sync calls and a reconcile sweep,",
      "[stripe] but set the endpoint's signing secret (see .env.example) for prompt updates.",
      "[stripe] ================================================================",
      "",
    ].join("\n"),
  );
}
