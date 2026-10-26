import crypto from "node:crypto";
import { DOCUMENT_UPLOAD_FIELDS, deleteDocument } from "../utils/privateDocuments.js";
import { documentUrlPayload } from "./driver.controller.js";
import { z } from "zod";
import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { Trip } from "../models/Trip.js";
import { Payment } from "../models/Payment.js";
import { DriverSubscription } from "../models/DriverSubscription.js";
import { RentalListing } from "../models/RentalListing.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { DriverBonus } from "../models/DriverBonus.js";
import { MaintenanceRecord } from "../models/MaintenanceRecord.js";
import { DriverEarning } from "../models/DriverEarning.js";
import { DriverPayout } from "../models/DriverPayout.js";
import { AuditLog } from "../models/AuditLog.js";
import { Dispute } from "../models/Dispute.js";
import { Notification } from "../models/Notification.js";
import { SavedAddress } from "../models/SavedAddress.js";
import { PushSubscription } from "../models/PushSubscription.js";
import { TripMessage } from "../models/TripMessage.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { audit } from "../utils/audit.js";
import {
  markUploadedDocumentsApproved,
  reviewDocument,
  reviewVehicleChange,
} from "../utils/driverCompliance.js";
import { documentsPayload } from "../utils/driverDocuments.js";
import { sendExport } from "../utils/export.js";
import { escapeRegex, paged, parsePaging, requireObjectId, userIdsMatching } from "../utils/adminQuery.js";
import { notifyUser } from "./notifications.controller.js";

/**
 * Admin: users & drivers (TRD 6.3) — search, detail, suspend / deactivate / reactivate, role
 * changes, driver approval with stored reasons, document and vehicle-change review, CSV / Excel
 * exports and GDPR export / erasure (TRD 6.9). Every write is audited (utils/audit.js).
 */

const ACTIVE_TRIP_STATUSES = ["pending_payment", "requested", "accepted", "en_route", "arrived", "in_progress"];

function userRow(u) {
  return {
    id: u._id.toString(),
    fullName: u.fullName,
    email: u.email ?? null,
    phone: u.phone ?? null,
    role: u.role,
    isActive: u.isActive,
    status: accountStatus(u),
    suspension: u.suspension
      ? { status: u.suspension.status, reason: u.suspension.reason || "", at: u.suspension.at }
      : null,
    isEmailVerified: Boolean(u.isEmailVerified),
    isPhoneVerified: Boolean(u.isPhoneVerified),
    profileCompleted: Boolean(u.profileCompleted),
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt ?? null,
  };
}

/** active | suspended | deactivated | deleted | inactive (e.g. a rejected driver) */
function accountStatus(u) {
  if (u.isActive) return "active";
  return u.suspension?.status || "inactive";
}

function userFilter(req) {
  const q = String(req.query.q || "").trim();
  const role = String(req.query.role || "all");
  const status = String(req.query.status || "all");
  const filter = { role: { $ne: "admin" } };
  if (role === "rider" || role === "driver") filter.role = role;
  if (status === "active") filter.isActive = true;
  else if (["suspended", "deactivated", "deleted"].includes(status)) filter["suspension.status"] = status;
  else if (status === "inactive") filter.isActive = false;
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ email: rx }, { fullName: rx }, { phone: rx }];
    if (/^[a-f0-9]{24}$/i.test(q)) filter.$or.push({ _id: q });
  }
  return filter;
}

/** GET /api/admin/users?q=&role=&status=&page=&limit= */
export const listUsers = asyncHandler(async (req, res) => {
  const filter = userFilter(req);
  const paging = parsePaging(req);
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
  ]);
  res.json({ ...paged(paging, total, "users", users.map(userRow)) });
});

