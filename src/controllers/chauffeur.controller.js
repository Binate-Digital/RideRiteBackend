import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { isStripeMock } from "../lib/stripe.js";
import { chauffeurReceipt } from "../utils/receipts.js";
import { createCheckoutIntent, retrieveIntentStatus } from "../utils/checkout.js";
import {
  chauffeurOptions,
  confirmChauffeurPaid,
  expireChauffeurHold,
  quoteChauffeur,
  validateChauffeurStart,
} from "../utils/chauffeurBooking.js";
import {
  acceptChauffeurBooking,
  assertPickable,
  availableChauffeurDrivers,
  cancelPaidChauffeur,
  chooseChauffeurDriver,
  claimDriverSlots,
  declineChauffeurRequest,
  releaseDriverSlots,
  chauffeurBookingsForDriver,
  chauffeurBookingsForRider,
  completeChauffeurBooking,
  openChauffeurBookingsFor,
  startChauffeurBooking,
} from "../utils/chauffeurAssignment.js";

/** GET /api/chauffeur/options — tiers with backend hourly rates (the web shows these) */
export const options = asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    tiers: chauffeurOptions(),
    minLeadMinutes: env.chauffeurMinLeadMinutes,
    holdMinutes: Math.ceil(env.bookingHoldSeconds / 60),
    cancelPolicy: {
      fullRefundHours: env.chauffeurFullRefundHours,
      lateRefundPercent: env.chauffeurLateRefundPercent,
    },
    driverChoice: {
      acceptMinutes: env.chauffeurDirectAcceptMinutes,
      cutoffMinutes: env.chauffeurDirectCutoffMinutes,
      autoFallbackDefault: env.chauffeurDirectAutoFallback,
    },
  });
});

/**
 * GET /api/chauffeur/available-drivers?tier=&startAt=&durationHours= — drivers the rider can
 * pick for that vehicle type and time window (public cards: first name, photo, vehicle without
 * plate, rating, completed chauffeur jobs; never phone or location).
 */
export const availableDrivers = asyncHandler(async (req, res) => {
  const q = quoteChauffeur({ tier: req.query.tier, vehicleType: req.query.vehicleType, durationHours: req.query.durationHours });
  const startAt = new Date(String(req.query.startAt || ""));
  if (Number.isNaN(startAt.getTime())) throw httpError(400, "startAt is required");
  const drivers = await availableChauffeurDrivers({
    vehicleType: q.vehicleType,
    startAt,
    durationHours: q.durationHours,
    excludeIds: [req.user._id],
  });
  res.json({ ok: true, vehicleType: q.vehicleType, startAt, durationHours: q.durationHours, drivers });
});

/** POST /api/chauffeur/estimate — body: { tier?, vehicleType?, durationHours } */
export const estimate = asyncHandler(async (req, res) => {
  res.json({ ok: true, estimate: quoteChauffeur(req.body || {}) });
});

/**
 * POST /api/chauffeur/bookings — body: { tier, durationHours, startAt, pickupAddress, pickupCoords?, notes?,
 *   driverId?, autoFallback? }
 * Created as `pending_payment` with a PaymentIntent; confirmed only after payment succeeds.
 * With `driverId` (from /available-drivers) that driver's time is held right away and only they
 * are offered the booking once it's paid; without it RideRite offers it to every eligible driver.
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
    autoFallback:
      typeof req.body?.autoFallback === "boolean" ? req.body.autoFallback : env.chauffeurDirectAutoFallback,
  });
  const pickedDriverId = req.body?.driverId ? String(req.body.driverId) : null;
  try {
    if (pickedDriverId) {
      await assertPickable(row, pickedDriverId);
      // Atomic: two riders picking the same driver for overlapping times -> only one gets them
      if (!(await claimDriverSlots(pickedDriverId, row))) {
        throw httpError(409, "That driver was just booked for this time — pick another one", { code: "DRIVER_UNAVAILABLE" });
      }
      row.assignmentMode = "direct";
      row.requestedDriverId = pickedDriverId;
      await row.save();
    }
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
    await releaseDriverSlots(row._id);
    await ChauffeurBooking.deleteOne({ _id: row._id });
    throw err;
  }
});

/**
 * POST /api/chauffeur/bookings/:id/choose-driver — body: { driverId } | { auto: true }, optional
 * autoFallback. For a paid booking without a driver (e.g. the picked driver declined).
 */
