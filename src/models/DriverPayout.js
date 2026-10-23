import mongoose from "mongoose";

/** One Stripe Connect transfer of a driver's pending earnings (TRD 5.7 / 6.6). */
const driverPayoutSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amountCents: { type: Number, required: true },
    currency: { type: String, default: "usd" },
    entryCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["processing", "paid", "failed"],
      default: "processing",
      index: true,
    },
    connectAccountId: { type: String, default: null },
    stripeTransferId: { type: String, default: null },
    /** Mock mode or a seeded QA account: no money moved */
    simulated: { type: Boolean, default: false },
    failureReason: { type: String, default: null },
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);

driverPayoutSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    driverId: this.driverId.toString(),
    amountCents: this.amountCents,
    currency: this.currency,
    entryCount: this.entryCount,
    status: this.status,
    connectAccountId: this.connectAccountId,
    stripeTransferId: this.stripeTransferId,
    simulated: this.simulated,
    failureReason: this.failureReason,
    paidAt: this.paidAt,
    createdAt: this.createdAt,
  };
};

export const DriverPayout = mongoose.model("DriverPayout", driverPayoutSchema);