/** GET /api/admin/users/:id — profile, activity, payments, bookings, prefs, status, audit */
export const getUser = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const user = await User.findById(id);
  if (!user || user.role === "admin") throw httpError(404, "User not found");
  const [profile, ridesAsRider, ridesAsDriver, payments, rentals, ownedListings, chauffeur, disputes, auditRows, subscription, ledger] =
    await Promise.all([
      DriverProfile.findOne({ userId: id }),
      Trip.find({ riderId: id }).sort({ createdAt: -1 }).limit(25),
      Trip.find({ driverId: id }).sort({ createdAt: -1 }).limit(25),
      Payment.find({ userId: id }).sort({ createdAt: -1 }).limit(25),
      RentalBooking.find({ $or: [{ renterId: id }, { ownerId: id }] }).sort({ createdAt: -1 }).limit(25),
      RentalListing.find({ ownerId: id }).sort({ createdAt: -1 }).limit(25),
      ChauffeurBooking.find({ $or: [{ riderId: id }, { driverId: id }] }).sort({ createdAt: -1 }).limit(25),
      Dispute.find({ $or: [{ riderId: id }, { driverId: id }] }).sort({ createdAt: -1 }).limit(25),
      AuditLog.find({ targetId: id.toString() }).sort({ createdAt: -1 }).limit(50),
      DriverSubscription.findOne({ userId: id }),
      DriverEarning.aggregate([{ $match: { driverId: id } }, { $group: { _id: "$status", total: { $sum: "$netCents" } } }]),
    ]);
  const [tripCount, tripsDriven] = await Promise.all([
    Trip.countDocuments({ riderId: id }),
    Trip.countDocuments({ driverId: id }),
  ]);
  const balance = Object.fromEntries(ledger.map((l) => [l._id, l.total]));
  res.json({
    ok: true,
    user: {
      ...userRow(user),
      avatarUrl: user.avatarUrl,
      anonymizedAt: user.anonymizedAt,
      notificationPrefs: user.notificationPrefs,
      notificationChannels: user.notificationChannels,
      stripeCustomerId: user.stripeCustomerId,
    },
    stats: { tripsTaken: tripCount, tripsDriven },
    driver: profile ? { ...profile.toSafeJSON(), status: driverStatusOf(profile, user) } : null,
    subscription: subscription ? subscription.toSafeJSON() : null,
    earnings: { pendingCents: balance.pending || 0, processingCents: balance.processing || 0, paidCents: balance.paid || 0 },
    trips: ridesAsRider.map((t) => t.toSafeJSON()),
    tripsDriven: ridesAsDriver.map((t) => t.toSafeJSON()),
    payments: payments.map((p) => p.toSafeJSON()),
    rentals: rentals.map((b) => b.toSafeJSON()),
    listings: ownedListings.map((l) => l.toSafeJSON()),
    chauffeur: chauffeur.map((b) => b.toSafeJSON()),
    disputes: disputes.map((d) => d.toSafeJSON()),
    audit: auditRows.map((a) => a.toSafeJSON()),
  });
});

const statusSchema = z.object({
  action: z.enum(["suspend", "deactivate", "reactivate"]),
  reason: z.string().trim().max(500).optional().default(""),
});

/** Shared by PATCH /users/:id/status and the driver "suspended" status. */
async function changeAccountStatus(req, user, action, reason) {
  if (user.role === "admin") throw httpError(400, "Manage admin accounts from the Admins page");
  if (user.anonymizedAt) throw httpError(400, "This account was deleted (GDPR) and can't be changed");
  if (action !== "reactivate" && reason.length < 3) throw httpError(400, "Give a reason (at least 3 characters)");
  const before = accountStatus(user);
  if (action === "reactivate") {
    user.isActive = true;
    user.suspension = null;
  } else {
    user.isActive = false;
    user.suspension = { status: action === "suspend" ? "suspended" : "deactivated", reason, at: new Date(), by: req.user._id };
    // Sign them out everywhere and take a driver off the map
    await User.updateOne({ _id: user._id }, { $set: { refreshTokens: [] } });
    await DriverProfile.updateOne({ userId: user._id }, { $set: { isOnline: false } });
  }
  await user.save();
  await audit(req, `user.${action}`, "User", user._id, { from: before, to: accountStatus(user), reason });
  const copy = {
    suspend: ["Your RideRite account is suspended", `Your account has been suspended${reason ? `: ${reason}` : ""}. Contact support if you think this is a mistake.`],
    deactivate: ["Your RideRite account was deactivated", `Your account has been deactivated${reason ? `: ${reason}` : ""}.`],
    reactivate: ["Your RideRite account is active again", "Welcome back — you can sign in and use RideRite again."],
  }[action];
  await notifyUser(user._id, { category: "system", title: copy[0], body: copy[1], data: { href: "/dashboard" }, email: true });
  return user;
}

