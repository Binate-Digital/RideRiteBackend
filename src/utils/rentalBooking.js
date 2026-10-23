import { RentalBooking } from "../models/RentalBooking.js";
import { RentalDaySlot } from "../models/RentalDaySlot.js";
import { RentalListing } from "../models/RentalListing.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";
import { cancelOpenIntent, recordIntentSucceeded } from "./checkout.js";
import { adjustRentalOwnerEarning, recordRentalOwnerEarning } from "./earnings.js";
import { refundPayment } from "./refunds.js";
import { Payment } from "../models/Payment.js";
import { rentalReceiptEmail } from "./mailer.js";
import { cancellationRefund, money, settleBookingRefund } from "./bookingRefunds.js";

const DAY_MS = 86400000;

/** "2026-11-02" or an ISO string → UTC midnight of that calendar day. */
export function toUtcDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export const dayKey = (d) => d.toISOString().slice(0, 10);

/** Calendar days a rental occupies: pickup day up to (not including) the return day. */
export function rentalDays(startDate, endDate) {
  const keys = [];
  for (let t = startDate.getTime(); t < endDate.getTime(); t += DAY_MS) keys.push(dayKey(new Date(t)));
  return keys;
}

/**
 * Validate dates against the listing and price them. This is the only place rental prices
 * are computed — the web shows this quote and the booking charges exactly it.
 */
export function quoteRental(listing, startRaw, endRaw) {
  const startDate = toUtcDay(startRaw);
  const endDate = toUtcDay(endRaw);
  if (!startDate || !endDate || !(startDate < endDate)) {
    throw httpError(400, "Choose a return date after the pickup date");
  }
  if (startDate < toUtcDay(new Date())) throw httpError(400, "Pickup date is in the past");
  if (listing.availableFrom && startDate < toUtcDay(listing.availableFrom)) {
    throw httpError(400, `This vehicle is available from ${dayKey(toUtcDay(listing.availableFrom))}`, {
      code: "OUTSIDE_AVAILABILITY",
    });
  }
  if (listing.availableTo && endDate > toUtcDay(listing.availableTo)) {
    throw httpError(400, `This vehicle must be returned by ${dayKey(toUtcDay(listing.availableTo))}`, {
      code: "OUTSIDE_AVAILABILITY",
    });
  }
  const days = Math.round((endDate - startDate) / DAY_MS);
  if (days > 60) throw httpError(400, "Rentals are limited to 60 days");
  const blocked = new Set(listing.blockedDays || []);
  if (blocked.size && rentalDays(startDate, endDate).some((d) => blocked.has(d))) {
    throw httpError(409, "Dates not available", { code: "DATES_TAKEN" });
  }
  const subtotalCents = days * listing.dailyRateCents;
  const commissionCents =
    listing.source === "peer" ? Math.round(subtotalCents * env.rentalCommissionRate) : 0;
  return {
    startDate,
    endDate,
    days,
    dailyRateCents: listing.dailyRateCents,
    subtotalCents,
    commissionCents,
    // No add-on fees: the renter pays the subtotal; commission comes out of the owner's share
    totalCents: subtotalCents,
  };
}

/**
 * Claim every day of the booking. The unique (listingId, day) index means only one of two
 * racing requests can hold a day; days are claimed in ascending order so at least one
 * contender always wins. On a clash, this booking's partial claims are released.
 */
export async function reserveRentalDays(booking) {
  const days = rentalDays(booking.startDate, booking.endDate);
  try {
    await RentalDaySlot.insertMany(
      days.map((day) => ({ listingId: booking.listingId, day, bookingId: booking._id })),
      { ordered: true },
    );
    return true;
  } catch (err) {
    await RentalDaySlot.deleteMany({ bookingId: booking._id });
    if (err?.code === 11000 || err?.writeErrors?.some?.((e) => e.code === 11000)) return false;
    throw err;
  }
}

export function releaseRentalDays(bookingId) {
  return RentalDaySlot.deleteMany({ bookingId });
}

/** Unpaid hold ran out (or payment failed): free the dates. No-op unless still pending. */
export async function expireRentalHold(bookingId, { paymentFailed = false } = {}) {
  const booking = await RentalBooking.findOneAndUpdate(
    { _id: bookingId, status: "pending_payment" },
    { $set: { status: "expired", paymentStatus: paymentFailed ? "failed" : "unpaid" } },
    { new: true },
  );
  if (!booking) return null;
  await releaseRentalDays(booking._id);
  if (!paymentFailed) await cancelOpenIntent(booking.stripePaymentIntentId);
  return booking;
}

