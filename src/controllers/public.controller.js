import { Trip } from "../models/Trip.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { findNearbyOnlineDrivers } from "../utils/nearbyDrivers.js";

/** GET /api/public/trips/:id/track — shareable live trip status (no auth) */
export const trackTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id).select(
    "status pickupAddress destinationAddress vehicleType fareCents requestedAt acceptedAt enRouteAt arrivedAt startedAt completedAt driverId pickupCoords destinationCoords",
  );
  if (!trip) throw httpError(404, "Trip not found");

  let driverLocation = null;
  if (trip.driverId) {
    const profile = await DriverProfile.findOne({ userId: trip.driverId }).select("lastLocation vehicleMake vehicleModel vehiclePlate vehicleColor");
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
      driverLocation: null,
    },
  });
});

/** GET /api/public/nearby-tiers?lat=&lng=&radiusMiles= */
export const nearbyTiers = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusMiles = Math.min(50, Math.max(1, Number(req.query.radiusMiles) || 10));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw httpError(400, "lat and lng required");
  }

  const nearby = await findNearbyOnlineDrivers({ lat, lng, radiusMiles, limit: 200 });
  const counts = { sedan: 0, suv: 0, truck: 0 };
  for (const d of nearby) {
    if (counts[d.vehicleType] != null) counts[d.vehicleType] += 1;
  }

  res.json({
    ok: true,
    radiusMiles,
    tiers: Object.entries(counts).map(([vehicleType, availableDrivers]) => ({
      vehicleType,
      available: availableDrivers > 0,
      availableDrivers,
    })),
  });
});

/** GET /api/public/nearby-drivers?lat=&lng=&radiusMiles=10&vehicleType= */
export const nearbyDrivers = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusMiles = Math.min(50, Math.max(1, Number(req.query.radiusMiles) || 10));
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
      lat: d.lat,
      lng: d.lng,
      vehicleType: d.vehicleType,
      distanceMiles: Math.round(d.distanceMiles * 10) / 10,
      updatedAt: d.updatedAt,
    })),
  });
});
