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
import { AuditLog } from "../models/AuditLog.js";
import { PromoCode } from "../models/PromoCode.js";
import { z } from "zod";
import { DriverEarning } from "../models/DriverEarning.js";
import { DriverPayout } from "../models/DriverPayout.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { findTripPayment, refundPayment } from "../utils/refunds.js";
import { runPayouts } from "../utils/payouts.js";

async function audit(actorId, action, targetType, targetId, meta = {}) {
  try {
    await AuditLog.create({ actorId, action, targetType, targetId, meta });
  } catch {
    /* ignore */
  }
}

const ACTIVE_TRIP_STATUSES = ["requested", "accepted", "en_route", "arrived", "in_progress"];

/** GET /api/admin/analytics */
export const analytics = asyncHandler(async (_req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  const [
    totalTrips,
    completed,
    cancelled,
    active,
    trips7d,
    grossAgg,
    paidAgg,
    approvedDrivers,
    pendingDrivers,
    totalUsers,
    totalDrivers,
  ] = await Promise.all([
    Trip.countDocuments(),
    Trip.countDocuments({ status: "completed" }),
    Trip.countDocuments({ status: "cancelled" }),
    Trip.countDocuments({ status: { $in: ACTIVE_TRIP_STATUSES } }),
    Trip.countDocuments({ createdAt: { $gte: weekAgo } }),
    Trip.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, total: { $sum: "$fareCents" } } },
    ]),
    Payment.aggregate([
      { $match: { status: "succeeded", purpose: { $in: ["ride", "setup_card"] } } },
      { $group: { _id: null, total: { $sum: "$amountCents" } } },
    ]),
    DriverProfile.countDocuments({
      isApproved: true,
      verificationStatus: "approved",
    }),
    DriverProfile.countDocuments({
      verificationStatus: { $in: ["pending", "incomplete"] },
      isApproved: { $ne: true },
    }),
    User.countDocuments({ role: { $ne: "admin" } }),
    User.countDocuments({ role: "driver" }),
  ]);

  res.json({
    ok: true,
    totalTrips,
    completed,
    cancelled,
    active,
    trips7d,
    grossCents: grossAgg[0]?.total ?? 0,
    paidCents: paidAgg[0]?.total ?? 0,
    driverCounts: {
      approved: approvedDrivers,
      pending: pendingDrivers,
    },
    totalUsers,
    totalDrivers,
  });
});

function parsePaging(req, defaultLimit = 20) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function driverStatusOf(p) {
  if (p.verificationStatus === "approved" && p.isApproved) return "approved";
  if (p.verificationStatus === "rejected") return "rejected";
  return "pending";
}

/** GET /api/admin/users?q=&role=&page=&limit= */
export const listUsers = asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const role = String(req.query.role || "all").trim();
  const { page, limit, skip } = parsePaging(req);

  const filter = {
    role: { $ne: "admin" },
  };
  if (role === "rider" || role === "driver") {
    filter.role = role;
  }
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ email: rx }, { fullName: rx }, { phone: rx }];
  }

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("fullName email phone role isActive isEmailVerified profileCompleted createdAt lastLoginAt"),
  ]);

  res.json({
    ok: true,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    users: users.map((u) => ({
      id: u._id.toString(),
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      role: u.role,
      isActive: u.isActive,
      isEmailVerified: u.isEmailVerified,
      profileCompleted: u.profileCompleted,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    })),
  });
});

