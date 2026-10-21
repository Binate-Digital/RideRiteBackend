import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";

const HOURLY_RATES = { sedan: 6500, suv: 8500, truck: 9500 }; // cents

/** POST /api/chauffeur/estimate — body: { durationHours, vehicleType } */
export const estimate = asyncHandler(async (req, res) => {
  const durationHours = Math.max(1, Math.min(24, Number(req.body?.durationHours) || 1));
  const vehicleType = ["sedan", "suv", "truck"].includes(req.body?.vehicleType)
    ? req.body.vehicleType
    : "sedan";
  const hourlyRateCents = HOURLY_RATES[vehicleType];
  res.json({
    ok: true,
    estimate: {
      durationHours,
      vehicleType,
      hourlyRateCents,
      totalCents: hourlyRateCents * durationHours,
    },
  });
});

/** POST /api/chauffeur/bookings */
export const book = asyncHandler(async (req, res) => {
  const pickupAddress = String(req.body?.pickupAddress || "").trim();
  if (!pickupAddress) throw httpError(400, "pickupAddress required");
  const durationHours = Math.max(1, Math.min(24, Number(req.body?.durationHours) || 1));
  const vehicleType = ["sedan", "suv", "truck"].includes(req.body?.vehicleType)
    ? req.body.vehicleType
    : "sedan";
  const startAt = new Date(req.body?.startAt || Date.now());
  const hourlyRateCents = HOURLY_RATES[vehicleType];
  const row = await ChauffeurBooking.create({
    riderId: req.user._id,
    pickupAddress,
    pickupCoords: {
      lat: req.body?.pickupCoords?.lat ?? null,
      lng: req.body?.pickupCoords?.lng ?? null,
    },
    startAt,
    durationHours,
    vehicleType,
    hourlyRateCents,
    totalCents: hourlyRateCents * durationHours,
    notes: String(req.body?.notes || "").trim(),
    status: "confirmed",
    paid: true,
    paymentStatus: "paid",
  });
  res.status(201).json({ ok: true, booking: row.toSafeJSON() });
});

/** GET /api/chauffeur/bookings/mine */
export const listMine = asyncHandler(async (req, res) => {
  const rows = await ChauffeurBooking.find({ riderId: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ ok: true, bookings: rows.map((r) => r.toSafeJSON()) });
});
