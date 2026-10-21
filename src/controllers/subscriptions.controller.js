import { DriverSubscription, SUBSCRIPTION_PLANS } from "../models/DriverSubscription.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";

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
    subscription: sub ? sub.toSafeJSON() : null,
    plans: Object.values(SUBSCRIPTION_PLANS),
  });
});

/**
 * POST /api/subscriptions/activate — body: { plan: monthly|weekly }
 * Alpha: activate without live Stripe subscription webhook (mock/instant activate).
 * When Stripe is live, replace with Checkout Session + webhook.
 */
export const activate = asyncHandler(async (req, res) => {
  const planId = String(req.body?.plan || "").trim();
  const plan = SUBSCRIPTION_PLANS[planId];
  if (!plan) throw httpError(400, "plan must be monthly or weekly");

  const now = new Date();
  const end = new Date(now.getTime() + plan.intervalDays * 86400000);

  const sub = await DriverSubscription.findOneAndUpdate(
    { userId: req.user._id },
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

  res.json({
    ok: true,
    message: `Activated ${plan.label} plan`,
    mode: env.stripeMock ? "mock" : "manual_activate",
    subscription: sub.toSafeJSON(),
  });
});

/** POST /api/subscriptions/cancel — cancel at period end */
export const cancel = asyncHandler(async (req, res) => {
  const sub = await DriverSubscription.findOne({ userId: req.user._id });
  if (!sub) throw httpError(404, "No subscription found");
  sub.cancelAtPeriodEnd = true;
  await sub.save();
  res.json({ ok: true, subscription: sub.toSafeJSON() });
});

export async function driverHasActiveSubscription(userId) {
  const sub = await DriverSubscription.findOne({ userId });
  return Boolean(sub?.isActiveNow());
}
