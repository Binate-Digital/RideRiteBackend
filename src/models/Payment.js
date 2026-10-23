import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
      index: true,
    },
    purpose: {
      type: String,
      enum: ["ride", "setup_card", "refund", "rental", "chauffeur", "subscription"],
      default: "ride",
      index: true,
    },
    /** Rental / chauffeur booking or driver subscription this payment is for. */
    refId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    amountCents: { type: Number, required: true },
    currency: { type: String, default: "usd" },
    status: {
      type: String,
      enum: ["pending", "succeeded", "failed", "canceled", "refunded", "partially_refunded"],
      default: "pending",
      index: true,
    },
    provider: {
      type: String,
      enum: ["stripe", "mock", "offline"],
      default: "mock",
    },
    stripePaymentIntentId: { type: String, default: null, index: true },
    stripeSetupIntentId: { type: String, default: null },
    paymentMethodType: { type: String, default: null },
    stripeInvoiceId: { type: String, default: null, index: true },
    /** Total refunded so far (cents); never more than amountCents. */
    refundedCents: { type: Number, default: 0 },
    refunds: {
      type: [
        {
          _id: false,
          refundId: String,
          amountCents: Number,
          reason: String,
          simulated: Boolean,
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

paymentSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId.toString(),
    tripId: this.tripId ? this.tripId.toString() : null,
    refId: this.refId ? this.refId.toString() : null,
    purpose: this.purpose,
    amountCents: this.amountCents,
    currency: this.currency,
    status: this.status,
    provider: this.provider,
    stripePaymentIntentId: this.stripePaymentIntentId,
    paymentMethodType: this.paymentMethodType,
    refundedCents: this.refundedCents,
    refunds: this.refunds,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Payment = mongoose.model("Payment", paymentSchema);
