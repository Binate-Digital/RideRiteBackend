import mongoose from "mongoose";

export const DISPUTE_CATEGORIES = ["fare", "route", "driver_behavior", "safety", "lost_item", "payment", "other"];
export const DISPUTE_STATUSES = ["open", "in_review", "resolved"];

/**
 * A rider's "Report a problem" on a completed or cancelled trip (TRD 6.4 dispute handling), or
 * a public complaint from the Florida compliance page (source "complaint": the reporter may not
 * be signed in and the trip is optional — `contact` is how we reply).
 * open → in_review (an admin picked it up) → resolved (notes, optional refund, optional note
 * to the driver; the rider — or the complaint's email — is notified).
 */
const disputeSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ["trip", "complaint"], default: "trip", index: true },
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
      index: true,
      required: function requiredForTrip() {
        return this.source !== "complaint";
      },
    },
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
      required: function requiredForTrip() {
        return this.source !== "complaint";
      },
    },
    /** Complaint form: reporter contact, the form's own category, a trip id we couldn't match */
    contact: {
      name: { type: String, default: null },
      email: { type: String, default: null },
      phone: { type: String, default: null },
    },
    complaintCategory: { type: String, default: null },
    tripRef: { type: String, default: null },
    incidentAt: { type: Date, default: null },
    /** "urgent": zero-tolerance (impairment) reports — first in the queue */
    priority: { type: String, enum: ["normal", "urgent"], default: "normal" },
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
    source: this.source || "trip",
    tripId: this.tripId ? this.tripId.toString() : null,
    riderId: this.riderId ? this.riderId.toString() : null,
    contact: this.source === "complaint" ? this.contact : null,
    complaintCategory: this.complaintCategory,
    tripRef: this.tripRef,
    incidentAt: this.incidentAt,
    priority: this.priority || "normal",
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
