/** Mirror of frontend DEFAULT_PRICING / computeFare for consistent estimates. */

export const DEFAULT_PRICING = {
  rates: {
    sedan: { base: 300, perMile: 150, perMin: 30, label: "Sedan" },
    suv: { base: 500, perMile: 225, perMin: 40, label: "SUV" },
    truck: { base: 700, perMile: 300, perMin: 50, label: "Truck" },
  },
  bookingFeeCents: 250,
  minimumFareCents: 700,
  serviceFeeRate: 0.15,
  taxRate: 0.07,
};

export function estimateDistanceDuration(pickup, destination) {
  const seed = (pickup + "|" + destination)
    .split("")
    .reduce((a, c) => a + c.charCodeAt(0), 0);
  const distance = 2 + (seed % 180) / 10;
  const duration = Math.max(6, Math.round(distance * 2.6 + (seed % 7)));
  return {
    distanceMiles: Number(distance.toFixed(1)),
    durationMinutes: duration,
  };
}

export function computeFare(
  vehicle,
  distanceMiles,
  durationMinutes,
  pricing = DEFAULT_PRICING,
  discountCents = 0,
) {
  const r = pricing.rates[vehicle];
  if (!r) throw new Error(`Unknown vehicle type: ${vehicle}`);

  const distanceCents = Math.round(r.perMile * distanceMiles);
  const timeCents = Math.round(r.perMin * durationMinutes);
  const meter = r.base + distanceCents + timeCents;
  const meterFloored = Math.max(meter, pricing.minimumFareCents);
  const baseFareCents = meterFloored + pricing.bookingFeeCents;
  const serviceFeeCents = Math.round(baseFareCents * pricing.serviceFeeRate);
  const taxCents = Math.round((baseFareCents + serviceFeeCents) * pricing.taxRate);
  const subtotal = baseFareCents + serviceFeeCents + taxCents;
  const appliedDiscount = Math.max(0, Math.min(discountCents, subtotal - 100));
  const totalCents = subtotal - appliedDiscount;

  return {
    baseRateCents: r.base,
    distanceCents,
    timeCents,
    bookingFeeCents: pricing.bookingFeeCents,
    baseFareCents,
    serviceFeeCents,
    taxCents,
    discountCents: appliedDiscount,
    totalCents,
    vehicleLabel: r.label,
  };
}

/**
 * `discountFor(subtotalCents)` (optional) returns the promo discount for the
 * pre-discount subtotal; computeFare caps it so a ride never drops below $1.
 */
export function buildEstimate({
  pickup,
  destination,
  vehicle,
  pickupCoords,
  destinationCoords,
  discountFor,
}) {
  // Prefer haversine if coords provided; else deterministic mock from addresses
  let distanceMiles;
  let durationMinutes;

  if (pickupCoords?.lat != null && destinationCoords?.lat != null) {
    distanceMiles = haversineMiles(pickupCoords, destinationCoords);
    durationMinutes = Math.max(6, Math.round(distanceMiles * 2.6));
  } else {
    ({ distanceMiles, durationMinutes } = estimateDistanceDuration(pickup, destination));
  }

  let fare = computeFare(vehicle, distanceMiles, durationMinutes);
  if (discountFor) {
    const subtotal = fare.baseFareCents + fare.serviceFeeCents + fare.taxCents;
    fare = computeFare(
      vehicle,
      distanceMiles,
      durationMinutes,
      DEFAULT_PRICING,
      discountFor(subtotal),
    );
  }
  return {
    distanceMiles,
    durationMinutes,
    source: pickupCoords && destinationCoords ? "coords" : "estimate",
    ...fare,
  };
}

function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Number((2 * R * Math.asin(Math.sqrt(h))).toFixed(1));
}

export const CANCEL_GRACE_SECONDS = 120;
export const CANCEL_FEE_CENTS_AFTER_MATCH = 500;
