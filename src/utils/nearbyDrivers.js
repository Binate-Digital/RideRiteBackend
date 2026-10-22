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

/** Stable tiny offset so unknown-GPS drivers don't stack on one pixel. */
function offsetFromId(id, index) {
  const s = String(id || index);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const angle = (h % 360) * (Math.PI / 180);
  const meters = 80 + (h % 120);
  const dLat = (meters * Math.cos(angle)) / 111_320;
  const dLng = (meters * Math.sin(angle)) / (111_320 * Math.cos((28.5 * Math.PI) / 180));
  return { dLat, dLng };
}

/**
 * Online + approved drivers inside radiusMiles.
 * Drivers without lastLocation still count (placed near the search point)
 * so GPS permission failures don't hide available drivers from booking.
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
  };
  if (vehicleType) filter.vehicleType = vehicleType;

  const drivers = await DriverProfile.find(filter)
    .select("userId vehicleType lastLocation")
    .limit(300)
    .lean();

  const results = [];
  let unknownIdx = 0;

  for (const d of drivers) {
    const hasGps =
      d.lastLocation?.lat != null &&
      d.lastLocation?.lng != null &&
      Number.isFinite(d.lastLocation.lat) &&
      Number.isFinite(d.lastLocation.lng);

    if (hasGps) {
      const distanceMiles = haversineMiles(
        { lat, lng },
        { lat: d.lastLocation.lat, lng: d.lastLocation.lng },
      );
      if (distanceMiles > radiusMiles) continue;
      results.push({
        userId: d.userId,
        vehicleType: d.vehicleType,
        lat: d.lastLocation.lat,
        lng: d.lastLocation.lng,
        updatedAt: d.lastLocation.updatedAt ?? null,
        distanceMiles,
        locationUnknown: false,
      });
    } else {
      // No GPS yet — still bookable; show near the rider pickup
      const { dLat, dLng } = offsetFromId(d.userId, unknownIdx++);
      results.push({
        userId: d.userId,
        vehicleType: d.vehicleType,
        lat: lat + dLat,
        lng: lng + dLng,
        updatedAt: null,
        distanceMiles: 0,
        locationUnknown: true,
      });
    }
  }

  return results
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);
}