/** GET /api/admin/drivers?q=&status=&page=&limit= */
export const listDrivers = asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const statusFilter = String(req.query.status || "all").trim();
  const { page, limit, skip } = parsePaging(req);

  const profileFilter = {};
  if (statusFilter === "approved") {
    profileFilter.verificationStatus = "approved";
    profileFilter.isApproved = true;
  } else if (statusFilter === "rejected") {
    profileFilter.verificationStatus = "rejected";
  } else if (statusFilter === "pending") {
    profileFilter.$or = [
      { verificationStatus: { $in: ["pending", "incomplete"] } },
      { verificationStatus: "approved", isApproved: false },
    ];
  }

  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const matchedUsers = await User.find({
      $or: [{ email: rx }, { fullName: rx }, { phone: rx }],
    })
      .select("_id")
      .lean();
    const matchedIds = matchedUsers.map((u) => u._id);
    profileFilter.$and = [
      ...(profileFilter.$and || []),
      {
        $or: [
          { userId: { $in: matchedIds } },
          { vehiclePlate: rx },
          { vehicleMake: rx },
          { vehicleModel: rx },
        ],
      },
    ];
  }

  const [total, profiles] = await Promise.all([
    DriverProfile.countDocuments(profileFilter),
    DriverProfile.find(profileFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);

  const userIds = profiles.map((p) => p.userId);
  const users = await User.find({ _id: { $in: userIds } })
    .select("fullName email phone role")
    .lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));

  res.json({
    ok: true,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    drivers: profiles.map((p) => {
      const u = byId.get(p.userId.toString());
      const status = driverStatusOf(p);
      return {
        id: p._id.toString(),
        userId: p.userId.toString(),
        fullName: u?.fullName ?? null,
        email: u?.email ?? null,
        phone: u?.phone ?? null,
        vehicleType: p.vehicleType,
        vehicleMake: p.vehicleMake,
        vehicleModel: p.vehicleModel,
        vehicleYear: p.vehicleYear,
        vehiclePlate: p.vehiclePlate,
        verificationStatus: p.verificationStatus,
        isApproved: Boolean(p.isApproved),
        isOnline: Boolean(p.isOnline),
        status,
        createdAt: p.createdAt,
        verificationSubmittedAt: p.verificationSubmittedAt,
      };
    }),
  });
});

/** PATCH /api/admin/users/:id/role — body: { role } */
export const setUserRole = asyncHandler(async (req, res) => {
  const role = String(req.body?.role || "").trim();
  if (!["rider", "driver", "admin"].includes(role)) {
    throw httpError(400, "role must be rider, driver, or admin");
  }
  const user = await User.findById(req.params.id);
  if (!user) throw httpError(404, "User not found");
  if (user._id.toString() === req.user._id.toString() && role !== "admin") {
    throw httpError(400, "Cannot demote your own admin role");
  }
  user.role = role;
  await user.save();
  res.json({
    ok: true,
    user: {
      id: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
      role: user.role,
    },
  });
});

/** PATCH /api/admin/drivers/:userId/status — body: { status, reason? } */
export const setDriverStatus = asyncHandler(async (req, res) => {
  const status = String(req.body?.status || "").trim();
  const reason = req.body?.reason != null ? String(req.body.reason).trim() : null;
  if (!["pending", "approved", "rejected", "suspended"].includes(status)) {
    throw httpError(400, "Invalid driver status");
  }

  const profile = await DriverProfile.findOne({ userId: req.params.userId });
  if (!profile) throw httpError(404, "Driver profile not found");

  if (status === "approved") {
    profile.verificationStatus = "approved";
    profile.isApproved = true;
    profile.isOnline = false;
  } else if (status === "rejected" || status === "suspended") {
    profile.verificationStatus = "rejected";
    profile.isApproved = false;
    profile.isOnline = false;
  } else {
    profile.verificationStatus = "pending";
    profile.isApproved = false;
    profile.isOnline = false;
  }
  // reason reserved for audit/email hooks later
  void reason;
  await profile.save();

  if (status === "approved") {
    await User.findByIdAndUpdate(profile.userId, {
      role: "driver",
      isActive: true,
    });
  } else if (status === "rejected" || status === "suspended") {
    // Rejected drivers cannot log in
    await User.findByIdAndUpdate(profile.userId, { isActive: false });
  } else {
    await User.findByIdAndUpdate(profile.userId, { isActive: true });
  }

  res.json({
    ok: true,
    driver: {
      userId: profile.userId.toString(),
      verificationStatus: profile.verificationStatus,
      isApproved: profile.isApproved,
      status,
    },
  });
});

/** GET /api/admin/trips */
export const listTrips = asyncHandler(async (req, res) => {
  const status = String(req.query.status || "all");
  const filter =
    status === "all"
      ? {}
      : status === "active"
        ? { status: { $in: ACTIVE_TRIP_STATUSES } }
        : { status };

  const trips = await Trip.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  res.json({
    ok: true,
    trips: trips.map((t) => ({
      id: t._id.toString(),
      status: t.status,
      pickupAddress: t.pickupAddress,
      destinationAddress: t.destinationAddress,
      vehicleType: t.vehicleType,
      paymentMethod: t.paymentMethod,
      paid: Boolean(t.paid),
      fareCents: t.fareCents,
      cancelFeeCents: t.cancelFeeCents ?? 0,
      refundCents: t.refundCents ?? 0,
      riderId: t.riderId?.toString() ?? null,
      driverId: t.driverId?.toString() ?? null,
      createdAt: t.createdAt,
    })),
  });
});

