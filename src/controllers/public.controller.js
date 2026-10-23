import { Trip } from "../models/Trip.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { findNearbyOnlineDrivers, etaMinutesForMiles } from "../utils/nearbyDrivers.js";
import { driverCardsFor } from "../utils/tripDrivers.js";

/** GET /api/public/trips/:id/track — shareable live trip status (no auth) */
export const trackTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id).select(
    "status pickupAddress destinationAddress vehicleType fareCents requestedAt acceptedAt enRouteAt arrivedAt startedAt completedAt driverId pickupCoords destinationCoords",
  );
  if (!trip) throw httpError(404, "Trip not found");

  let driverLocation = null;
  if (trip.driverId) {
    const [profile, cards] = await Promise.all([
      DriverProfile.findOne({ userId: trip.driverId }).select(
        "lastLocation vehicleMake vehicleModel vehiclePlate vehicleColor",
      ),
      driverCardsFor([trip.driverId]),
    ]);
    if (profile?.lastLocation?.lat != null) {
      driverLocation = {
        lat: profile.lastLocation.lat,
        lng: profile.lastLocation.lng,
        updatedAt: profile.lastLocation.updatedAt,
      };
    }
    res.json({
      ok: true,
      trip: {
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
        vehicle: profile
          ? {
              make: profile.vehicleMake,
              model: profile.vehicleModel,
              plate: profile.vehiclePlate,
              color: profile.vehicleColor,
            }
          : null,
        driver: cards.get(String(trip.driverId)) || null,
        driverLocation,
      },
    });
    return;
  }

  res.json({
    ok: true,
    trip: {
      id: trip._id.toString(),
      status: trip.status,
      pickupAddress: trip.pickupAddress,
      destinationAddress: trip.destinationAddress,
      vehicleType: trip.vehicleType,
      fareCents: trip.fareCents,
      requestedAt: trip.requestedAt,
      pickupCoords: trip.pickupCoords,
      destinationCoords: trip.destinationCoords,
      vehicle: null,
      driver: null,
      driverLocation: null,
    },
  });
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
      // `nearby` is sorted nearest-first, so distances[0] is the closest driver
      const nearestMiles = distances.length ? Math.round(distances[0] * 10) / 10 : null;
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

/** GET /api/public/nearby-drivers?lat=&lng=&radiusMiles=100&vehicleType= */
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

  res.json({
    ok: true,
    radiusMiles,
    count: nearby.length,
    drivers: nearby.map((d) => ({
      id: d.id,
      lat: d.lat,
      lng: d.lng,
      vehicleType: d.vehicleType,
      vehicleLabel: d.vehicleLabel,
      distanceMiles: Math.round(d.distanceMiles * 10) / 10,
      etaMinutes: etaMinutesForMiles(d.distanceMiles),
      updatedAt: d.updatedAt,
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
