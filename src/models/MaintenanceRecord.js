import mongoose from "mongoose";

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
    costCents: { type: Number, default: 0 },
    dueAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["scheduled", "completed", "cancelled"],
      default: "scheduled",
      index: true,
    },
  },
  { timestamps: true },
);

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
    completedAt: this.completedAt,
    status: this.status,
    createdAt: this.createdAt,
  };
};

export const MaintenanceRecord = mongoose.model("MaintenanceRecord", maintenanceRecordSchema);