/** GET /api/admin/subscriptions */
export const listSubscriptions = asyncHandler(async (_req, res) => {
  const rows = await DriverSubscription.find().sort({ updatedAt: -1 }).limit(200).lean();
  const userIds = rows.map((r) => r.userId);
  const users = await User.find({ _id: { $in: userIds } }).select("fullName email").lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  res.json({
    ok: true,
    subscriptions: rows.map((s) => ({
      id: s._id.toString(),
      userId: s.userId.toString(),
      fullName: byId.get(s.userId.toString())?.fullName ?? null,
      email: byId.get(s.userId.toString())?.email ?? null,
      plan: s.plan,
      status: s.status,
      amountCents: s.amountCents,
      currentPeriodEnd: s.currentPeriodEnd,
      active: s.status === "active" && s.currentPeriodEnd && new Date(s.currentPeriodEnd) > new Date(),
    })),
  });
});

/** GET /api/admin/rentals/listings */
export const listRentalListings = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.source) filter.source = req.query.source;
  const rows = await RentalListing.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({ ok: true, listings: rows.map((r) => r.toSafeJSON()) });
});

/** PATCH /api/admin/rentals/listings/:id — approve/pause fleet or peer listings */
export const updateRentalListing = asyncHandler(async (req, res) => {
  const row = await RentalListing.findById(req.params.id);
  if (!row) throw httpError(404, "Listing not found");
  if (req.body?.status) row.status = req.body.status;
  if (req.body?.dailyRateCents != null) row.dailyRateCents = Number(req.body.dailyRateCents);
  await row.save();
  await audit(req.user._id, "rental.listing.update", "RentalListing", row._id.toString(), {
    status: row.status,
  });
  res.json({ ok: true, listing: row.toSafeJSON() });
});

/** GET /api/admin/rentals/bookings */
export const listRentalBookings = asyncHandler(async (_req, res) => {
  const rows = await RentalBooking.find().sort({ createdAt: -1 }).limit(200);
  res.json({ ok: true, bookings: rows.map((r) => r.toSafeJSON()) });
});

/** GET /api/admin/chauffeur */
export const listChauffeur = asyncHandler(async (_req, res) => {
  const rows = await ChauffeurBooking.find().sort({ createdAt: -1 }).limit(200);
  res.json({ ok: true, bookings: rows.map((r) => r.toSafeJSON()) });
});

/** GET /api/admin/bonuses */
export const listBonuses = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const rows = await DriverBonus.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  const userIds = rows.map((r) => r.userId);
  const users = await User.find({ _id: { $in: userIds } }).select("fullName email").lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  res.json({
    ok: true,
    bonuses: rows.map((b) => ({
      ...b,
      id: b._id.toString(),
      userId: b.userId.toString(),
      fullName: byId.get(b.userId.toString())?.fullName ?? null,
      email: byId.get(b.userId.toString())?.email ?? null,
    })),
  });
});

/** PATCH /api/admin/bonuses/:id */
export const updateBonus = asyncHandler(async (req, res) => {
  const row = await DriverBonus.findById(req.params.id);
  if (!row) throw httpError(404, "Bonus not found");
  if (["approved", "rejected", "disbursed"].includes(req.body?.status)) {
    row.status = req.body.status;
    row.reviewedAt = new Date();
    if (req.body.status === "disbursed") row.disbursedAt = new Date();
  }
  if (req.body?.adminNotes != null) row.adminNotes = String(req.body.adminNotes);
  await row.save();
  await audit(req.user._id, "bonus.update", "DriverBonus", row._id.toString(), {
    status: row.status,
  });
  res.json({ ok: true, bonus: row.toSafeJSON() });
});

