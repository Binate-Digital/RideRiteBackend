import { DriverProfile } from "../models/DriverProfile.js";

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
 * Online + approved drivers with a fresh-ish GPS fix inside radiusMiles.
 * Optionally filter by vehicleType.
 */
export async function findNearbyOnlineDrivers({
  lat,
  lng,
  radiusMiles = 100,
  vehicleType = null,
  limit = 100,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const filter = {
    isOnline: true,
    isApproved: true,
    "lastLocation.lat": { $ne: null },
    "lastLocation.lng": { $ne: null },
  };
  if (vehicleType) filter.vehicleType = vehicleType;

  const drivers = await DriverProfile.find(filter)
    .select("userId vehicleType lastLocation")
    .limit(300)
    .lean();

  return drivers
    .map((d) => {
      const distanceMiles = haversineMiles(
        { lat, lng },
        { lat: d.lastLocation.lat, lng: d.lastLocation.lng },
      );
      return {
        userId: d.userId,
        vehicleType: d.vehicleType,
        lat: d.lastLocation.lat,
        lng: d.lastLocation.lng,
        updatedAt: d.lastLocation.updatedAt ?? null,
        distanceMiles,
      };
    })
    .filter((d) => d.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);
}
