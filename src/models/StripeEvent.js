import mongoose from "mongoose";

/** Stripe webhook event ids already handled — Stripe retries deliveries, we act once. */
const stripeEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, default: "" },
  },
  { timestamps: true },
);

// Keep 30 days of ids; Stripe stops retrying after 3 days
stripeEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });

export const StripeEvent = mongoose.model("StripeEvent", stripeEventSchema);