export const chooseDriver = asyncHandler(async (req, res) => {
  const booking = await loadRiderBooking(req);
  const auto = req.body?.auto === true;
  const updated = await chooseChauffeurDriver(booking, {
    auto,
    driverId: auto ? null : req.body?.driverId,
    autoFallback: typeof req.body?.autoFallback === "boolean" ? req.body.autoFallback : undefined,
  });
  const [json] = await chauffeurBookingsForRider([updated]);
  res.json({ ok: true, booking: json });
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

/**
 * POST /api/chauffeur/bookings/:id/cancel — abandon an unpaid booking, or cancel a paid one
 * before it starts (refund per the cancellation policy).
 */
export const cancelBooking = asyncHandler(async (req, res) => {
  const booking = await loadRiderBooking(req);
  if (booking.paid) {
    const reason = String(req.body?.reason || "").trim().slice(0, 200) || null;
    const { booking: done, policy } = await cancelPaidChauffeur(booking, { by: "rider", reason });
    const [json] = await chauffeurBookingsForRider([done]);
    return res.json({
      ok: true,
      booking: json,
      refundCents: policy.refundCents,
      refundPercent: policy.percent,
      message:
        policy.refundCents > 0
          ? `Booking cancelled. $${(policy.refundCents / 100).toFixed(2)} (${policy.percent}%) is being refunded.`
          : "Booking cancelled. No refund applies.",
    });
  }
  if (booking.status !== "pending_payment") {
    throw httpError(400, "This booking can't be cancelled");
  }
  await expireChauffeurHold(booking._id);
  await ChauffeurBooking.updateOne({ _id: booking._id, status: "expired" }, { $set: { status: "cancelled" } });
  res.json({ ok: true, booking: (await ChauffeurBooking.findById(booking._id)).toSafeJSON() });
});

/** GET /api/chauffeur/bookings/mine — with the assigned driver's card and cancel quote */
export const listMine = asyncHandler(async (req, res) => {
  const rows = await ChauffeurBooking.find({ riderId: req.user._id }).sort({ createdAt: -1 }).limit(50);
  res.json({
    ok: true,
    cancelPolicy: {
      fullRefundHours: env.chauffeurFullRefundHours,
      lateRefundPercent: env.chauffeurLateRefundPercent,
    },
    bookings: await chauffeurBookingsForRider(rows),
  });
});

/** GET /api/chauffeur/bookings/:id/receipt — rider's receipt (refunds included) */
export const receipt = asyncHandler(async (req, res) => {
  const booking = await loadRiderBooking(req);
  res.json({ ok: true, receipt: await chauffeurReceipt(booking) });
});

// ---------- Driver side: scheduled bookings ----------

/** GET /api/chauffeur/driver/open — bookings this driver can accept (eligibility + vehicle type) */
export const driverOpen = asyncHandler(async (req, res) => {
  const result = await openChauffeurBookingsFor(req.user._id);
  res.json({
    ok: true,
    eligible: result.eligible,
    reason: result.reason,
    vehicleType: result.vehicleType ?? result.profile?.vehicleType ?? null,
    bookings: await chauffeurBookingsForDriver(result.bookings),
    // Riders who picked this driver specifically (accept or decline before it expires)
    requests: await chauffeurBookingsForDriver(result.requests || []),
  });
});

/** GET /api/chauffeur/driver/mine — this driver's assigned / running / recent bookings */
export const driverMine = asyncHandler(async (req, res) => {
  const rows = await ChauffeurBooking.find({
    driverId: req.user._id,
    $or: [
      { status: { $in: ["driver_assigned", "in_progress"] } },
      { status: { $in: ["completed", "cancelled"] }, updatedAt: { $gte: new Date(Date.now() - 7 * 86400000) } },
    ],
  })
    .sort({ startAt: 1 })
    .limit(50);
  res.json({ ok: true, bookings: await chauffeurBookingsForDriver(rows) });
});

/** POST /api/chauffeur/bookings/:id/accept — the picked driver, or (auto) the first eligible driver */
export const driverAccept = asyncHandler(async (req, res) => {
  const booking = await acceptChauffeurBooking(req.params.id, req.user._id);
  const [json] = await chauffeurBookingsForDriver([booking]);
  res.json({ ok: true, booking: json });
});

/** POST /api/chauffeur/bookings/:id/decline — the picked driver passes on a request */
export const driverDecline = asyncHandler(async (req, res) => {
  const booking = await declineChauffeurRequest(req.params.id, req.user._id);
  const [json] = await chauffeurBookingsForDriver([booking]);
  res.json({ ok: true, booking: json });
});

/** POST /api/chauffeur/bookings/:id/start */
export const driverStart = asyncHandler(async (req, res) => {
  const booking = await startChauffeurBooking(req.params.id, req.user._id);
  const [json] = await chauffeurBookingsForDriver([booking]);
  res.json({ ok: true, booking: json });
});

/** POST /api/chauffeur/bookings/:id/complete */
export const driverComplete = asyncHandler(async (req, res) => {
  const booking = await completeChauffeurBooking(req.params.id, req.user._id);
  const [json] = await chauffeurBookingsForDriver([booking]);
  res.json({ ok: true, booking: json });
});