/** GET /api/admin/maintenance */
export const listMaintenance = asyncHandler(async (_req, res) => {
  const rows = await MaintenanceRecord.find().sort({ createdAt: -1 }).limit(200).lean();
  const userIds = rows.map((r) => r.userId);
  const users = await User.find({ _id: { $in: userIds } }).select("fullName email").lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  res.json({
    ok: true,
    records: rows.map((r) => ({
      id: r._id.toString(),
      userId: r.userId.toString(),
      fullName: byId.get(r.userId.toString())?.fullName ?? null,
      email: byId.get(r.userId.toString())?.email ?? null,
      type: r.type,
      title: r.title,
      status: r.status,
      coveredByPlatform: r.coveredByPlatform,
      dueAt: r.dueAt,
      completedAt: r.completedAt,
    })),
  });
});

/** PATCH /api/admin/maintenance/:id */
export const updateMaintenance = asyncHandler(async (req, res) => {
  const row = await MaintenanceRecord.findById(req.params.id);
  if (!row) throw httpError(404, "Record not found");
  if (req.body?.status) row.status = req.body.status;
  if (req.body?.status === "completed") row.completedAt = new Date();
  if (req.body?.notes != null) row.notes = String(req.body.notes);
  await row.save();
  res.json({ ok: true, record: row.toSafeJSON() });
});

/** GET /api/admin/revenue */
export const revenue = asyncHandler(async (_req, res) => {
  const [tripGross, paidOnline, cancelFees, subs, rentalCommission, chauffeurGross, ledger, refunds] =
    await Promise.all([
      Trip.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, total: { $sum: "$fareCents" } } },
      ]),
      Payment.aggregate([
        { $match: { status: "succeeded" } },
        { $group: { _id: null, total: { $sum: "$amountCents" } } },
      ]),
      Trip.aggregate([
        { $match: { status: "cancelled", cancelFeeCents: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$cancelFeeCents" } } },
      ]),
      DriverSubscription.aggregate([
        { $match: { status: "active" } },
        { $group: { _id: "$plan", count: { $sum: 1 }, amount: { $sum: "$amountCents" } } },
      ]),
      RentalBooking.aggregate([
        { $match: { paid: true } },
        { $group: { _id: null, commission: { $sum: "$commissionCents" }, volume: { $sum: "$totalCents" } } },
      ]),
      ChauffeurBooking.aggregate([
        { $match: { paid: true } },
        { $group: { _id: null, total: { $sum: "$totalCents" } } },
      ]),
      DriverEarning.aggregate([
        { $match: { status: { $ne: "void" } } },
        {
          $group: {
            _id: "$type",
            commission: { $sum: "$commissionCents" },
            net: { $sum: "$netCents" },
            paid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$netCents", 0] } },
          },
        },
      ]),
      Payment.aggregate([{ $group: { _id: null, total: { $sum: "$refundedCents" } } }]),
    ]);
  const ledgerBy = Object.fromEntries(ledger.map((l) => [l._id, l]));

  res.json({
    ok: true,
    tripGrossCents: tripGross[0]?.total ?? 0,
    paidOnlineCents: paidOnline[0]?.total ?? 0,
    cancelFeeCents: cancelFees[0]?.total ?? 0,
    subscriptions: subs,
    rentalCommissionCents: rentalCommission[0]?.commission ?? 0,
    rentalVolumeCents: rentalCommission[0]?.volume ?? 0,
    chauffeurGrossCents: chauffeurGross[0]?.total ?? 0,
    rideCommissionCents: ledgerBy.trip?.commission ?? 0,
    driverEarningsCents: ledger.reduce((a, l) => a + (l._id === "deduction" ? 0 : l.net), 0),
    driverPaidOutCents: ledger.reduce((a, l) => a + l.paid, 0),
    refundedCents: refunds[0]?.total ?? 0,
  });
});

/** GET /api/admin/cancellations */
export const listCancellations = asyncHandler(async (_req, res) => {
  const trips = await Trip.find({ status: "cancelled" })
    .sort({ cancelledAt: -1 })
    .limit(200)
    .lean();
  res.json({
    ok: true,
    cancellations: trips.map((t) => ({
      id: t._id.toString(),
      cancelFeeCents: t.cancelFeeCents ?? 0,
      refundCents: t.refundCents ?? 0,
      cancelReason: t.cancelReason,
      cancelledAt: t.cancelledAt,
      fareCents: t.fareCents,
      riderId: t.riderId?.toString() ?? null,
      driverId: t.driverId?.toString() ?? null,
    })),
  });
});

