import { AuditLog } from "../models/AuditLog.js";
import { effectiveAdminRole } from "./permissions.js";

/**
 * Record an admin action. `req` supplies the actor (req.user), IP and user agent; pass
 * `{ user }` instead outside a request (e.g. login before req.user exists). Never throws —
 * a failed audit write must not undo the action it describes.
 */
export async function audit(req, action, targetType = "", targetId = "", meta = {}) {
  try {
    const user = req?.user || null;
    await AuditLog.create({
      actorId: user?._id || null,
      actorEmail: user?.email || null,
      actorName: user?.fullName || null,
      actorAdminRole: effectiveAdminRole(user),
      action,
      targetType,
      targetId: targetId ? String(targetId) : "",
      meta,
      ip: req?.ip || null,
      userAgent: req?.get ? String(req.get("user-agent") || "").slice(0, 300) || null : null,
    });
  } catch (err) {
    console.error("[audit] write failed:", err.message);
  }
}