/** PATCH /api/admin/users/:id/status — body: { action: suspend|deactivate|reactivate, reason } */
export const setUserStatus = asyncHandler(async (req, res) => {
  const { action, reason } = statusSchema.parse(req.body || {});
  const user = await User.findById(requireObjectId(req.params.id));
  if (!user) throw httpError(404, "User not found");
  await changeAccountStatus(req, user, action, reason);
  res.json({ ok: true, user: userRow(user) });
});

/** PATCH /api/admin/users/:id/active — legacy toggle: { isActive, reason? } */
export const setUserActive = asyncHandler(async (req, res) => {
  const user = await User.findById(requireObjectId(req.params.id));
  if (!user) throw httpError(404, "User not found");
  const reason = String(req.body?.reason || "Suspended by admin").trim();
  await changeAccountStatus(req, user, req.body?.isActive ? "reactivate" : "suspend", reason);
  res.json({ ok: true, user: { id: user._id.toString(), isActive: user.isActive, email: user.email } });
});

/**
 * PATCH /api/admin/users/:id/role — body: { role: rider|driver }. Making someone a driver gives
 * them an (incomplete) driver profile: they still go through KYC before they can drive.
 * Admin accounts are managed from /api/admin/admins.
 */
export const setUserRole = asyncHandler(async (req, res) => {
  const role = String(req.body?.role || "").trim();
  if (!["rider", "driver"].includes(role)) throw httpError(400, "role must be rider or driver (admins are managed from the Admins page)");
  const user = await User.findById(requireObjectId(req.params.id));
  if (!user) throw httpError(404, "User not found");
  if (user.role === "admin") throw httpError(400, "Manage admin accounts from the Admins page");
  const from = user.role;
  if (from === role) return res.json({ ok: true, user: userRow(user) });
  let createdProfile = false;
  if (role === "driver" && !(await DriverProfile.exists({ userId: user._id }))) {
    await DriverProfile.create({ userId: user._id, isApproved: false, verificationStatus: "incomplete" });
    createdProfile = true;
  }
  if (role === "rider") await DriverProfile.updateOne({ userId: user._id }, { $set: { isOnline: false } });
  user.role = role;
  await user.save();
  await audit(req, "user.role", "User", user._id, { from, to: role, createdDriverProfile: createdProfile });
  res.json({ ok: true, user: userRow(user), createdDriverProfile: createdProfile });
});

// ----------------------------------------------------------------------------- drivers

function driverStatusOf(p, user) {
  if (user && !user.isActive && user.suspension?.status) return user.suspension.status;
  if (p.verificationStatus === "approved" && p.isApproved) return "approved";
  if (p.verificationStatus === "rejected") return "rejected";
  if (p.verificationStatus === "incomplete") return "incomplete";
  return "pending";
}

async function driverFilter(req) {
  const q = String(req.query.q || "").trim();
  const status = String(req.query.status || "all");
  const filter = {};
  const and = [];
  if (status === "approved") Object.assign(filter, { verificationStatus: "approved", isApproved: true });
  else if (status === "rejected") filter.verificationStatus = "rejected";
  else if (status === "incomplete") filter.verificationStatus = "incomplete";
  // KYC queue: submitted applications only (not profiles still being filled in)
  else if (status === "pending") and.push({ $or: [{ verificationStatus: "pending" }, { verificationStatus: "approved", isApproved: false }] });
  else if (status === "documents") {
    and.push({ $or: ["license", "registration", "insurance"].map((d) => ({ [`documentReview.${d}.status`]: "pending" })) });
  } else if (status === "vehicle_change") filter.pendingVehicleChange = { $ne: null };
  else if (status === "suspended") {
    const ids = await User.find({ role: "driver", "suspension.status": { $in: ["suspended", "deactivated"] } }).select("_id").lean();
    filter.userId = { $in: ids.map((u) => u._id) };
  }
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    and.push({
      $or: [{ userId: { $in: await userIdsMatching(q) } }, { vehiclePlate: rx }, { vehicleMake: rx }, { vehicleModel: rx }],
    });
  }
  if (and.length) filter.$and = and;
  return filter;
}

