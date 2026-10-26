import mongoose from "mongoose";

export const SUBSCRIPTION_PLANS = {
  monthly: { id: "monthly", label: "Monthly", amountCents: 10000, intervalDays: 30 },
  weekly: { id: "weekly", label: "Weekly", amountCents: 3200, intervalDays: 7 },
};

const driverSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ["monthly", "weekly"],
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "past_due", "canceled", "expired", "incomplete"],
      default: "incomplete",
      index: true,
    },
    amountCents: { type: Number, required: true },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    stripeSubscriptionId: { type: String, default: null, index: true },
    stripeCustomerId: { type: String, default: null },
    lastPaymentAt: { type: Date, default: null },
    /** First time this driver's membership became active — maintenance schedule anchor (TRD 5.6) */
    firstActiveAt: { type: Date, default: null },
    /** Period end a "membership ends soon" notice was sent for (one per period) */
    expiryNoticeFor: { type: Date, default: null },
    /**
     * "Set up auto-renew" on a manual membership (no Stripe subscription behind it): a Stripe
     * subscription trialing until the current period end, adopted once its card is saved.
     */
    pendingStripeSubscriptionId: { type: String, default: null, index: true },
  },
  { timestamps: true },
);

/**
 * What the driver can expect next — drives the billing page actions and notice copy:
 *   renewing    Stripe subscription, renews automatically at currentPeriodEnd
 *   ending      Stripe subscription set to cancel at period end (Resume undoes it)
 *   manual      active without a Stripe subscription (mock / seeded / admin): ends at
 *               currentPeriodEnd, never renews (Renew / Set up auto-renew)
 *   past_due    a renewal charge failed; expired / canceled / incomplete as stored
 */
driverSubscriptionSchema.methods.billingState = function billingState() {
  if (this.status === "active") {
    if (!this.currentPeriodEnd || new Date(this.currentPeriodEnd).getTime() <= Date.now()) return "expired";
    if (!this.stripeSubscriptionId) return "manual";
    return this.cancelAtPeriodEnd ? "ending" : "renewing";
  }
  return this.status;
};

driverSubscriptionSchema.methods.isActiveNow = function isActiveNow() {
  if (this.status !== "active") return false;
  if (!this.currentPeriodEnd) return false;
  return new Date(this.currentPeriodEnd).getTime() > Date.now();
};

driverSubscriptionSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId.toString(),
    plan: this.plan,
    status: this.status,
    amountCents: this.amountCents,
    currentPeriodStart: this.currentPeriodStart,
    currentPeriodEnd: this.currentPeriodEnd,
    cancelAtPeriodEnd: this.cancelAtPeriodEnd,
    firstActiveAt: this.firstActiveAt,
    active: this.isActiveNow(),
    billing: this.stripeSubscriptionId ? "stripe" : "manual",
    state: this.billingState(),
    autoRenews: this.billingState() === "renewing",
    autoRenewPending: Boolean(this.pendingStripeSubscriptionId),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const DriverSubscription = mongoose.model(
  "DriverSubscription",
  driverSubscriptionSchema,
);