/**
 * Payment succeeded (webhook, client sync or mock confirm). Idempotent. If the hold had
 * already expired, try to take the dates again; if someone else booked them meanwhile, the
 * payment is refunded in full.
 */
export async function confirmRentalPaid(bookingId, { paymentIntentId, provider }) {
  let booking = await RentalBooking.findById(bookingId);
  if (!booking) return null;
  if (booking.paid) return booking;

  if (booking.status === "expired") {
    const retaken = await RentalBooking.findOneAndUpdate(
      { _id: booking._id, status: "expired" },
      { $set: { status: "pending_payment" } },
      { new: true },
    );
    if (retaken && !(await reserveRentalDays(retaken))) {
      const payment = await recordIntentSucceeded({
        purpose: "rental",
        refId: booking._id,
        userId: booking.renterId,
        paymentIntentId,
        amountCents: booking.totalCents,
        provider,
      });
      await refundPayment(payment, payment.amountCents, { reason: "dates no longer available" });
      await RentalBooking.updateOne(
        { _id: booking._id },
        { $set: { status: "cancelled", paymentStatus: "refunded" } },
      );
      return RentalBooking.findById(booking._id);
    }
  }

  booking = await RentalBooking.findOneAndUpdate(
    { _id: booking._id, status: "pending_payment", paid: false },
    {
      $set: {
        status: "confirmed",
        paid: true,
        paidAt: new Date(),
        paymentStatus: "paid",
        holdExpiresAt: null,
        stripePaymentIntentId: paymentIntentId || booking.stripePaymentIntentId,
      },
    },
    { new: true },
  );
  if (!booking) return RentalBooking.findById(bookingId);

  await recordIntentSucceeded({
    purpose: "rental",
    refId: booking._id,
    userId: booking.renterId,
    paymentIntentId: booking.stripePaymentIntentId,
    amountCents: booking.totalCents,
    provider,
  });
  await recordRentalOwnerEarning(booking);

  const [renter, listing] = await Promise.all([
    User.findById(booking.renterId).select("fullName email"),
    RentalListing.findById(booking.listingId),
  ]);
  try {
    const { emailUser, notifyUser } = await import("../controllers/notifications.controller.js");
    // Receipt = "Payments & receipts" category (respects the rider's prefs)
    await emailUser(booking.renterId, "payment", rentalReceiptEmail({ fullName: renter?.fullName, booking, listing }));
    await notifyUser(booking.renterId, {
      category: "rental",
      title: "Rental confirmed",
      body: `${listing?.title || "Your rental"} · ${dayKey(booking.startDate)} → ${dayKey(booking.endDate)}`,
      data: { rentalBookingId: booking._id.toString(), href: "/rentals" },
    });
    if (String(booking.ownerId) !== String(booking.renterId) && booking.source === "peer") {
      await notifyUser(booking.ownerId, {
        category: "rental",
        title: "New rental booking",
        body: `${renter?.fullName || "A renter"} booked ${listing?.title || "your vehicle"} · ${dayKey(booking.startDate)} → ${dayKey(booking.endDate)} · you earn ${money(ownerPayoutCents(booking))}. You can decline within ${env.rentalOwnerDeclineHours}h.`,
        data: { rentalBookingId: booking._id.toString(), href: "/driver" },
        email: true,
      });
    }
  } catch {
    /* non-fatal */
  }
  return booking;
}

/** Card declined / intent failed: mark failed and free the dates right away. */
export async function failRentalPayment(bookingId, paymentIntentId) {
  if (paymentIntentId) {
    await Payment.updateMany({ stripePaymentIntentId: paymentIntentId }, { $set: { status: "failed" } });
  }
  const booking = await expireRentalHold(bookingId, { paymentFailed: true });
  if (booking) {
    const { notifyUser } = await import("../controllers/notifications.controller.js");
    await notifyUser(booking.renterId, {
      category: "payment",
      title: "Rental payment failed",
      body: `Your card was declined for ${money(booking.totalCents)}. The dates were released — book again to retry.`,
      data: { rentalBookingId: booking._id.toString(), href: "/rentals" },
      email: true,
    });
  }
  return booking;
}