/**
 * PATCH /api/admin/trips/:id/refund — body: { refundCents, reason? }
 * Refunds through Stripe (simulated in mock mode), capped at what is still refundable on the
 * trip's card payment. Only trips paid online can be refunded. Audit-logged.
 */
export const refundTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  const requested = Math.round(Number(req.body?.refundCents) || 0);
  if (requested <= 0) throw httpError(400, "refundCents must be a positive amount");
  const payment = trip.paid ? await findTripPayment(trip._id) : null;
  if (!payment) throw httpError(400, "This trip has no online payment to refund (unpaid or paid in cash)");
  const remaining = payment.amountCents - (payment.refundedCents || 0);
  if (remaining <= 0) throw httpError(400, "This trip's payment is already fully refunded");

  const reason = String(req.body?.reason || "admin refund").slice(0, 200);
  const result = await refundPayment(payment, Math.min(requested, remaining), { reason });
  if (!result) throw httpError(400, "Nothing left to refund on this payment");
  const after = await Payment.findById(payment._id);
  trip.refundCents = after.refundedCents;
  trip.paymentStatus = after.refundedCents >= after.amountCents ? "refunded" : "partial_refund";
  await trip.save();
  await audit(req.user._id, "trip.refund", "Trip", trip._id.toString(), {
    requestedCents: requested,
    refundedCents: result.amountCents,
    totalRefundedCents: after.refundedCents,
    refundId: result.refundId,
    simulated: result.simulated,
    reason,
  });
  res.json({
    ok: true,
    refund: { ...result, capped: result.amountCents < requested },
    trip: trip.toSafeJSON(),
    payment: after.toSafeJSON(),
  });
});

/**
 * POST /api/admin/payouts/run — body: { driverId? }
 * Transfers every driver's pending earnings to their Stripe Connect account (simulated in
 * mock mode and for seeded acct_seedtest_* accounts).
 */
export const runDriverPayouts = asyncHandler(async (req, res) => {
  const driverId = req.body?.driverId ? String(req.body.driverId) : null;
  if (driverId && !/^[a-f0-9]{24}$/i.test(driverId)) throw httpError(400, "Invalid driverId");
  const results = await runPayouts({ driverId, initiatedBy: req.user._id });
  const paid = results.filter((r) => r.payout?.status === "paid");
  await audit(req.user._id, "payouts.run", "DriverPayout", driverId || "all", {
    drivers: results.length,
    paid: paid.length,
    totalCents: paid.reduce((a, r) => a + r.payout.amountCents, 0),
  });
  res.json({ ok: true, results });
});

/** GET /api/admin/payouts?driverId=&status= */
export const listPayouts = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.driverId && /^[a-f0-9]{24}$/i.test(String(req.query.driverId))) filter.driverId = req.query.driverId;
  if (["processing", "paid", "failed"].includes(String(req.query.status))) filter.status = req.query.status;
  const rows = await DriverPayout.find(filter).sort({ createdAt: -1 }).limit(200);
  const users = await User.find({ _id: { $in: rows.map((r) => r.driverId) } }).select("fullName email").lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  const pending = await DriverEarning.aggregate([
    { $match: { status: "pending" } },
    { $group: { _id: null, total: { $sum: "$netCents" }, drivers: { $addToSet: "$driverId" } } },
  ]);
  res.json({
    ok: true,
    pendingCents: pending[0]?.total ?? 0,
    pendingDrivers: pending[0]?.drivers?.length ?? 0,
    payouts: rows.map((p) => ({
      ...p.toSafeJSON(),
      fullName: byId.get(p.driverId.toString())?.fullName ?? null,
      email: byId.get(p.driverId.toString())?.email ?? null,
    })),
  });
});

