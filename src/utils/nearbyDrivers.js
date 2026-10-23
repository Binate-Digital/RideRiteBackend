import { DriverProfile } from "../models/DriverProfile.js";
import { DriverSubscription } from "../models/DriverSubscription.js";
import { Trip } from "../models/Trip.js";
import { notExpiredFilter } from "./driverDocuments.js";

/**
 * A driver's GPS counts as live for this long after the last ping.
 * The driver hub pings every ~12s while online (≈1/min when the tab is in the
 * background), so anything older means the driver closed the app without
 * going offline — they must not show on rider maps or receive requests.
 */
export const DRIVER_LOCATION_FRESH_MS = 5 * 60 * 1000;

/** Trip states where the driver is busy and can't take a new request. */
const BUSY_TRIP_STATUSES = ["accepted", "en_route", "arrived", "in_progress"];

export function haversineMiles(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Drivers who can take a ride right now, within radiusMiles of (lat, lng):
 * online, admin-approved, Stripe Connect ready, active subscription, no expired document,
 * a live GPS ping, and not already on a trip. Sorted nearest first.
 *
 * Drivers without a live location are excluded rather than shown at a
 * made-up spot — a pin on the rider map must be a real, bookable car.
 */
export async function findNearbyOnlineDrivers({
  lat,
  lng,
  radiusMiles = 100,
  vehicleType = null,
  limit = 100,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  // Bounding box first so the DB does the coarse cut; haversine trims the corners.
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const filter = {
    isOnline: true,
    isApproved: true,
    stripeConnectAccountId: { $ne: null },
    stripeConnectDetailsSubmitted: true,
    stripeConnectPayoutsEnabled: true,
    "lastLocation.updatedAt": { $gte: new Date(Date.now() - DRIVER_LOCATION_FRESH_MS) },
    "lastLocation.lat": { $gte: lat - dLat, $lte: lat + dLat },
    "lastLocation.lng": { $gte: lng - dLng, $lte: lng + dLng },
    // No expired license / registration / insurance
    ...notExpiredFilter(),
  };
  if (vehicleType) filter.vehicleType = vehicleType;

  const drivers = await DriverProfile.find(filter)
    .select("userId vehicleType vehicleMake vehicleModel vehicleColor lastLocation")
    .lean();
  if (drivers.length === 0) return [];

  const userIds = drivers.map((d) => d.userId);
  const [subscribed, busy] = await Promise.all([
    DriverSubscription.find({
      userId: { $in: userIds },
      status: "active",
      currentPeriodEnd: { $gt: new Date() },
    }).distinct("userId"),
    Trip.find({ driverId: { $in: userIds }, status: { $in: BUSY_TRIP_STATUSES } }).distinct(
      "driverId",
    ),
  ]);
  const subscribedSet = new Set(subscribed.map(String));
  const busySet = new Set(busy.map(String));

  const results = [];
  for (const d of drivers) {
    const uid = String(d.userId);
    if (!subscribedSet.has(uid) || busySet.has(uid)) continue;
    const distanceMiles = haversineMiles(
      { lat, lng },
      { lat: d.lastLocation.lat, lng: d.lastLocation.lng },
    );
    if (distanceMiles > radiusMiles) continue;
    results.push({
      id: String(d._id),
      userId: d.userId,
      vehicleType: d.vehicleType,
      vehicleLabel: [d.vehicleColor, d.vehicleMake, d.vehicleModel].filter(Boolean).join(" "),
      lat: d.lastLocation.lat,
      lng: d.lastLocation.lng,
      updatedAt: d.lastLocation.updatedAt ?? null,
      distanceMiles,
    });
  }

  return results.sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, limit);
}

/** Rough pickup ETA from straight-line distance (city driving ≈ 25 mph). */
export function etaMinutesForMiles(miles) {
  return Math.max(2, Math.round((miles / 25) * 60));
}
