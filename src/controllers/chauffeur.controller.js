import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { isStripeMock } from "../lib/stripe.js";
import { createCheckoutIntent, retrieveIntentStatus } from "../utils/checkout.js";
import {
  chauffeurOptions,
  confirmChauffeurPaid,
  expireChauffeurHold,
  quoteChauffeur,
  validateChauffeurStart,
} from "../utils/chauffeurBooking.js";

/** GET /api/chauffeur/options — tiers with backend hourly rates (the web shows these) */
export const options = asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    tiers: chauffeurOptions(),
    minLeadMinutes: env.chauffeurMinLeadMinutes,
    holdMinutes: Math.ceil(env.bookingHoldSeconds / 60),
  });
});

/** POST /api/chauffeur/estimate — body: { tier?, vehicleType?, durationHours } */
export const estimate = asyncHandler(async (req, res) => {
  res.json({ ok: true, estimate: quoteChauffeur(req.body || {}) });
});

/**
 * POST /api/chauffeur/bookings — body: { tier, durationHours, startAt, pickupAddress, pickupCoords?, notes? }
 * Created as `pending_payment` with a PaymentIntent; confirmed only after payment succeeds.
 */
export const book = asyncHandler(async (req, res) => {
  const pickupAddress = String(req.body?.pickupAddress || "").trim();
  if (!pickupAddress) throw httpError(400, "pickupAddress required");
  const startAt = validateChauffeurStart(req.body?.startAt);
  const q = quoteChauffeur(req.body || {});
  const lat = Number(req.body?.pickupCoords?.lat);
  const lng = Number(req.body?.pickupCoords?.lng);

  const row = await ChauffeurBooking.create({
    riderId: req.user._id,
    pickupAddress,
    pickupCoords: {
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    },
    startAt,
    durationHours: q.durationHours,
    tier: q.tier,
    vehicleType: q.vehicleType,
    hourlyRateCents: q.hourlyRateCents,
    totalCents: q.totalCents,
    notes: String(req.body?.notes || "").trim().slice(0, 500),
    status: "pending_payment",
    paid: false,
    paymentStatus: "pending",
    holdExpiresAt: new Date(Date.now() + env.bookingHoldSeconds * 1000),
  });
  try {
    const payment = await createCheckoutIntent({
      user: req.user,
      purpose: "chauffeur",
      refId: row._id,
      amountCents: row.totalCents,
      description: `RideRite private driver · ${q.tierLabel} · ${q.durationHours}h`,
    });
    row.stripePaymentIntentId = payment.paymentIntentId;
    await row.save();
    res.status(201).json({ ok: true, booking: row.toSafeJSON(), payment });
  } catch (err) {
    await ChauffeurBooking.deleteOne({ _id: row._id });
    throw err;
  }
});

async function loadRiderBooking(req) {
  const booking = await ChauffeurBooking.findById(req.params.id);
  if (!booking) throw httpError(404, "Booking not found");
  if (String(booking.riderId) !== String(req.user._id)) throw httpError(403, "Not your booking");
  return booking;
}

/** POST /api/chauffeur/bookings/:id/intent — resume checkout */
export const bookingIntent = asyncHandler(async (req, res) => {
  const booking = await loadRiderBooking(req);
  if (booking.paid) return res.json({ ok: true, alreadyPaid: true, booking: booking.toSafeJSON() });
  if (booking.status !== "pending_payment") {
    throw httpError(409, "This booking expired — book again", { code: "HOLD_EXPIRED" });
  }
  const payment = await createCheckoutIntent({
    user: req.user,
    purpose: "chauffeur",
    refId: booking._id,
    amountCents: booking.totalCents,
    description: `RideRite private driver · ${booking.durationHours}h`,
    existingIntentId: booking.stripePaymentIntentId,
  });
  if (payment.alreadySucceeded) {
    const done = await confirmChauffeurPaid(booking._id, { paymentIntentId: payment.paymentIntentId, provider: "stripe" });
    return res.json({ ok: true, alreadyPaid: true, booking: done.toSafeJSON() });
  }
  booking.stripePaymentIntentId = payment.paymentIntentId;
  await booking.save();
  res.json({ ok: true, booking: booking.toSafeJSON(), payment });
});

/** POST /api/chauffeur/bookings/:id/confirm-mock */
export const confirmMock = asyncHandler(async (req, res) => {
  if (!isStripeMock()) throw httpError(403, "Mock confirm only available in mock mode");
  const booking = await loadRiderBooking(req);
  const done = await confirmChauffeurPaid(booking._id, {
    paymentIntentId: booking.stripePaymentIntentId,
    provider: "mock",
  });
  if (!done.paid) throw httpError(409, "This booking can no longer be paid", { code: "HOLD_EXPIRED" });
  res.json({ ok: true, booking: done.toSafeJSON() });
});

/** POST /api/chauffeur/bookings/:id/sync — after stripe.confirmPayment on the client */
export const syncPayment = asyncHandler(async (req, res) => {
  const booking = await loadRiderBooking(req);
  if (booking.paid) return res.json({ ok: true, booking: booking.toSafeJSON() });
  if (isStripeMock()) throw httpError(400, "Use confirm-mock in mock mode");
  const status = await retrieveIntentStatus(booking.stripePaymentIntentId);
  if (status === "succeeded") {
    const done = await confirmChauffeurPaid(booking._id, {
      paymentIntentId: booking.stripePaymentIntentId,
      provider: "stripe",
    });
    return res.json({ ok: true, booking: done.toSafeJSON() });
  }
  res.json({ ok: true, paymentIntentStatus: status, booking: booking.toSafeJSON() });
});

/** POST /api/chauffeur/bookings/:id/cancel — abandon an unpaid booking */
export const cancelBooking = asyncHandler(async (req, res) => {
  const booking = await loadRiderBooking(req);
  if (booking.status !== "pending_payment") {
    throw httpError(400, "Only an unpaid booking can be released here — contact support to cancel a paid booking");
  }
  await expireChauffeurHold(booking._id);
  await ChauffeurBooking.updateOne({ _id: booking._id, status: "expired" }, { $set: { status: "cancelled" } });
  res.json({ ok: true, booking: (await ChauffeurBooking.findById(booking._id)).toSafeJSON() });
});

/** GET /api/chauffeur/bookings/mine */
export const listMine = asyncHandler(async (req, res) => {
  const rows = await ChauffeurBooking.find({ riderId: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ ok: true, bookings: rows.map((r) => r.toSafeJSON()) });
});