function driverRow(p, u) {
  const documents = documentsPayload(p);
  return {
    id: p._id.toString(),
    userId: p.userId.toString(),
    fullName: u?.fullName ?? null,
    email: u?.email ?? null,
    phone: u?.phone ?? null,
    isActive: u?.isActive ?? null,
    vehicleType: p.vehicleType,
    vehicleMake: p.vehicleMake,
    vehicleModel: p.vehicleModel,
    vehicleYear: p.vehicleYear,
    vehiclePlate: p.vehiclePlate,
    verificationStatus: p.verificationStatus,
    isApproved: Boolean(p.isApproved),
    isOnline: Boolean(p.isOnline),
    status: driverStatusOf(p, u),
    reviewDecision: p.reviewDecision ? { status: p.reviewDecision.status, reason: p.reviewDecision.reason || "", at: p.reviewDecision.at } : null,
    createdAt: p.createdAt,
    verificationSubmittedAt: p.verificationSubmittedAt,
    documents,
    documentsPending: Object.values(documents).filter((d) => d.status === "pending").length,
    pendingVehicleChange: p.pendingVehicleChange || null,
  };
}

/** GET /api/admin/drivers?q=&status=all|pending|incomplete|approved|rejected|suspended|documents|vehicle_change */
export const listDrivers = asyncHandler(async (req, res) => {
  const filter = await driverFilter(req);
  const paging = parsePaging(req);
  const [total, profiles] = await Promise.all([
    DriverProfile.countDocuments(filter),
    DriverProfile.find(filter).sort({ verificationSubmittedAt: -1, createdAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
  ]);
  const users = await User.find({ _id: { $in: profiles.map((p) => p.userId) } }).select("fullName email phone isActive suspension").lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  res.json(paged(paging, total, "drivers", profiles.map((p) => driverRow(p, byId.get(p.userId.toString())))));
});

/** GET /api/admin/drivers/:userId — profile, documents, vehicle change, membership, earnings, bonuses, maintenance */
/** GET /api/admin/drivers/:userId/documents/:field/url — short-lived link to view a document */
export const getDriverDocumentUrl = asyncHandler(async (req, res) => {
  const userId = requireObjectId(req.params.userId);
  const profile = await DriverProfile.findOne({ userId });
  if (!profile) throw httpError(404, "Driver not found");
  const payload = await documentUrlPayload(profile, req.params.field, req);
  await audit(req, "driver.document.view", "DriverProfile", profile._id, { userId: userId.toString(), field: payload.field });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ...payload });
});

export const getDriver = asyncHandler(async (req, res) => {
  const userId = requireObjectId(req.params.userId);
  const [user, profile] = await Promise.all([User.findById(userId), DriverProfile.findOne({ userId })]);
  if (!user || !profile) throw httpError(404, "Driver not found");
  const [subscription, trips, bonuses, maintenance, ledger, payouts, auditRows] = await Promise.all([
    DriverSubscription.findOne({ userId }),
    Trip.find({ driverId: userId }).sort({ createdAt: -1 }).limit(20),
    DriverBonus.find({ userId }).sort({ monthKey: -1 }).limit(12),
    MaintenanceRecord.find({ userId }).sort({ createdAt: -1 }).limit(20),
    DriverEarning.aggregate([{ $match: { driverId: userId } }, { $group: { _id: "$status", total: { $sum: "$netCents" } } }]),
    DriverPayout.find({ driverId: userId }).sort({ createdAt: -1 }).limit(10),
    AuditLog.find({ targetId: { $in: [userId.toString(), profile._id.toString()] } }).sort({ createdAt: -1 }).limit(50),
  ]);
  const balance = Object.fromEntries(ledger.map((l) => [l._id, l.total]));
  res.json({
    ok: true,
    driver: {
      ...profile.toSafeJSON(),
      ...driverRow(profile.toObject(), user),
      user: userRow(user),
    },
    subscription: subscription ? subscription.toSafeJSON() : null,
    earnings: { pendingCents: balance.pending || 0, processingCents: balance.processing || 0, paidCents: balance.paid || 0 },
    trips: trips.map((t) => t.toSafeJSON()),
    bonuses: bonuses.map((b) => b.toSafeJSON()),
    maintenance: maintenance.map((m) => m.toSafeJSON()),
    payouts: payouts.map((p) => p.toSafeJSON()),
    audit: auditRows.map((a) => a.toSafeJSON()),
  });
});

