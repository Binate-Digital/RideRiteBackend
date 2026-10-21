import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";

/** GET /api/notifications */
export const list = asyncHandler(async (req, res) => {
  const rows = await Notification.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(100);
  res.json({ ok: true, notifications: rows.map((r) => r.toSafeJSON()) });
});

/** POST /api/notifications/:id/read */
export const markRead = asyncHandler(async (req, res) => {
  const row = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { $set: { readAt: new Date() } },
    { new: true },
  );
  if (!row) throw httpError(404, "Notification not found");
  res.json({ ok: true, notification: row.toSafeJSON() });
});

/** POST /api/notifications/read-all */
export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany(
    { userId: req.user._id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  res.json({ ok: true });
});

/** GET/PATCH /api/notifications/prefs */
export const getPrefs = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("notificationPrefs");
  res.json({
    ok: true,
    prefs: user?.notificationPrefs || {
      ride: true,
      payment: true,
      rental: true,
      chauffeur: true,
      subscription: true,
      bonus: true,
      maintenance: true,
      payout: true,
      promo: false,
    },
  });
});

export const updatePrefs = asyncHandler(async (req, res) => {
  const allowed = [
    "ride",
    "payment",
    "rental",
    "chauffeur",
    "subscription",
    "bonus",
    "maintenance",
    "payout",
    "promo",
  ];
  const next = {};
  for (const key of allowed) {
    if (typeof req.body?.[key] === "boolean") next[`notificationPrefs.${key}`] = req.body[key];
  }
  const user = await User.findByIdAndUpdate(req.user._id, { $set: next }, { new: true }).select(
    "notificationPrefs",
  );
  res.json({ ok: true, prefs: user.notificationPrefs });
});

export async function notifyUser(userId, { category, title, body, data = {} }) {
  try {
    const user = await User.findById(userId).select("notificationPrefs");
    const prefs = user?.notificationPrefs || {};
    if (prefs[category] === false) return null;
    return Notification.create({ userId, category, title, body, data });
  } catch {
    return null;
  }
}

/** Ping online, approved drivers matching the trip vehicle (best-effort inbox alerts). */
export async function notifyEligibleDrivers(trip) {
  try {
    const { DriverProfile } = await import("../models/DriverProfile.js");
    const drivers = await DriverProfile.find({
      isOnline: true,
      isApproved: true,
      vehicleType: trip.vehicleType,
    })
      .select("userId")
      .limit(40)
      .lean();
    const fare = `$${((trip.fareCents || 0) / 100).toFixed(2)}`;
    await Promise.all(
      drivers.map((d) =>
        notifyUser(d.userId, {
          category: "ride",
          title: "New ride request nearby",
          body: `${trip.vehicleType.toUpperCase()} · ${fare} · ${trip.pickupAddress}`,
          data: { tripId: trip._id.toString(), href: "/driver" },
        }),
      ),
    );
  } catch {
    /* non-fatal */
  }
}
