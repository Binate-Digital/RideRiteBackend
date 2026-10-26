import { Trip } from "../models/Trip.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { findNearbyOnlineDrivers, etaMinutesForMiles } from "../utils/nearbyDrivers.js";
import { driverCardsFor } from "../utils/tripDrivers.js";
import { checkShareToken, pinId, snapToGrid, TRIP_ENDED } from "../utils/locationPrivacy.js";
import { isObjectId } from "../utils/adminQuery.js";

const TRACK_FIELDS =
  "status pickupAddress destinationAddress vehicleType fareCents requestedAt acceptedAt enRouteAt arrivedAt startedAt completedAt cancelledAt updatedAt riderId driverId pickupCoords destinationCoords";

/**
 * Live trip status for the map: trip, vehicle, driver card and the driver's live location —
 * the latter only while the trip is running (null once completed / cancelled).
 */
async function trackPayload(trip) {
  const ended = TRIP_ENDED.includes(trip.status);
  const base = {
    id: trip._id.toString(),
    status: trip.status,
    pickupAddress: trip.pickupAddress,
    destinationAddress: trip.destinationAddress,
    vehicleType: trip.vehicleType,
    fareCents: trip.fareCents,
    requestedAt: trip.requestedAt,
    acceptedAt: trip.acceptedAt,
    enRouteAt: trip.enRouteAt,
    arrivedAt: trip.arrivedAt,
    startedAt: trip.startedAt,
    completedAt: trip.completedAt,
    pickupCoords: trip.pickupCoords,
    destinationCoords: trip.destinationCoords,
    vehicle: null,
    driver: null,
    driverLocation: null,
    ended,
  };
  if (!trip.driverId) return base;
  const [profile, cards] = await Promise.all([
    DriverProfile.findOne({ userId: trip.driverId }).select("lastLocation vehicleMake vehicleModel vehiclePlate vehicleColor"),
    driverCardsFor([trip.driverId]),
  ]);
  return {
    ...base,
    vehicle: profile
      ? { make: profile.vehicleMake, model: profile.vehicleModel, plate: profile.vehiclePlate, color: profile.vehicleColor }
      : null,
    driver: cards.get(String(trip.driverId)) || null,
    driverLocation:
      !ended && profile?.lastLocation?.lat != null
        ? { lat: profile.lastLocation.lat, lng: profile.lastLocation.lng, updatedAt: profile.lastLocation.updatedAt }
        : null,
  };
}

/**
 * GET /api/public/trips/:id/track?token= — shared live trip status for someone outside the
 * app. Needs the share token the rider / driver created (POST /api/rides/:id/share); it expires
 * shortly after the trip ends, and the driver's location is never returned after the end.
 */
export const trackTrip = asyncHandler(async (req, res) => {
  const token = String(req.query.token || req.query.t || "");
  if (!token) throw httpError(401, "This tracking link is missing its access token", { code: "SHARE_TOKEN_REQUIRED" });
  const trip = isObjectId(req.params.id) ? await Trip.findById(req.params.id).select(`${TRACK_FIELDS} +shareTokens`) : null;
  // Same answer for an unknown trip and a wrong token (no trip id probing)
  const check = trip ? checkShareToken(trip, token) : "invalid";
  if (check === "invalid") throw httpError(404, "Tracking link not found", { code: "SHARE_TOKEN_INVALID" });
  if (check === "expired") throw httpError(410, "This tracking link has expired", { code: "SHARE_TOKEN_EXPIRED" });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, trip: await trackPayload(trip) });
});

/** GET /api/rides/:id/track — the same live view for the trip's rider, driver or an admin. */
export const trackMyTrip = asyncHandler(async (req, res) => {
  const trip = isObjectId(req.params.id) ? await Trip.findById(req.params.id).select(TRACK_FIELDS) : null;
  if (!trip) throw httpError(404, "Trip not found");
  const uid = String(req.user._id);
  const isParty = String(trip.riderId) === uid || (trip.driverId && String(trip.driverId) === uid) || req.user.role === "admin";
  if (!isParty) throw httpError(403, "Not authorized to view this trip");
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, trip: await trackPayload(trip) });
});

/** GET /api/public/nearby-tiers?lat=&lng=&radiusMiles= */
export const nearbyTiers = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusMiles = Math.min(150, Math.max(1, Number(req.query.radiusMiles) || 100));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw httpError(400, "lat and lng required");
  }

  const nearby = await findNearbyOnlineDrivers({ lat, lng, radiusMiles, limit: 500 });
  const tiers = { sedan: [], suv: [], truck: [] };
  for (const d of nearby) {
    if (tiers[d.vehicleType]) tiers[d.vehicleType].push(d.distanceMiles);
  }

  res.json({
    ok: true,
    radiusMiles,
    tiers: Object.entries(tiers).map(([vehicleType, distances]) => {
      // `nearby` is sorted nearest-first, so distances[0] is the closest driver. Public, so the
      // distance is coarse (half-mile steps) — counts and ETA only, never positions.
      const nearestMiles = distances.length ? Math.max(0.5, Math.round(distances[0] * 2) / 2) : null;
      return {
        vehicleType,
        available: distances.length > 0,
        availableDrivers: distances.length,
        nearestMiles,
        etaMinutes: nearestMiles == null ? null : etaMinutesForMiles(nearestMiles),
      };
    }),
  });
});

/**
 * GET /api/public/nearby-drivers?lat=&lng=&radiusMiles=100&vehicleType= — signed-in users only
 * (requireAuth + per-user rate limit in the route). Pins carry an opaque per-viewer id and
 * grid-snapped coordinates; no user / profile ids, names or plates.
 */
export const nearbyDrivers = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusMiles = Math.min(150, Math.max(1, Number(req.query.radiusMiles) || 100));
  const vehicleType = req.query.vehicleType
    ? String(req.query.vehicleType).toLowerCase()
    : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw httpError(400, "lat and lng required");
  }

  const nearby = await findNearbyOnlineDrivers({
    lat,
    lng,
    radiusMiles,
    vehicleType: vehicleType && ["sedan", "suv", "truck"].includes(vehicleType) ? vehicleType : null,
    limit: 80,
  });

  const viewer = String(req.user._id);
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    radiusMiles,
    count: nearby.length,
    gridMeters: env.nearbyGridMeters,
    drivers: nearby.map((d) => ({
      id: pinId(viewer, d.id),
      ...snapToGrid(d.lat, d.lng),
      vehicleType: d.vehicleType,
      vehicleLabel: d.vehicleLabel,
      distanceMiles: Math.round(d.distanceMiles * 10) / 10,
      etaMinutes: etaMinutesForMiles(d.distanceMiles),
    })),
  });
});

/** GET /api/public/reverse-geocode?lat=&lng= */
export const reverseGeocodePoint = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw httpError(400, "Valid lat and lng are required");
  }
  const { reverseGeocode } = await import("../utils/geocode.js");
  res.json({ ok: true, address: await reverseGeocode(lat, lng) });
});