/**
 * PATCH /api/admin/drivers/:userId/status — body: { status: approved|rejected|pending|suspended, reason }
 * Rejection needs a reason; it is stored on the profile and sent to the driver. "suspended"
 * suspends the account (same as the users page).
 */
export const setDriverStatus = asyncHandler(async (req, res) => {
  const status = String(req.body?.status || "").trim();
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
  if (!["pending", "approved", "rejected", "suspended"].includes(status)) throw httpError(400, "Invalid driver status");
  const userId = requireObjectId(req.params.userId);
  const profile = await DriverProfile.findOne({ userId });
  if (!profile) throw httpError(404, "Driver profile not found");
  const user = await User.findById(userId);
  if (!user) throw httpError(404, "User not found");

  if (status === "suspended") {
    await changeAccountStatus(req, user, "suspend", reason || "Driver account suspended");
    return res.json({ ok: true, driver: driverRow(profile.toObject(), user) });
  }
  if (status === "rejected" && reason.length < 5) throw httpError(400, "Give the driver a rejection reason (at least 5 characters)");

  const from = driverStatusOf(profile, user);
  profile.isOnline = false;
  if (status === "approved") {
    profile.verificationStatus = "approved";
    profile.isApproved = true;
    markUploadedDocumentsApproved(profile);
  } else {
    profile.verificationStatus = status;
    profile.isApproved = false;
  }
  profile.reviewDecision = { status, reason, at: new Date(), by: req.user._id };
  await profile.save();

  if (status === "approved") {
    user.role = "driver";
    user.isActive = true;
    user.suspension = null;
  } else if (status === "rejected") {
    // Rejected drivers cannot log in (existing policy); the reason goes out by email first
    user.isActive = false;
  } else {
    user.isActive = true;
  }
  await user.save();
  await audit(req, `driver.${status}`, "User", user._id, { from, to: status, reason });
  if (status !== "pending") {
    await notifyUser(user._id, {
      category: "system",
      title: status === "approved" ? "You're approved to drive" : "Your driver application wasn't approved",
      body:
        status === "approved"
          ? "Your documents were verified. Go online from the driver hub to start taking rides."
          : `Reason: ${reason}`,
      data: { href: "/driver" },
      email: true,
    });
  }
  res.json({ ok: true, driver: driverRow(profile.toObject(), user) });
});

/** PATCH /api/admin/drivers/:userId/documents/:doc — body: { status: approved|rejected, note? } */
export const reviewDriverDocument = asyncHandler(async (req, res) => {
  const note = String(req.body?.note || "").trim().slice(0, 500);
  const status = String(req.body?.status || "");
  if (status === "rejected" && note.length < 3) throw httpError(400, "Say what's wrong with the document (note)");
  const profile = await reviewDocument(String(requireObjectId(req.params.userId, "userId")), req.params.doc, { status, note });
  await audit(req, `driver.document.${status}`, "User", profile.userId, { doc: req.params.doc, note });
  res.json({ ok: true, documents: documentsPayload(profile) });
});

/** PATCH /api/admin/drivers/:userId/vehicle-change — body: { action: approve|reject, note? } */
export const reviewDriverVehicleChange = asyncHandler(async (req, res) => {
  const action = String(req.body?.action || "");
  if (!["approve", "reject"].includes(action)) throw httpError(400, "action must be approve or reject");
  const note = String(req.body?.note || "").trim().slice(0, 500);
  const profile = await reviewVehicleChange(String(requireObjectId(req.params.userId, "userId")), { approve: action === "approve", note });
  await audit(req, `driver.vehicle_change.${action}`, "User", profile.userId, {
    change: profile.lastVehicleChangeReview?.change || null,
    note,
  });
  res.json({ ok: true, driver: profile.toSafeJSON() });
});

