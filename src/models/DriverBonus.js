import mongoose from "mongoose";

/**
 * One driver's monthly bonus record (TRD 5.5), keyed by UTC month (YYYY-MM).
 *
 * in_progress     current month: metrics are recomputed on view and nightly
 * pending_review  month ended and the driver met every threshold — waits for admin
 * ineligible      month ended below a threshold (frozen, no bonus)
 * approved        admin approved: a `bonus` entry in the earnings ledger pays it out
 * rejected        admin declined it
 * disbursed       admin marked the gift card as sent (optional gift-card code)
 */
export const BONUS_STATUSES = ["in_progress", "pending_review", "ineligible", "approved", "rejected", "disbursed"];

const driverBonusSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    monthKey: { type: String, required: true, index: true }, // YYYY-MM
    tripsCompleted: { type: Number, default: 0 },
    /** Completed trips with an ETA quoted at accept and an arrival time (on-time denominator) */
    measuredTrips: { type: Number, default: 0 },
    onTimeTrips: { type: Number, default: 0 },
    /** onTimeTrips / measuredTrips (0 when nothing was measured) */
    onTimeRate: { type: Number, default: 0 },
    driverCancellations: { type: Number, default: 0 },
    ratedTrips: { type: Number, default: 0 },
    averageRating: { type: Number, default: null },
    /** Rider complaints; no complaint model exists yet, so ratings ≤ 2 count as incidents */
    incidents: { type: Number, default: 0 },
    safeDrivingScore: { type: Number, default: 100 },
    eligible: { type: Boolean, default: false },
    /** Thresholds the month was judged against (env at the time) */
    thresholds: { type: Object, default: null },
    giftCardCents: { type: Number, default: 10000 },
    giftCardCode: { type: String, default: "" },
    status: { type: String, enum: BONUS_STATUSES, default: "in_progress", index: true },
    adminNotes: { type: String, default: "" },
    computedAt: { type: Date, default: null },
    /** Month closed: metrics no longer change */
    frozenAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    earningId: { type: mongoose.Schema.Types.ObjectId, ref: "DriverEarning", default: null },
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
    tripsCompleted: this.tripsCompleted,
    measuredTrips: this.measuredTrips,
    onTimeTrips: this.onTimeTrips,
    onTimeRate: this.onTimeRate,
    driverCancellations: this.driverCancellations,
    ratedTrips: this.ratedTrips,
    averageRating: this.averageRating,
    incidents: this.incidents,
    safeDrivingScore: this.safeDrivingScore,
    eligible: this.eligible,
    thresholds: this.thresholds,
    giftCardCents: this.giftCardCents,
    giftCardCode: this.giftCardCode,
    status: this.status,
    adminNotes: this.adminNotes,
    computedAt: this.computedAt,
    frozenAt: this.frozenAt,
    reviewedAt: this.reviewedAt,
    earningId: this.earningId ? this.earningId.toString() : null,
    disbursedAt: this.disbursedAt,
    createdAt: this.createdAt,
  };
};

export const DriverBonus = mongoose.model("DriverBonus", driverBonusSchema);
