import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { Payment } from "../models/Payment.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";
import { cancelOpenIntent, recordIntentSucceeded } from "./checkout.js";
import { chauffeurReceiptEmail } from "./mailer.js";
import { money } from "./bookingRefunds.js";
import { emitToDrivers } from "../realtime/index.js";
import { getSettings } from "./settings.js";

/**
 * Private driver service tiers (TRD 4.9). The backend is the single source of pricing: each
 * tier maps to a vehicle type whose hourly rate comes from CHAUFFEUR_HOURLY_*_CENTS.
 */
export const CHAUFFEUR_TIERS = [
  { id: "executive", label: "Executive Sedan", vehicleType: "sedan", minHours: 2, passengers: 3 },
  { id: "luxury_suv", label: "Luxury Black SUV", vehicleType: "suv", minHours: 3, passengers: 6 },
  { id: "premium_xl", label: "Premium XL Truck", vehicleType: "truck", minHours: 4, passengers: 5 },
];

export const CHAUFFEUR_MAX_HOURS = 24;

export function chauffeurOptions() {
  return CHAUFFEUR_TIERS.map((t) => ({
    ...t,
    hourlyRateCents: getSettings().chauffeurHourlyCents[t.vehicleType],
    maxHours: CHAUFFEUR_MAX_HOURS,
  }));
}

/** Resolve tier (preferred) or bare vehicleType, validate hours, price it. */
export function quoteChauffeur({ tier, vehicleType, durationHours }) {
  const opt =
    CHAUFFEUR_TIERS.find((t) => t.id === tier) ||
    CHAUFFEUR_TIERS.find((t) => t.vehicleType === vehicleType) ||
    (tier || vehicleType ? null : CHAUFFEUR_TIERS[0]);
  if (!opt) throw httpError(400, "Unknown chauffeur tier");
  const hours = Number(durationHours);
  if (!Number.isInteger(hours) || hours < opt.minHours || hours > CHAUFFEUR_MAX_HOURS) {
    throw httpError(400, `${opt.label} bookings are ${opt.minHours}–${CHAUFFEUR_MAX_HOURS} whole hours`);
  }
  const hourlyRateCents = getSettings().chauffeurHourlyCents[opt.vehicleType];
  return {
    tier: opt.id,
    tierLabel: opt.label,
    vehicleType: opt.vehicleType,
    durationHours: hours,
    hourlyRateCents,
    totalCents: hourlyRateCents * hours,
  };
}

/** startAt must be a real date at least CHAUFFEUR_MIN_LEAD_MINUTES from now. */
export function validateChauffeurStart(raw) {
  const startAt = new Date(raw);
  if (!raw || Number.isNaN(startAt.getTime())) throw httpError(400, "startAt is required");
  const earliest = Date.now() + env.chauffeurMinLeadMinutes * 60000;
  if (startAt.getTime() < earliest) {
    throw httpError(
      400,
      env.chauffeurMinLeadMinutes > 0
        ? `Pick a start time at least ${env.chauffeurMinLeadMinutes} minutes from now`
        : "Pick a start time in the future",
      { code: "START_IN_PAST" },
    );
  }
  return startAt;
}

export async function expireChauffeurHold(bookingId, { paymentFailed = false } = {}) {
  const booking = await ChauffeurBooking.findOneAndUpdate(
    { _id: bookingId, status: "pending_payment" },
    { $set: { status: "expired", paymentStatus: paymentFailed ? "failed" : "unpaid" } },
    { new: true },
  );
  if (!booking) return null;
  // The picked driver's time is free again
  const { releaseDriverSlots } = await import("./chauffeurAssignment.js");
  await releaseDriverSlots(booking._id);
  // Canceled in Stripe too, so the dashboard shows it closed (a declined intent included)
  await cancelOpenIntent(booking.stripePaymentIntentId);
  return booking;
}

