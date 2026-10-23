import { RentalBooking } from "../models/RentalBooking.js";
import { RentalDaySlot } from "../models/RentalDaySlot.js";
import { RentalListing } from "../models/RentalListing.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";
import { cancelOpenIntent, recordIntentSucceeded } from "./checkout.js";
import { recordRentalOwnerEarning } from "./earnings.js";
import { refundPayment } from "./refunds.js";
import { Payment } from "../models/Payment.js";
import { rentalReceiptEmail, sendMail } from "./mailer.js";

const DAY_MS = 86400000;

/** "2026-11-02" or an ISO string → UTC midnight of that calendar day. */
export function toUtcDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const dayKey = (d) => d.toISOString().slice(0, 10);

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
  if (renter?.email) {
    await sendMail({ to: renter.email, ...rentalReceiptEmail({ fullName: renter.fullName, booking, listing }) });
  }
  try {
    const { notifyUser } = await import("../controllers/notifications.controller.js");
    await notifyUser(booking.renterId, {
      category: "rental",
      title: "Rental confirmed",
      body: `${listing?.title || "Your rental"} · ${dayKey(booking.startDate)} → ${dayKey(booking.endDate)}`,
      data: { rentalBookingId: booking._id.toString(), href: "/rentals" },
    });
    if (String(booking.ownerId) !== String(booking.renterId) && booking.source === "peer") {
      await notifyUser(booking.ownerId, {
        category: "rental",
        title: "Your vehicle was booked",
        body: `${listing?.title || "Listing"} · ${dayKey(booking.startDate)} → ${dayKey(booking.endDate)}`,
        data: { rentalBookingId: booking._id.toString(), href: "/driver" },
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
  return expireRentalHold(bookingId, { paymentFailed: true });
}

export async function sweepExpiredRentalHolds(now = new Date()) {
  const stale = await RentalBooking.find({ status: "pending_payment", holdExpiresAt: { $lte: now } })
    .select("_id")
    .limit(200)
    .lean();
  for (const b of stale) await expireRentalHold(b._id);
  return stale.length;
}
