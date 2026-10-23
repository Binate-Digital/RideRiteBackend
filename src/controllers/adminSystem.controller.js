import mongoose from "mongoose";
import { z } from "zod";
import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { Trip } from "../models/Trip.js";
import { AuditLog } from "../models/AuditLog.js";
import { Dispute } from "../models/Dispute.js";
import { RentalListing } from "../models/RentalListing.js";
import { DriverBonus } from "../models/DriverBonus.js";
import { MaintenanceRecord } from "../models/MaintenanceRecord.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { audit } from "../utils/audit.js";
import {
  ADMIN_ROLE_LABELS,
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  effectiveAdminRole,
  permissionsFor,
} from "../utils/permissions.js";
import { dailyTrends, revenueSummary, subscriptionOverview } from "../utils/revenue.js";
import { defaultSettings, getSettings, updateSettings } from "../utils/settings.js";
import { metricsSnapshot } from "../middleware/metrics.js";
import { liveCounters, realtimeStats } from "../realtime/index.js";
import { dateFilter, escapeRegex, isObjectId, paged, parseDateRange, parsePaging, requireObjectId } from "../utils/adminQuery.js";
import { env } from "../config/env.js";

/** Admin: session info, dashboard, admin accounts (RBAC), settings, audit trail, health. */

/** GET /api/admin/me — the signed-in admin with role and permissions (the UI hides the rest) */
export const me = asyncHandler(async (req, res) => {
  res.json({
    ok: true,
    user: req.user.toSafeJSON(),
    adminRole: effectiveAdminRole(req.user),
    permissions: permissionsFor(req.user),
    roles: ADMIN_ROLES.map((r) => ({ id: r, label: ADMIN_ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] })),
  });
});

/** GET /api/admin/analytics?days=7|30 — dashboard (TRD 6.2) */
export const analytics = asyncHandler(async (req, res) => {
  const days = Number(req.query.days) === 30 ? 30 : 7;
  const since = new Date(Date.now() - days * 86400000);
  const [
    totalTrips,
    completed,
    cancelled,
    tripsInPeriod,
    riders,
    drivers,
    approvedDrivers,
    pendingDrivers,
    suspendedUsers,
    newUsers,
    live,
    revenueAll,
    revenuePeriod,
    subscriptions,
    trends,
    queues,
  ] = await Promise.all([
    Trip.countDocuments(),
    Trip.countDocuments({ status: "completed" }),
    Trip.countDocuments({ status: "cancelled" }),
    Trip.countDocuments({ createdAt: { $gte: since } }),
    User.countDocuments({ role: "rider", anonymizedAt: null }),
    User.countDocuments({ role: "driver", anonymizedAt: null }),
    DriverProfile.countDocuments({ isApproved: true, verificationStatus: "approved" }),
    // KYC queue: submitted applications (profiles still being filled in are not "pending")
    DriverProfile.countDocuments({ verificationStatus: "pending", isApproved: { $ne: true } }),
    User.countDocuments({ "suspension.status": { $in: ["suspended", "deactivated"] } }),
    User.countDocuments({ role: { $ne: "admin" }, createdAt: { $gte: since } }),
    liveCounters(),
    revenueSummary(),
    revenueSummary({ from: since }),
    subscriptionOverview(),
    dailyTrends(days),
    Promise.all([
      Dispute.countDocuments({ status: { $ne: "resolved" } }),
      RentalListing.countDocuments({ status: "pending" }),
      DriverBonus.countDocuments({ status: "pending_review" }),
      MaintenanceRecord.countDocuments({ status: "requested" }),
      DriverProfile.countDocuments({
        $or: [
          { "documentReview.license.status": "pending" },
          { "documentReview.registration.status": "pending" },
          { "documentReview.insurance.status": "pending" },
          { pendingVehicleChange: { $ne: null } },
        ],
      }),
    ]),
  ]);
  const [openDisputes, listingReviews, bonusReviews, maintenanceRequests, documentReviews] = queues;
  res.json({
    ok: true,
    days,
    totalTrips,
    completed,
    cancelled,
    active: live.activeTrips,
    tripsInPeriod,
    trips7d: days === 7 ? tripsInPeriod : await Trip.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } }),
    users: { riders, drivers, total: riders + drivers, suspended: suspendedUsers, newInPeriod: newUsers },
    totalUsers: riders + drivers,
    totalDrivers: drivers,
    driverCounts: { approved: approvedDrivers, pending: pendingDrivers },
    live,
    revenue: { allTime: revenueAll, period: revenuePeriod },
    // Back-compat (older dashboard build)
    grossCents: revenueAll.rideFareCents,
    paidCents: revenueAll.collectedCents,
    payables: {
      pendingCents: revenueAll.payablePendingCents,
      pendingDrivers: revenueAll.payablePendingDrivers,
      processingCents: revenueAll.payableProcessingCents,
    },
    subscriptions,
    trends,
    queues: { openDisputes, listingReviews, bonusReviews, maintenanceRequests, documentReviews, kyc: pendingDrivers },
  });
});

