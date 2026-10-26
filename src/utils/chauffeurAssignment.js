import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";
import { canDriverHandleRides } from "./driverReadiness.js";
import { driverCardsFor } from "./tripDrivers.js";
import { recordChauffeurEarning } from "./earnings.js";
import { cancellationRefund, money, settleBookingRefund } from "./bookingRefunds.js";
import { emitToDrivers, emitToUser } from "../realtime/index.js";
import { getSettings } from "./settings.js";

/**
 * Private driver (chauffeur) assignment — TRD 4.9.
 *
 * A paid booking is `confirmed` and shows up as a "Scheduled booking" in the hub of every
 * eligible driver (online, approved, subscribed, Connect ready) with the matching vehicle
 * type. The first driver to accept wins (conditional update on driverId: null).
 *   confirmed → driver_assigned → in_progress → completed   (cancelled by rider or system)
 * Completion credits the driver's ledger (CHAUFFEUR_COMMISSION_RATE kept by the platform).
 */

const ACTIVE_FOR_DRIVER = ["driver_assigned", "in_progress"];
const HOUR_MS = 3600000;

async function notify(userId, payload) {
  const { notifyUser } = await import("../controllers/notifications.controller.js");
  return notifyUser(userId, payload);
}

const when = (d) =>
  new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Booking JSON for its rider, with the assigned driver's public card (no phone numbers). */
export async function chauffeurBookingsForRider(bookings, now = new Date()) {
  const cards = await driverCardsFor(bookings.map((b) => b.driverId));
  return bookings.map((b) => ({
    ...b.toSafeJSON(),
    driver: b.driverId ? cards.get(String(b.driverId)) || null : null,
    cancelQuote:
      b.paid && ["confirmed", "driver_assigned"].includes(b.status) && now < b.startAt
        ? chauffeurCancelQuote(b, now)
        : null,
  }));
}

/** Booking JSON for a driver: rider's first name only. */
export async function chauffeurBookingsForDriver(bookings) {
  const riders = await User.find({ _id: { $in: bookings.map((b) => b.riderId) } }).select("fullName").lean();
  const names = new Map(riders.map((u) => [String(u._id), String(u.fullName || "").split(" ")[0]]));
  return bookings.map((b) => ({
    ...b.toSafeJSON(),
    riderFirstName: names.get(String(b.riderId)) || "Rider",
    driverEarningCents: Math.round(b.totalCents * (1 - getSettings().commission.chauffeurRate)),
  }));
}

/** Push the booking's latest state to its rider and driver (live status on both screens). */
export async function broadcastChauffeur(booking) {
  const [riderJson] = await chauffeurBookingsForRider([booking]);
  emitToUser(String(booking.riderId), "chauffeur:update", { booking: riderJson });
  if (booking.driverId) {
    const [driverJson] = await chauffeurBookingsForDriver([booking]);
    emitToUser(String(booking.driverId), "chauffeur:update", { booking: driverJson });
  }
}

/** Can this driver take scheduled bookings right now? */
export async function chauffeurEligibility(userId) {
  const profile = await DriverProfile.findOne({ userId });
  if (!profile) return { eligible: false, reason: "Set up your driver profile first", profile: null };
  const { driverHasActiveSubscription } = await import("../controllers/subscriptions.controller.js");
  const subscriptionActive = await driverHasActiveSubscription(userId);
  if (!canDriverHandleRides(profile, { subscriptionActive })) {
    return { eligible: false, reason: "Finish approval, membership and payouts to take bookings", profile };
  }
  if (!profile.isOnline) return { eligible: false, reason: "Go online to see scheduled bookings", profile };
  return { eligible: true, reason: null, profile };
}

/** Open bookings this driver could accept: paid, unassigned, their vehicle type, not started. */
export async function openChauffeurBookingsFor(userId, now = new Date()) {
  const elig = await chauffeurEligibility(userId);
  if (!elig.eligible) return { ...elig, bookings: [] };
  const rows = await ChauffeurBooking.find({
    status: "confirmed",
    driverId: null,
    vehicleType: elig.profile.vehicleType,
    startAt: { $gt: now },
  })
    .sort({ startAt: 1 })
    .limit(50);
  return { eligible: true, reason: null, vehicleType: elig.profile.vehicleType, bookings: rows };
}