// ----------------------------------------------------------------------------- exports

const USER_COLUMNS = [
  { key: "id", label: "ID", width: 26 },
  { key: "fullName", label: "Full name", width: 24 },
  { key: "email", label: "Email", width: 30 },
  { key: "phone", label: "Phone", width: 16 },
  { key: "role", label: "Role" },
  { key: "status", label: "Status" },
  { key: "suspensionReason", label: "Suspension reason", width: 30 },
  { key: "emailVerified", label: "Email verified" },
  { key: "createdAt", label: "Created", width: 22 },
  { key: "lastLoginAt", label: "Last login", width: 22 },
];

const DRIVER_COLUMNS = [
  { key: "userId", label: "User ID", width: 26 },
  { key: "fullName", label: "Full name", width: 24 },
  { key: "email", label: "Email", width: 30 },
  { key: "phone", label: "Phone", width: 16 },
  { key: "status", label: "Status" },
  { key: "vehicleType", label: "Vehicle type" },
  { key: "vehicle", label: "Vehicle", width: 26 },
  { key: "plate", label: "Plate" },
  { key: "documentsPending", label: "Docs pending" },
  { key: "reviewReason", label: "Review reason", width: 30 },
  { key: "isOnline", label: "Online" },
  { key: "submittedAt", label: "Submitted", width: 22 },
  { key: "createdAt", label: "Created", width: 22 },
];

const exportFormat = (req) => (String(req.params.format || req.query.format || "csv") === "xlsx" ? "xlsx" : "csv");

/** GET /api/admin/export/users.(csv|xlsx) — same filters as the users list */
export const exportUsers = asyncHandler(async (req, res) => {
  const users = await User.find(userFilter(req)).sort({ createdAt: -1 }).limit(20000).lean();
  const rows = users.map((u) => ({
    id: u._id.toString(),
    fullName: u.fullName,
    email: u.email ?? "",
    phone: u.phone ?? "",
    role: u.role,
    status: accountStatus(u),
    suspensionReason: u.suspension?.reason || "",
    emailVerified: Boolean(u.isEmailVerified),
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || "",
  }));
  const format = exportFormat(req);
  await audit(req, "export.users", "User", "", { format, rows: rows.length, filters: req.query });
  await sendExport(res, { format, name: "users", columns: USER_COLUMNS, rows });
});

/** GET /api/admin/export/drivers.(csv|xlsx) — same filters as the drivers list */
export const exportDrivers = asyncHandler(async (req, res) => {
  const profiles = await DriverProfile.find(await driverFilter(req)).sort({ createdAt: -1 }).limit(20000).lean();
  const users = await User.find({ _id: { $in: profiles.map((p) => p.userId) } }).select("fullName email phone isActive suspension").lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  const rows = profiles.map((p) => {
    const d = driverRow(p, byId.get(p.userId.toString()));
    return {
      userId: d.userId,
      fullName: d.fullName ?? "",
      email: d.email ?? "",
      phone: d.phone ?? "",
      status: d.status,
      vehicleType: d.vehicleType,
      vehicle: [d.vehicleYear, d.vehicleMake, d.vehicleModel].filter(Boolean).join(" "),
      plate: d.vehiclePlate || "",
      documentsPending: d.documentsPending,
      reviewReason: d.reviewDecision?.reason || "",
      isOnline: d.isOnline,
      submittedAt: d.verificationSubmittedAt || "",
      createdAt: d.createdAt,
    };
  });
  const format = exportFormat(req);
  await audit(req, "export.drivers", "DriverProfile", "", { format, rows: rows.length, filters: req.query });
  await sendExport(res, { format, name: "drivers", columns: DRIVER_COLUMNS, rows });
});

// ----------------------------------------------------------------------------- GDPR