// ----------------------------------------------------------------------------- admin accounts

function adminRow(u) {
  return {
    id: u._id.toString(),
    fullName: u.fullName,
    email: u.email ?? null,
    adminRole: effectiveAdminRole(u),
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
  };
}

/** GET /api/admin/admins */
export const listAdmins = asyncHandler(async (_req, res) => {
  const rows = await User.find({ role: "admin" }).sort({ createdAt: 1 });
  res.json({
    ok: true,
    admins: rows.map(adminRow),
    roles: ADMIN_ROLES.map((r) => ({ id: r, label: ADMIN_ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] })),
  });
});

const createAdminSchema = z.object({
  email: z.string().trim().email().max(120),
  fullName: z.string().trim().min(2).max(80).optional(),
  adminRole: z.enum(ADMIN_ROLES),
  /** New account only; an existing user keeps their password */
  password: z.string().min(8).max(128).optional(),
});

/**
 * POST /api/admin/admins — body: { email, adminRole, fullName?, password? }
 * Promotes an existing account to admin, or creates a new admin account (password required).
 */
export const createAdmin = asyncHandler(async (req, res) => {
  const data = createAdminSchema.parse(req.body || {});
  const email = data.email.toLowerCase();
  let user = await User.findOne({ email });
  let created = false;
  if (user) {
    if (user.role === "admin") throw httpError(409, "That account is already an admin");
    if (user.anonymizedAt) throw httpError(400, "That account was deleted");
    // A driver promoted to admin stops driving
    await DriverProfile.updateOne({ userId: user._id }, { $set: { isOnline: false } });
    const from = user.role;
    user.role = "admin";
    user.adminRole = data.adminRole;
    user.isActive = true;
    user.suspension = null;
    await user.save();
    await audit(req, "admin.promote", "User", user._id, { email, from, adminRole: data.adminRole });
  } else {
    if (!data.password) throw httpError(400, "A password is required to create a new admin account");
    if (!data.fullName) throw httpError(400, "fullName is required for a new admin account");
    user = await User.create({
      fullName: data.fullName,
      email,
      passwordHash: await User.hashPassword(data.password),
      role: "admin",
      adminRole: data.adminRole,
      isEmailVerified: true,
      profileCompleted: true,
    });
    created = true;
    await audit(req, "admin.create", "User", user._id, { email, adminRole: data.adminRole });
  }
  res.status(created ? 201 : 200).json({ ok: true, created, admin: adminRow(user) });
});

/** Refuse a change that would leave no active super_admin. */
async function assertKeepsASuperAdmin(target, nextRole, nextActive) {
  const wasSuper = effectiveAdminRole(target) === "super_admin" && target.isActive;
  const staysSuper = nextRole === "super_admin" && nextActive;
  if (!wasSuper || staysSuper) return;
  const others = await User.countDocuments({
    _id: { $ne: target._id },
    role: "admin",
    isActive: true,
    $or: [{ adminRole: "super_admin" }, { adminRole: null }],
  });
  if (!others) throw httpError(400, "There must always be at least one active super admin");
}

/**
 * PATCH /api/admin/admins/:id — body: { adminRole?, isActive?, revoke? }
 * revoke: true removes admin access (back to a rider account).
 */
