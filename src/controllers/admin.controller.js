import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { Trip } from "../models/Trip.js";
import { Payment } from "../models/Payment.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";

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
      $or: [{ isApproved: true }, { verificationStatus: "approved" }],
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

/** GET /api/admin/users */
export const listUsers = asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q
    ? {
        $or: [
          { email: { $regex: q, $options: "i" } },
          { fullName: { $regex: q, $options: "i" } },
          { phone: { $regex: q, $options: "i" } },
        ],
      }
    : {};

  const users = await User.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .select("fullName email phone role isActive isEmailVerified profileCompleted createdAt lastLoginAt");

  res.json({
    ok: true,
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

/** GET /api/admin/drivers */
export const listDrivers = asyncHandler(async (_req, res) => {
  const profiles = await DriverProfile.find()
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  const userIds = profiles.map((p) => p.userId);
  const users = await User.find({ _id: { $in: userIds } })
    .select("fullName email phone role")
    .lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));

  res.json({
    ok: true,
    drivers: profiles.map((p) => {
      const u = byId.get(p.userId.toString());
      const status =
        p.verificationStatus === "approved" || p.isApproved
          ? "approved"
          : p.verificationStatus === "rejected"
            ? "rejected"
            : p.verificationStatus === "pending"
              ? "pending"
              : "pending";
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
  } else if (status === "rejected" || status === "suspended") {
    profile.verificationStatus = "rejected";
    profile.isApproved = false;
  } else {
    profile.verificationStatus = "pending";
    profile.isApproved = false;
  }
  // reason reserved for audit/email hooks later
  void reason;
  await profile.save();

  // Keep User.role in sync when approving
  if (status === "approved") {
    await User.findByIdAndUpdate(profile.userId, { role: "driver" });
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
      riderId: t.riderId?.toString() ?? null,
      driverId: t.driverId?.toString() ?? null,
      createdAt: t.createdAt,
    })),
  });
});
