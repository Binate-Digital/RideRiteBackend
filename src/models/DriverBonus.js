import mongoose from "mongoose";

const driverBonusSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    monthKey: { type: String, required: true, index: true }, // YYYY-MM
    onTimeRate: { type: Number, default: 0 },
    tripsCompleted: { type: Number, default: 0 },
    safeDrivingScore: { type: Number, default: 100 },
    eligible: { type: Boolean, default: false },
    giftCardCents: { type: Number, default: 10000 }, // $100 default
    status: {
      type: String,
      enum: ["pending_review", "approved", "rejected", "disbursed"],
      default: "pending_review",
      index: true,
    },
    adminNotes: { type: String, default: "" },
    reviewedAt: { type: Date, default: null },
    disbursedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

driverBonusSchema.index({ userId: 1, monthKey: 1 }, { unique: true });

driverBonusSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId.toString(),
    monthKey: this.monthKey,
    onTimeRate: this.onTimeRate,
    tripsCompleted: this.tripsCompleted,
    safeDrivingScore: this.safeDrivingScore,
    eligible: this.eligible,
    giftCardCents: this.giftCardCents,
    status: this.status,
    adminNotes: this.adminNotes,
    reviewedAt: this.reviewedAt,
    disbursedAt: this.disbursedAt,
    createdAt: this.createdAt,
  };
};

export const DriverBonus = mongoose.model("DriverBonus", driverBonusSchema);
