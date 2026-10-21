import { Trip } from "../models/Trip.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";

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

function haversineMiles(a, b) {
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

/** GET /api/public/nearby-tiers?lat=&lng=&radiusMiles= */
export const nearbyTiers = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusMiles = Math.min(50, Math.max(1, Number(req.query.radiusMiles) || 15));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw httpError(400, "lat and lng required");
  }

  const drivers = await DriverProfile.find({
    isOnline: true,
    isApproved: true,
    "lastLocation.lat": { $ne: null },
    "lastLocation.lng": { $ne: null },
  })
    .select("vehicleType lastLocation")
    .limit(200)
    .lean();

  const counts = { sedan: 0, suv: 0, truck: 0 };
  for (const d of drivers) {
    const dist = haversineMiles(
      { lat, lng },
      { lat: d.lastLocation.lat, lng: d.lastLocation.lng },
    );
    if (dist <= radiusMiles && counts[d.vehicleType] != null) {
      counts[d.vehicleType] += 1;
    }
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