/** The refund policy a renter would get cancelling `booking` right now. */
export function rentalCancelQuote(booking, now = new Date()) {
  return cancellationRefund({
    paidCents: booking.totalCents,
    startsAt: booking.startDate,
    fullRefundHours: env.rentalFullRefundHours,
    lateRefundPercent: env.rentalLateRefundPercent,
    now,
  });
}

/**
 * Renter cancels a paid rental before pickup: refund per policy (full ≥ RENTAL_FULL_REFUND_HOURS
 * before the start, else RENTAL_LATE_CANCEL_REFUND_PERCENT), release the days, rescale the
 * P2P owner's earning to what the platform keeps, and notify renter and owner.
 */
export async function cancelPaidRental(booking, now = new Date()) {
  if (!booking.paid || booking.status !== "confirmed") {
    throw httpError(400, "Only a confirmed rental can be cancelled", { code: "NOT_CANCELLABLE" });
  }
  if (now >= booking.startDate) {
    throw httpError(400, "This rental has already started and can't be cancelled", { code: "ALREADY_STARTED" });
  }
  const policy = rentalCancelQuote(booking, now);
  const cancelled = await RentalBooking.findOneAndUpdate(
    { _id: booking._id, status: "confirmed", paid: true },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: "renter",
        refundCents: policy.refundCents,
        refundPercent: policy.percent,
      },
    },
    { new: true },
  );
  if (!cancelled) throw httpError(409, "The booking just changed — refresh and try again");
  await releaseRentalDays(cancelled._id);
  await adjustRentalOwnerEarning(cancelled, cancelled.subtotalCents - policy.refundCents).catch((err) =>
    console.error(`[earnings] rental ${cancelled._id} owner adjustment failed:`, err.message),
  );
  const settled = policy.refundCents > 0 ? await settleBookingRefund(RentalBooking, "rental", cancelled._id) : null;
  const finalBooking = settled?.booking || (await RentalBooking.findById(cancelled._id));

  const listing = await RentalListing.findById(cancelled.listingId).select("title");
  const { notifyUser } = await import("../controllers/notifications.controller.js");
  const refundLine =
    policy.refundCents > 0
      ? `${money(policy.refundCents)} (${policy.percent}%) is being refunded to your card.`
      : "No refund applies under the cancellation policy.";
  await notifyUser(cancelled.renterId, {
    category: "rental",
    title: "Rental cancelled",
    body: `${listing?.title || "Your rental"} · ${dayKey(cancelled.startDate)} → ${dayKey(cancelled.endDate)}. ${refundLine}`,
    data: { rentalBookingId: cancelled._id.toString(), href: "/rentals", refundCents: policy.refundCents },
    email: true,
  });
  if (cancelled.source === "peer" && String(cancelled.ownerId) !== String(cancelled.renterId)) {
    await notifyUser(cancelled.ownerId, {
      category: "rental",
      title: "A rental of your vehicle was cancelled",
      body: `${listing?.title || "Listing"} · ${dayKey(cancelled.startDate)} → ${dayKey(cancelled.endDate)} — the dates are open again.`,
      data: { rentalBookingId: cancelled._id.toString(), href: "/driver" },
      email: true,
    });
  }
  return { booking: finalBooking, policy };
}

/**
 * Booked days of a listing between `from` and `to` (UTC days, to exclusive), from day slots
 * (paid bookings and live unpaid holds) and bookings that predate slots. Returns sorted
 * day keys and merged [start, end) ranges.
 */
export async function bookedDaysForListing(listingId, from, to, { blockedDays = [] } = {}) {
  const keys = new Set(
    (
      await RentalDaySlot.find({ listingId, day: { $gte: dayKey(from), $lt: dayKey(to) } })
        .select("day")
        .lean()
    ).map((s) => s.day),
  );
  const legacy = await RentalBooking.find({
    listingId,
    status: { $in: ["confirmed", "active"] },
    startDate: { $lt: to },
    endDate: { $gt: from },
  })
    .select("startDate endDate")
    .lean();
  for (const b of legacy) {
    for (const k of rentalDays(new Date(Math.max(b.startDate, from)), new Date(Math.min(b.endDate, to)))) keys.add(k);
  }
  // Owner-blocked days are unavailable to renters exactly like booked ones
  const fromKey = dayKey(from);
  const toKey = dayKey(to);
  for (const d of blockedDays) if (d >= fromKey && d < toKey) keys.add(d);
  const days = [...keys].sort();
  const ranges = [];
  for (const d of days) {
    const last = ranges[ranges.length - 1];
    const next = dayKey(new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS));
    if (last && last.end === d) last.end = next;
    else ranges.push({ start: d, end: next });
  }
  return { days, ranges };
}