/** Payment succeeded → booking confirmed (idempotent). A late payment revives an expired hold. */
export async function confirmChauffeurPaid(bookingId, { paymentIntentId, provider }) {
  let booking = await ChauffeurBooking.findOneAndUpdate(
    { _id: bookingId, status: { $in: ["pending_payment", "expired"] }, paid: false },
    {
      $set: {
        status: "confirmed",
        paid: true,
        paidAt: new Date(),
        paymentStatus: "paid",
        holdExpiresAt: null,
      },
    },
    { new: true },
  );
  if (!booking) return ChauffeurBooking.findById(bookingId);
  if (paymentIntentId && !booking.stripePaymentIntentId) {
    booking.stripePaymentIntentId = paymentIntentId;
    await booking.save();
  }

  await recordIntentSucceeded({
    purpose: "chauffeur",
    refId: booking._id,
    userId: booking.riderId,
    paymentIntentId: booking.stripePaymentIntentId,
    amountCents: booking.totalCents,
    provider,
  });

  const rider = await User.findById(booking.riderId).select("fullName email");
  try {
    const { emailUser, notifyUser } = await import("../controllers/notifications.controller.js");
    await emailUser(booking.riderId, "payment", chauffeurReceiptEmail({ fullName: rider?.fullName, booking }));
    await notifyUser(booking.riderId, {
      category: "chauffeur",
      title: "Private driver booked",
      body: `${new Date(booking.startAt).toLocaleString("en-US")} · ${booking.durationHours}h — we'll tell you when a driver is assigned.`,
      data: { chauffeurBookingId: booking._id.toString(), href: "/chauffeur" },
      sms: true,
    });
  } catch {
    /* non-fatal */
  }
  const assignment = await import("./chauffeurAssignment.js");
  if (booking.requestedDriverId) {
    // Rider picked a driver: only they are offered it, until the direct-accept deadline. A
    // late payment on an expired hold may have lost the driver's time meanwhile.
    if (await assignment.claimDriverSlots(booking.requestedDriverId, booking)) {
      booking = await ChauffeurBooking.findOneAndUpdate(
        { _id: booking._id, requestedDriverId: booking.requestedDriverId, driverId: null },
        { $set: { directOfferExpiresAt: assignment.directOfferDeadline(booking.startAt) } },
        { new: true },
      ) || booking;
      await assignment.offerToRequestedDriver(booking).catch(() => {});
    } else {
      booking = (await assignment.directOfferFailed(booking, "unavailable")) || booking;
    }
  } else {
    // Show it in eligible drivers' "Scheduled bookings" right away
    emitToDrivers("chauffeur:open", {
      bookingId: booking._id.toString(),
      vehicleType: booking.vehicleType,
      startAt: booking.startAt,
    });
  }
  try {
    await assignment.broadcastChauffeur(booking);
  } catch {
    /* non-fatal */
  }
  return booking;
}

export async function failChauffeurPayment(bookingId, paymentIntentId) {
  if (paymentIntentId) {
    await Payment.updateMany({ stripePaymentIntentId: paymentIntentId }, { $set: { status: "failed" } });
  }
  const booking = await expireChauffeurHold(bookingId, { paymentFailed: true });
  if (booking) {
    const { notifyUser } = await import("../controllers/notifications.controller.js");
    await notifyUser(booking.riderId, {
      category: "payment",
      title: "Private driver payment failed",
      body: `Your card was declined for ${money(booking.totalCents)}. Book again to retry.`,
      data: { chauffeurBookingId: booking._id.toString(), href: "/chauffeur" },
      email: true,
      sms: true,
    });
  }
  return booking;
}

export async function sweepExpiredChauffeurHolds(now = new Date()) {
  const stale = await ChauffeurBooking.find({ status: "pending_payment", holdExpiresAt: { $lte: now } })
    .select("_id")
    .limit(200)
    .lean();
  for (const b of stale) await expireChauffeurHold(b._id);
  return stale.length;
}
