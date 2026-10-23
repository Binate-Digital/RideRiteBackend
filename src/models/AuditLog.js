import mongoose from "mongoose";

/**
 * Admin audit trail (TRD 6.9): every admin action — approvals, role and status changes,
 * refunds, payouts, settings, disputes, listings, bonuses, maintenance, exports, logins.
 * Actor details are copied in so the trail stays readable if the admin is later removed.
 */
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    actorEmail: { type: String, default: null },
    actorName: { type: String, default: null },
    actorAdminRole: { type: String, default: null },
    action: { type: String, required: true, index: true },
    targetType: { type: String, default: "", index: true },
    targetId: { type: String, default: "", index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });

auditLogSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    actorId: this.actorId ? this.actorId.toString() : null,
    actorEmail: this.actorEmail,
    actorName: this.actorName,
    actorAdminRole: this.actorAdminRole,
    action: this.action,
    targetType: this.targetType,
    targetId: this.targetId,
    meta: this.meta,
    ip: this.ip,
    createdAt: this.createdAt,
  };
};

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