/** First eligible driver to accept wins; everyone else gets 409. */
export async function acceptChauffeurBooking(bookingId, driverUserId, now = new Date()) {
  const elig = await chauffeurEligibility(driverUserId);
  if (!elig.eligible) throw httpError(403, elig.reason, { code: "DRIVER_NOT_ELIGIBLE" });
  const booking = await ChauffeurBooking.findById(bookingId);
  if (!booking) throw httpError(404, "Booking not found");
  if (booking.vehicleType !== elig.profile.vehicleType) {
    throw httpError(403, `This booking needs a ${booking.vehicleType.toUpperCase()}`, { code: "VEHICLE_MISMATCH" });
  }
  const start = booking.startAt;
  const end = new Date(start.getTime() + booking.durationHours * HOUR_MS);
  // The driver can't hold two bookings whose time blocks overlap
  const clash = await ChauffeurBooking.exists({
    _id: { $ne: booking._id },
    driverId: driverUserId,
    status: { $in: ACTIVE_FOR_DRIVER },
    startAt: { $lt: end },
    $expr: { $gt: [{ $add: ["$startAt", { $multiply: ["$durationHours", HOUR_MS] }] }, start] },
  });
  if (clash) throw httpError(409, "You already have a booking during this time", { code: "DRIVER_BUSY" });

  const assigned = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: "confirmed", driverId: null, startAt: { $gt: now } },
    { $set: { driverId: driverUserId, status: "driver_assigned", assignedAt: now } },
    { new: true },
  );
  if (!assigned) throw httpError(409, "Another driver already accepted this booking", { code: "ALREADY_TAKEN" });

  emitToDrivers("chauffeur:closed", { bookingId: assigned._id.toString() });
  await broadcastChauffeur(assigned);
  const driver = await User.findById(driverUserId).select("fullName");
  await notify(assigned.riderId, {
    category: "chauffeur",
    title: "Private driver assigned",
    body: `${driver?.fullName?.split(" ")[0] || "Your driver"} will pick you up ${when(assigned.startAt)} at ${assigned.pickupAddress}.`,
    data: { chauffeurBookingId: assigned._id.toString(), href: "/chauffeur", status: "driver_assigned" },
    sms: true,
    email: true,
  });
  return assigned;
}

async function loadDriverBooking(bookingId, driverUserId) {
  const booking = await ChauffeurBooking.findById(bookingId);
  if (!booking) throw httpError(404, "Booking not found");
  if (String(booking.driverId) !== String(driverUserId)) throw httpError(403, "Not your booking");
  return booking;
}

/** Assigned driver starts the time block (from CHAUFFEUR_START_EARLY_MINUTES before startAt). */
export async function startChauffeurBooking(bookingId, driverUserId, now = new Date()) {
  const booking = await loadDriverBooking(bookingId, driverUserId);
  const earliest = booking.startAt.getTime() - env.chauffeurStartEarlyMinutes * 60000;
  if (now.getTime() < earliest) {
    throw httpError(400, `You can start this booking from ${when(new Date(earliest))}`, { code: "TOO_EARLY" });
  }
  const started = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: "driver_assigned", driverId: driverUserId },
    { $set: { status: "in_progress", startedAt: now } },
    { new: true },
  );
  if (!started) throw httpError(409, `Can't start a booking that is ${booking.status.replace("_", " ")}`);
  await broadcastChauffeur(started);
  await notify(started.riderId, {
    category: "chauffeur",
    title: "Private driver booking started",
    body: `Your ${started.durationHours}h booking is under way.`,
    data: { chauffeurBookingId: started._id.toString(), href: "/chauffeur", status: "in_progress" },
  });
  return started;
}

