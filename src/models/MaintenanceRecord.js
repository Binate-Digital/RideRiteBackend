import mongoose from "mongoose";

/**
 * Company-covered maintenance (TRD 5.6). A driver requests a covered service when it is due
 * (see utils/maintenance.js); admin books it (scheduled), records the cost and completes it.
 * A completed service restarts that type's schedule from its completion date.
 */
const maintenanceRecordSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["oil_change", "annual_inspection", "other"],
      required: true,
    },
    title: { type: String, required: true },
    notes: { type: String, default: "" },
    coveredByPlatform: { type: Boolean, default: true },
    /** What the platform paid — filled in by admin */
    costCents: { type: Number, default: 0 },
    /** The schedule due date this request is for */
    dueAt: { type: Date, default: null },
    /** Appointment booked by admin */
    scheduledFor: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    status: {
      type: String,
      // requested: driver asked, waiting for admin · scheduled: booked · completed · cancelled
      enum: ["requested", "scheduled", "completed", "cancelled"],
      default: "requested",
      index: true,
    },
  },
  { timestamps: true },
);

maintenanceRecordSchema.index({ userId: 1, type: 1, status: 1 });

maintenanceRecordSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId.toString(),
    type: this.type,
    title: this.title,
    notes: this.notes,
    coveredByPlatform: this.coveredByPlatform,
    costCents: this.costCents,
    dueAt: this.dueAt,
    scheduledFor: this.scheduledFor,
    completedAt: this.completedAt,
    status: this.status,
    createdAt: this.createdAt,
  };
};

export const MaintenanceRecord = mongoose.model("MaintenanceRecord", maintenanceRecordSchema);
