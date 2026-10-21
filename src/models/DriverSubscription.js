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
  },
  { timestamps: true },
);

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
    active: this.isActiveNow(),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const DriverSubscription = mongoose.model(
  "DriverSubscription",
  driverSubscriptionSchema,
);
