import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    action: { type: String, required: true, index: true },
    targetType: { type: String, default: "" },
    targetId: { type: String, default: "" },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

auditLogSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    actorId: this.actorId ? this.actorId.toString() : null,
    action: this.action,
    targetType: this.targetType,
    targetId: this.targetId,
    meta: this.meta,
    createdAt: this.createdAt,
  };
};

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
