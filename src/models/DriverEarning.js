import mongoose from "mongoose";

/**
 * Driver earnings ledger (TRD 5.7). Every amount the platform owes a driver (or the driver
 * owes back) is one entry; payouts sweep `pending` entries into a DriverPayout.
 *
 * trip:             grossCents = trip base fare (meter + booking fee, excluding the platform
 *                   service fee and tax), commissionCents = PLATFORM_COMMISSION_RATE of it,
 *                   netCents = gross − commission.
 * cancellation_fee: the rider's late-cancel fee, credited to the driver in full.
 * rental:           a peer-to-peer listing owner's share (subtotal − RENTAL_COMMISSION_RATE).
 * bonus:            placeholder for the monthly bonus program (Phase 4).
 * adjustment:       admin correction (+/−).
 * deduction:        money the driver owes, e.g. a cash fare they collected (fare − their net).
 */
export const EARNING_TYPES = ["trip", "cancellation_fee", "rental", "bonus", "adjustment", "deduction"];

const driverEarningSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: EARNING_TYPES, required: true, index: true },
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "Trip", default: null },
    rentalBookingId: { type: mongoose.Schema.Types.ObjectId, ref: "RentalBooking", default: null },
    grossCents: { type: Number, default: 0 },
    commissionCents: { type: Number, default: 0 },
    /** What this entry adds to (or, if negative, removes from) the driver's payout balance */
    netCents: { type: Number, required: true },
    description: { type: String, default: "" },
    /**
     * pending → processing (claimed by a payout run) → paid.
     * collected: already in the driver's hands (cash trip) — shown as earnings, never paid out.
     */
    status: {
      type: String,
      enum: ["pending", "processing", "paid", "collected", "void"],
      default: "pending",
      index: true,
    },
    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "DriverPayout", default: null, index: true },
    paidAt: { type: Date, default: null },
    earnedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

// A trip credits a driver at most once per entry type (retries / double events stay idempotent)
driverEarningSchema.index(
  { tripId: 1, type: 1 },
  { unique: true, partialFilterExpression: { tripId: { $type: "objectId" } } },
);
driverEarningSchema.index(
  { rentalBookingId: 1, type: 1 },
  { unique: true, partialFilterExpression: { rentalBookingId: { $type: "objectId" } } },
);

driverEarningSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    driverId: this.driverId.toString(),
    type: this.type,
    tripId: this.tripId ? this.tripId.toString() : null,
    rentalBookingId: this.rentalBookingId ? this.rentalBookingId.toString() : null,
    grossCents: this.grossCents,
    commissionCents: this.commissionCents,
    netCents: this.netCents,
    description: this.description,
    status: this.status,
    payoutId: this.payoutId ? this.payoutId.toString() : null,
    paidAt: this.paidAt,
    earnedAt: this.earnedAt,
  };
};

export const DriverEarning = mongoose.model("DriverEarning", driverEarningSchema);