export const updateAdmin = asyncHandler(async (req, res) => {
  const data = z
    .object({ adminRole: z.enum(ADMIN_ROLES).optional(), isActive: z.boolean().optional(), revoke: z.boolean().optional() })
    .parse(req.body || {});
  const target = await User.findById(requireObjectId(req.params.id));
  if (!target || target.role !== "admin") throw httpError(404, "Admin not found");
  const self = String(target._id) === String(req.user._id);
  if (self && (data.revoke || data.isActive === false || (data.adminRole && data.adminRole !== "super_admin"))) {
    throw httpError(400, "You can't demote, disable or remove your own admin access");
  }
  const before = { adminRole: effectiveAdminRole(target), isActive: target.isActive };
  const nextRole = data.revoke ? null : data.adminRole ?? before.adminRole;
  const nextActive = data.revoke ? false : data.isActive ?? before.isActive;
  await assertKeepsASuperAdmin(target, nextRole, nextActive);

  if (data.revoke) {
    target.role = "rider";
    target.adminRole = null;
  } else {
    if (data.adminRole) target.adminRole = data.adminRole;
    if (data.isActive != null) {
      target.isActive = data.isActive;
      target.suspension = data.isActive ? null : { status: "deactivated", reason: "Admin access disabled", at: new Date(), by: req.user._id };
    }
  }
  await target.save();
  if (data.revoke || data.isActive === false) await User.updateOne({ _id: target._id }, { $set: { refreshTokens: [] } });
  await audit(req, data.revoke ? "admin.revoke" : "admin.update", "User", target._id, {
    email: target.email,
    from: before,
    to: data.revoke ? { role: "rider" } : { adminRole: effectiveAdminRole(target), isActive: target.isActive },
  });
  res.json({ ok: true, admin: data.revoke ? null : adminRow(target), revoked: Boolean(data.revoke) });
});

// ----------------------------------------------------------------------------- settings

/** GET /api/admin/settings — current values, env defaults and which keys an admin changed */
export const getSettingsHandler = asyncHandler(async (_req, res) => {
  const { Settings } = await import("../models/Settings.js");
  const doc = await Settings.findById("global").lean();
  res.json({
    ok: true,
    settings: getSettings(),
    defaults: defaultSettings(),
    overrides: doc?.overrides || {},
    updatedAt: doc?.updatedAt || null,
  });
});

/** PATCH /api/admin/settings — body: partial settings tree, or { reset: true } */
export const patchSettings = asyncHandler(async (req, res) => {
  const reset = req.body?.reset === true;
  const { settings, changes } = await updateSettings(reset ? {} : req.body, { actorId: req.user._id, reset });
  if (changes.length) await audit(req, reset ? "settings.reset" : "settings.update", "Settings", "global", { changes });
  res.json({ ok: true, settings, changes });
});

// ----------------------------------------------------------------------------- audit

/** GET /api/admin/audit?action=&actor=&targetType=&targetId=&from=&to=&page= */
export const listAudit = asyncHandler(async (req, res) => {
  const filter = { ...dateFilter("createdAt", parseDateRange(req)) };
  const action = String(req.query.action || "").trim();
  // "driver." matches every driver action; an exact name matches just that one
  if (action) filter.action = action.endsWith(".") ? new RegExp(`^${escapeRegex(action)}`) : action;
  if (req.query.targetType) filter.targetType = String(req.query.targetType);
  if (req.query.targetId) filter.targetId = String(req.query.targetId);
  const actor = String(req.query.actor || "").trim();
  if (actor) {
    if (isObjectId(actor)) filter.actorId = new mongoose.Types.ObjectId(actor);
    else filter.actorEmail = new RegExp(escapeRegex(actor), "i");
  }
  const paging = parsePaging(req, 50);
  const [total, rows, actions] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
    AuditLog.distinct("action"),
  ]);
  res.json({ ...paged(paging, total, "logs", rows.map((r) => r.toSafeJSON())), actions: actions.sort() });
});

// ----------------------------------------------------------------------------- health

/** GET /api/admin/health — latency percentiles, error rate, throughput, process, DB, sockets */
export const health = asyncHandler(async (_req, res) => {
  let db = { ok: false, pingMs: null, state: mongoose.connection.readyState };
  try {
    const t = process.hrtime.bigint();
    await mongoose.connection.db.admin().ping();
    db = { ok: true, pingMs: Math.round(Number(process.hrtime.bigint() - t) / 1e5) / 10, state: mongoose.connection.readyState };
  } catch (err) {
    db.error = err.message;
  }
  const mem = process.memoryUsage();
  const [users, trips, drivers] = await Promise.all([
    User.estimatedDocumentCount(),
    Trip.estimatedDocumentCount(),
    DriverProfile.estimatedDocumentCount(),
  ]);
  const metrics = metricsSnapshot();
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: env.nodeEnv,
    paymentsMode: env.stripeMock ? "mock" : "stripe",
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      pid: process.pid,
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
    },
    db,
    sockets: realtimeStats(),
    metrics,
    // Back-compat: overall p50 as "latency"
    latencyMs: metrics.overall.p50 ?? db.pingMs,
    counts: { users, trips, drivers },
  });
});