/** Driver ends the booking → completed, driver earning recorded once. */
export async function completeChauffeurBooking(bookingId, driverUserId, now = new Date()) {
  const booking = await loadDriverBooking(bookingId, driverUserId);
  const done = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: "in_progress", driverId: driverUserId },
    { $set: { status: "completed", completedAt: now } },
    { new: true },
  );
  if (!done) throw httpError(409, `Can't complete a booking that is ${booking.status.replace("_", " ")}`);
  try {
    await recordChauffeurEarning(done);
  } catch (err) {
    console.error(`[earnings] chauffeur ${done._id} not recorded:`, err.message);
  }
  await broadcastChauffeur(done);
  await notify(done.riderId, {
    category: "chauffeur",
    title: "Private driver booking completed",
    body: "Thanks for riding with RideRite.",
    data: { chauffeurBookingId: done._id.toString(), href: "/chauffeur", status: "completed" },
  });
  return done;
}

export function chauffeurCancelQuote(booking, now = new Date()) {
  return cancellationRefund({
    paidCents: booking.totalCents,
    startsAt: booking.startAt,
    fullRefundHours: env.chauffeurFullRefundHours,
    lateRefundPercent: env.chauffeurLateRefundPercent,
    now,
  });
}

/**
 * Cancel a paid booking. by "rider": refund per policy (CHAUFFEUR_FULL_REFUND_HOURS /
 * CHAUFFEUR_LATE_CANCEL_REFUND_PERCENT), only before the start. by "system": nobody accepted
 * before the start time — full refund.
 */
export async function cancelPaidChauffeur(booking, { by = "rider", reason = null, now = new Date() } = {}) {
  if (!booking.paid || !["confirmed", "driver_assigned"].includes(booking.status)) {
    throw httpError(400, "Only an upcoming booking can be cancelled", { code: "NOT_CANCELLABLE" });
  }
  if (by === "rider" && now >= booking.startAt) {
    throw httpError(400, "This booking has already started and can't be cancelled", { code: "ALREADY_STARTED" });
  }
  const policy =
    by === "system"
      ? { percent: 100, refundCents: booking.totalCents }
      : chauffeurCancelQuote(booking, now);
  const cancelled = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: booking.status, driverId: booking.driverId ?? null },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: by,
        cancelReason: reason,
        refundCents: policy.refundCents,
        refundPercent: policy.percent,
      },
    },
    { new: true },
  );
  if (!cancelled) throw httpError(409, "The booking just changed — refresh and try again");
  const settled =
    policy.refundCents > 0 ? await settleBookingRefund(ChauffeurBooking, "chauffeur", cancelled._id) : null;
  const finalBooking = settled?.booking || (await ChauffeurBooking.findById(cancelled._id));

  emitToDrivers("chauffeur:closed", { bookingId: cancelled._id.toString() });
  await broadcastChauffeur(finalBooking);
  const refundLine =
    policy.refundCents > 0
      ? `${money(policy.refundCents)} (${policy.percent}%) is being refunded to your card.`
      : "No refund applies under the cancellation policy.";
  await notify(cancelled.riderId, {
    category: "chauffeur",
    title: by === "system" ? "No private driver available" : "Private driver booking cancelled",
    body:
      by === "system"
        ? `No driver accepted your ${when(cancelled.startAt)} booking, so it was cancelled. ${refundLine}`
        : `${when(cancelled.startAt)} · ${cancelled.durationHours}h. ${refundLine}`,
    data: { chauffeurBookingId: cancelled._id.toString(), href: "/chauffeur", status: "cancelled" },
    email: true,
  });
  if (booking.driverId) {
    await notify(booking.driverId, {
      category: "chauffeur",
      title: "Scheduled booking cancelled",
      body: `The rider cancelled the ${when(cancelled.startAt)} booking at ${cancelled.pickupAddress}.`,
      data: { chauffeurBookingId: cancelled._id.toString(), href: "/driver", status: "cancelled" },
      sms: true,
      email: true,
    });
  }
  return { booking: finalBooking, policy };
}

/** Sweeper: paid bookings nobody accepted by their start time are cancelled and refunded. */
export async function cancelUnassignedStartedBookings(now = new Date()) {
  const stale = await ChauffeurBooking.find({ status: "confirmed", driverId: null, startAt: { $lte: now } }).limit(50);
  let n = 0;
  for (const b of stale) {
    try {
      await cancelPaidChauffeur(b, { by: "system", reason: "No driver accepted before the start time", now });
      n += 1;
    } catch (err) {
      if (err.statusCode !== 409) console.error(`[chauffeur] auto-cancel ${b._id}:`, err.message);
    }
  }
  return n;
}