/** Listing ids with any booked day in [start, end) — used by the availability filter. */
export async function listingsBookedBetween(startDate, endDate) {
  const days = rentalDays(startDate, endDate);
  const [slotted, legacy, blocked] = await Promise.all([
    RentalDaySlot.distinct("listingId", { day: { $in: days } }),
    RentalBooking.distinct("listingId", {
      status: { $in: ["confirmed", "active"] },
      startDate: { $lt: endDate },
      endDate: { $gt: startDate },
    }),
    RentalListing.distinct("_id", { blockedDays: { $in: days } }),
  ]);
  return [...slotted, ...legacy, ...blocked];
}

export async function sweepExpiredRentalHolds(now = new Date()) {
  const stale = await RentalBooking.find({ status: "pending_payment", holdExpiresAt: { $lte: now } })
    .select("_id")
    .limit(200)
    .lean();
  for (const b of stale) await expireRentalHold(b._id);
  return stale.length;
}

/** Payout the owner earns on a P2P booking (subtotal − platform commission). */
export const ownerPayoutCents = (booking) => (booking.subtotalCents || 0) - (booking.commissionCents || 0);

/** When the owner's right to decline a paid booking ends (RENTAL_OWNER_DECLINE_HOURS after payment). */
export function ownerDeclineDeadline(booking) {
  const madeAt = booking.paidAt || booking.createdAt;
  if (!madeAt) return null;
  const byWindow = new Date(new Date(madeAt).getTime() + env.rentalOwnerDeclineHours * 3600000);
  // Never after pickup
  return new Date(Math.min(byWindow.getTime(), new Date(booking.startDate).getTime()));
}

/**
 * P2P owner declines a paid booking within RENTAL_OWNER_DECLINE_HOURS of it being made:
 * the renter gets a full refund, the dates open again and the owner's earning is voided.
 */
export async function declineRentalByOwner(booking, { reason = "", now = new Date() } = {}) {
  if (booking.source !== "peer") throw httpError(400, "Only peer-to-peer bookings can be declined by the owner");
  if (!booking.paid || booking.status !== "confirmed") {
    throw httpError(400, "Only a confirmed, paid booking can be declined", { code: "NOT_DECLINABLE" });
  }
  const deadline = ownerDeclineDeadline(booking);
  if (!deadline || now >= deadline) {
    throw httpError(
      409,
      `Bookings can only be declined within ${env.rentalOwnerDeclineHours} hours of being made (and before pickup)`,
      { code: "DECLINE_WINDOW_PASSED" },
    );
  }
  const cancelled = await RentalBooking.findOneAndUpdate(
    { _id: booking._id, status: "confirmed", paid: true },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: "owner",
        declineReason: String(reason || "").slice(0, 300),
        refundCents: booking.totalCents,
        refundPercent: 100,
      },
    },
    { new: true },
  );
  if (!cancelled) throw httpError(409, "The booking just changed — refresh and try again");
  await releaseRentalDays(cancelled._id);
  await adjustRentalOwnerEarning(cancelled, 0).catch((err) =>
    console.error(`[earnings] rental ${cancelled._id} owner decline adjustment failed:`, err.message),
  );
  const settled = cancelled.refundCents > 0 ? await settleBookingRefund(RentalBooking, "rental", cancelled._id) : null;
  const finalBooking = settled?.booking || (await RentalBooking.findById(cancelled._id));

  const listing = await RentalListing.findById(cancelled.listingId).select("title");
  const { notifyUser } = await import("../controllers/notifications.controller.js");
  const when = `${dayKey(cancelled.startDate)} → ${dayKey(cancelled.endDate)}`;
  await notifyUser(cancelled.renterId, {
    category: "rental",
    title: "Your rental was declined by the owner",
    body: `${listing?.title || "Your rental"} · ${when}. ${money(cancelled.totalCents)} is being refunded to your card in full.`,
    data: { rentalBookingId: cancelled._id.toString(), href: "/rentals", refundCents: cancelled.totalCents },
    email: true,
  });
  await notifyUser(cancelled.ownerId, {
    category: "rental",
    title: "Booking declined",
    body: `${listing?.title || "Listing"} · ${when} — the renter was refunded and the dates are open again.`,
    data: { rentalBookingId: cancelled._id.toString(), href: "/driver" },
  });
  return finalBooking;
}