/** GET /api/admin/users/:id/gdpr-export — everything stored about a user, as a JSON download */
export const gdprExport = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const user = await User.findById(id);
  if (!user) throw httpError(404, "User not found");
  const [
    driverProfile,
    subscription,
    tripsAsRider,
    tripsAsDriver,
    payments,
    rentalBookings,
    listings,
    chauffeur,
    notifications,
    addresses,
    earnings,
    payouts,
    bonuses,
    maintenance,
    disputes,
    messages,
  ] = await Promise.all([
    DriverProfile.findOne({ userId: id }),
    DriverSubscription.findOne({ userId: id }),
    Trip.find({ riderId: id }).sort({ createdAt: -1 }),
    Trip.find({ driverId: id }).sort({ createdAt: -1 }),
    Payment.find({ userId: id }).sort({ createdAt: -1 }),
    RentalBooking.find({ $or: [{ renterId: id }, { ownerId: id }] }),
    RentalListing.find({ ownerId: id }),
    ChauffeurBooking.find({ $or: [{ riderId: id }, { driverId: id }] }),
    Notification.find({ userId: id }).sort({ createdAt: -1 }),
    SavedAddress.find({ userId: id }),
    DriverEarning.find({ driverId: id }).lean(),
    DriverPayout.find({ driverId: id }),
    DriverBonus.find({ userId: id }),
    MaintenanceRecord.find({ userId: id }),
    Dispute.find({ $or: [{ riderId: id }, { driverId: id }] }),
    TripMessage.find({ senderId: id }),
  ]);
  const json = (rows) => rows.map((r) => (typeof r.toSafeJSON === "function" ? r.toSafeJSON() : r));
  const data = {
    exportedAt: new Date(),
    format: "riderite-gdpr-export/1",
    user: {
      ...user.toSafeJSON(),
      suspension: user.suspension || null,
      anonymizedAt: user.anonymizedAt,
      notificationPrefs: user.notificationPrefs,
      notificationChannels: user.notificationChannels,
    },
    driverProfile: driverProfile ? driverProfile.toSafeJSON() : null,
    subscription: subscription ? subscription.toSafeJSON() : null,
    trips: { asRider: json(tripsAsRider), asDriver: json(tripsAsDriver) },
    payments: json(payments),
    rentals: { bookings: json(rentalBookings), listings: json(listings) },
    chauffeurBookings: json(chauffeur),
    notifications: json(notifications),
    savedAddresses: json(addresses),
    earnings: earnings.map((e) => ({ ...e, _id: String(e._id) })),
    payouts: json(payouts),
    bonuses: json(bonuses),
    maintenance: json(maintenance),
    disputes: json(disputes),
    chatMessages: json(messages),
  };
  await audit(req, "user.gdpr_export", "User", id, { email: user.email });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="riderite-user-${id}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

/** Why an account can't be erased yet (active trips, bookings or unsettled money), or []. */
async function erasureBlockers(id) {
  const now = new Date();
  const [activeTrips, activeRentals, activeChauffeur, unsettled, pendingRefunds] = await Promise.all([
    Trip.countDocuments({ $or: [{ riderId: id }, { driverId: id }], status: { $in: ACTIVE_TRIP_STATUSES } }),
    RentalBooking.countDocuments({
      $and: [
        { $or: [{ renterId: id }, { ownerId: id }] },
        {
          $or: [
            { status: { $in: ["pending_payment", "confirmed", "active"] }, endDate: { $gt: now } },
            { status: "active" },
            { paymentStatus: "refunding" },
          ],
        },
      ],
    }),
    ChauffeurBooking.countDocuments({
      $or: [{ riderId: id }, { driverId: id }],
      status: { $in: ["pending_payment", "requested", "confirmed", "driver_assigned", "in_progress"] },
    }),
    DriverEarning.aggregate([
      { $match: { driverId: id, status: { $in: ["pending", "processing"] } } },
      { $group: { _id: null, total: { $sum: "$netCents" }, n: { $sum: 1 } } },
    ]),
    Trip.countDocuments({ riderId: id, paymentStatus: { $in: ["refund_pending", "refunding"] } }),
  ]);
  const blockers = [];
  if (activeTrips) blockers.push(`${activeTrips} active trip(s)`);
  if (activeRentals) blockers.push(`${activeRentals} upcoming or active rental booking(s)`);
  if (activeChauffeur) blockers.push(`${activeChauffeur} open chauffeur booking(s)`);
  if (unsettled[0]?.n && unsettled[0].total !== 0) {
    blockers.push(`unsettled driver balance of $${(unsettled[0].total / 100).toFixed(2)} — run a payout first`);
  }
  if (pendingRefunds) blockers.push(`${pendingRefunds} refund(s) still being processed`);
  return blockers;
}

