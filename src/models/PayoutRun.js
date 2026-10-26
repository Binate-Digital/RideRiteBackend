import mongoose from "mongoose";

/**
 * One automatic weekly payout run (utils/payoutSchedule.js). `key` is the scheduled slot
 * (YYYY-MM-DD of the scheduled UTC day) and unique, so however many API instances sweep at
 * once, only the first to insert the row runs that week's payouts.
 */
const payoutRunSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    scheduledFor: { type: Date, required: true },
    status: { type: String, enum: ["running", "done", "failed"], default: "running" },
    /** Which process ran it (hostname:pid) — handy when several instances share the DB */
    instance: { type: String, default: "" },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    driversPaid: { type: Number, default: 0 },
    driversSkipped: { type: Number, default: 0 },
    driversFailed: { type: Number, default: 0 },
    amountCents: { type: Number, default: 0 },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

payoutRunSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    key: this.key,
    scheduledFor: this.scheduledFor,
    status: this.status,
    instance: this.instance,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    driversPaid: this.driversPaid,
    driversSkipped: this.driversSkipped,
    driversFailed: this.driversFailed,
    amountCents: this.amountCents,
    error: this.error,
  };
};

export const PayoutRun = mongoose.model("PayoutRun", payoutRunSchema);
