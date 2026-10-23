import mongoose from "mongoose";

export const DISPUTE_CATEGORIES = ["fare", "route", "driver_behavior", "safety", "lost_item", "payment", "other"];
export const DISPUTE_STATUSES = ["open", "in_review", "resolved"];

/**
 * A rider's "Report a problem" on a completed or cancelled trip (TRD 6.4 dispute handling).
 * open → in_review (an admin picked it up) → resolved (notes, optional refund, optional note
 * to the driver; the rider is notified).
 */
const disputeSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "Trip", required: true, index: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    category: { type: String, enum: DISPUTE_CATEGORIES, required: true },
    description: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: DISPUTE_STATUSES, default: "open", index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolutionNotes: { type: String, default: "", maxlength: 2000 },
    /** Note sent to the driver on resolution (e.g. a warning), if any */
    driverNote: { type: String, default: "", maxlength: 1000 },
    refundCents: { type: Number, default: 0 },
    refundId: { type: String, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

disputeSchema.index({ status: 1, createdAt: -1 });

disputeSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    tripId: this.tripId.toString(),
    riderId: this.riderId.toString(),
    driverId: this.driverId ? this.driverId.toString() : null,
    category: this.category,
    description: this.description,
    status: this.status,
    assignedTo: this.assignedTo ? this.assignedTo.toString() : null,
    resolutionNotes: this.resolutionNotes,
    driverNote: this.driverNote,
    refundCents: this.refundCents,
    resolvedAt: this.resolvedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Dispute = mongoose.model("Dispute", disputeSchema);