/** GET /api/admin/export/users.csv */
export const exportUsersCsv = asyncHandler(async (_req, res) => {
  const users = await User.find({ role: { $ne: "admin" } })
    .sort({ createdAt: -1 })
    .limit(5000)
    .select("fullName email phone role isActive createdAt");
  const lines = ["id,fullName,email,phone,role,isActive,createdAt"];
  for (const u of users) {
    lines.push(
      [
        u._id.toString(),
        JSON.stringify(u.fullName || ""),
        u.email,
        JSON.stringify(u.phone || ""),
        u.role,
        u.isActive,
        u.createdAt?.toISOString?.() || "",
      ].join(","),
    );
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=users.csv");
  res.send(lines.join("\n"));
});

/** GET /api/admin/export/drivers.csv */
export const exportDriversCsv = asyncHandler(async (_req, res) => {
  const profiles = await DriverProfile.find().sort({ createdAt: -1 }).limit(5000).lean();
  const users = await User.find({ _id: { $in: profiles.map((p) => p.userId) } })
    .select("fullName email phone")
    .lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  const lines = [
    "userId,fullName,email,phone,vehicleType,plate,verificationStatus,isApproved,createdAt",
  ];
  for (const p of profiles) {
    const u = byId.get(p.userId.toString());
    lines.push(
      [
        p.userId.toString(),
        JSON.stringify(u?.fullName || ""),
        u?.email || "",
        JSON.stringify(u?.phone || ""),
        p.vehicleType,
        p.vehiclePlate || "",
        p.verificationStatus,
        p.isApproved,
        p.createdAt?.toISOString?.() || "",
      ].join(","),
    );
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=drivers.csv");
  res.send(lines.join("\n"));
});

/** GET /api/admin/health */
export const health = asyncHandler(async (_req, res) => {
  const started = Date.now();
  const [users, trips, drivers] = await Promise.all([
    User.countDocuments(),
    Trip.countDocuments(),
    DriverProfile.countDocuments(),
  ]);
  res.json({
    ok: true,
    latencyMs: Date.now() - started,
    counts: { users, trips, drivers },
    time: new Date().toISOString(),
  });
});

/** GET /api/admin/audit */
export const listAudit = asyncHandler(async (_req, res) => {
  const rows = await AuditLog.find().sort({ createdAt: -1 }).limit(200);
  res.json({ ok: true, logs: rows.map((r) => r.toSafeJSON()) });
});

/** PATCH /api/admin/users/:id/active — suspend/reactivate */
export const setUserActive = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw httpError(404, "User not found");
  if (user.role === "admin") throw httpError(400, "Cannot suspend admin");
  user.isActive = Boolean(req.body?.isActive);
  await user.save();
  await audit(req.user._id, "user.active", "User", user._id.toString(), {
    isActive: user.isActive,
  });
  res.json({
    ok: true,
    user: { id: user._id.toString(), isActive: user.isActive, email: user.email },
  });
});

const promoSchema = z
  .object({
    code: z.string().trim().min(2).max(40),
    percentOff: z.number().min(1).max(100).nullable().optional(),
    amountOffCents: z.number().int().min(1).nullable().optional(),
    active: z.boolean().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    maxUses: z.number().int().min(1).nullable().optional(),
  })
  .refine((d) => Boolean(d.percentOff) !== Boolean(d.amountOffCents), {
    message: "Set either percentOff or amountOffCents",
  });

/** GET /api/admin/promos */
export const listPromos = asyncHandler(async (_req, res) => {
  const rows = await PromoCode.find().sort({ createdAt: -1 }).limit(200);
  res.json({ ok: true, promos: rows.map((p) => p.toSafeJSON()) });
});

/** POST /api/admin/promos */
export const createPromo = asyncHandler(async (req, res) => {
  const data = promoSchema.parse(req.body || {});
  const code = data.code.toUpperCase();
  if (await PromoCode.exists({ code })) throw httpError(409, "Promo code already exists");
  const promo = await PromoCode.create({ ...data, code });
  await audit(req.user._id, "promo.create", "PromoCode", promo._id, { code });
  res.status(201).json({ ok: true, promo: promo.toSafeJSON() });
});

/** PATCH /api/admin/promos/:id — body: { active?, expiresAt?, maxUses? } */
export const updatePromo = asyncHandler(async (req, res) => {
  const data = z
    .object({
      active: z.boolean().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      maxUses: z.number().int().min(1).nullable().optional(),
    })
    .parse(req.body || {});
  const promo = await PromoCode.findByIdAndUpdate(req.params.id, data, { new: true });
  if (!promo) throw httpError(404, "Promo not found");
  await audit(req.user._id, "promo.update", "PromoCode", promo._id, data);
  res.json({ ok: true, promo: promo.toSafeJSON() });
});