/**
 * DELETE /api/admin/users/:id — GDPR erasure. Personal data is removed or overwritten; trips,
 * payments and ledger entries stay (accounting) but only reference the anonymous id. Blocked
 * while the user has active trips / bookings or money still to settle.
 */
export const gdprDelete = asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id);
  const user = await User.findById(id);
  if (!user) throw httpError(404, "User not found");
  if (user.role === "admin") throw httpError(400, "Remove admin access before deleting an admin account");
  if (user.anonymizedAt) throw httpError(409, "This account was already deleted");
  const blockers = await erasureBlockers(id);
  if (blockers.length) {
    throw httpError(409, `Can't delete this account yet: ${blockers.join("; ")}`, { code: "ERASURE_BLOCKED", blockers });
  }
  const reason = String(req.body?.reason || "GDPR erasure request").trim().slice(0, 300);
  const originalEmail = user.email;
  const now = new Date();
  // Private document files go too (S3 objects / local files; legacy external URLs can't be deleted)
  const docProfile = await DriverProfile.findOne({ userId: id });
  if (docProfile) {
    for (const field of Object.values(DOCUMENT_UPLOAD_FIELDS)) {
      if (docProfile[field]) await deleteDocument(docProfile[field]);
    }
  }

  await User.updateOne(
    { _id: id },
    {
      $set: {
        fullName: "Deleted user",
        phone: null,
        avatarUrl: null,
        passwordHash: null,
        isActive: false,
        isEmailVerified: false,
        isPhoneVerified: false,
        refreshTokens: [],
        stripeCustomerId: null,
        defaultPaymentMethodId: null,
        anonymizedAt: now,
        suspension: { status: "deleted", reason, at: now, by: req.user._id },
        "notificationPrefs.promo": false,
      },
      $unset: { email: "", phoneE164: "", googleId: "", appleId: "" },
    },
  );
  await DriverProfile.updateOne(
    { userId: id },
    {
      $set: {
        isOnline: false,
        isApproved: false,
        vehiclePlate: "",
        vehicleVin: "",
        dateOfBirth: null,
        addressLine1: "",
        city: "",
        zip: "",
        dlNumber: "",
        dlExpiresOn: null,
        licenseFrontUrl: null,
        licenseBackUrl: null,
        insurancePolicyNumber: "",
        insuranceDocUrl: null,
        registrationDocUrl: null,
        homeLocation: { lat: null, lng: null, updatedAt: null },
        lastLocation: { lat: null, lng: null, updatedAt: null },
        pendingVehicleChange: null,
      },
    },
  );
  await Promise.all([
    SavedAddress.deleteMany({ userId: id }),
    PushSubscription.deleteMany({ userId: id }),
    Notification.deleteMany({ userId: id }),
    TripMessage.updateMany({ senderId: id }, { $set: { body: "[deleted]" } }),
    Trip.updateMany({ riderId: id }, { $set: { riderReview: null } }),
    RentalListing.updateMany({ ownerId: id, status: { $ne: "rejected" } }, { $set: { status: "paused" } }),
    Dispute.updateMany({ riderId: id }, { $set: { description: "[deleted]" } }),
  ]);
  await audit(req, "user.gdpr_delete", "User", id, { reason, emailHash: originalEmail ? hashEmail(originalEmail) : null });
  res.json({ ok: true, deleted: true, userId: id.toString() });
});

function hashEmail(email) {
  // Keep a non-reversible fingerprint so a later "was X deleted?" question can be answered
  return `sha256:${crypto.createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 16)}`;
}

