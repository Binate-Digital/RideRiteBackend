import { Payment } from "../models/Payment.js";
import { refundPayment } from "./refunds.js";

const HOUR_MS = 3600000;

/**
 * Cancellation policy for paid rentals and chauffeur bookings: a full refund when cancelled
 * at least `fullRefundHours` before the start, otherwise `lateRefundPercent` of what was paid
 * (RENTAL_* / CHAUFFEUR_* env). Cancelling after the start is not allowed by the callers.
 */
export function cancellationRefund({ paidCents, startsAt, fullRefundHours, lateRefundPercent, now = new Date() }) {
  const hoursBeforeStart = (new Date(startsAt).getTime() - now.getTime()) / HOUR_MS;
  const percent = hoursBeforeStart >= fullRefundHours ? 100 : lateRefundPercent;
  return {
    hoursBeforeStart,
    percent,
    refundCents: Math.round(((paidCents || 0) * percent) / 100),
  };
}

/**
 * Send the refund owed on a cancelled booking (`booking.refundCents`). The booking is claimed
 * first (paid → refunding) so a concurrent call — the cancel request and the payments sweeper —
 * can't both refund; a Stripe error puts it back to `paid` for the sweeper to retry.
 * Returns { booking, refundedCents } or null when nothing was claimed.
 */
export async function settleBookingRefund(Model, purpose, bookingId) {
  const booking = await Model.findOneAndUpdate(
    { _id: bookingId, status: "cancelled", paymentStatus: "paid", refundCents: { $gt: 0 } },
    { $set: { paymentStatus: "refunding" } },
    { new: true },
  );
  if (!booking) return null;
  const payment = await Payment.findOne({
    refId: booking._id,
    purpose,
    status: { $in: ["succeeded", "partially_refunded", "refunded"] },
  }).sort({ createdAt: -1 });
  if (!payment) {
    const updated = await Model.findByIdAndUpdate(booking._id, { $set: { paymentStatus: "refunded" } }, { new: true });
    return { booking: updated, refundedCents: 0 };
  }
  const owed = Math.min(booking.refundCents, payment.amountCents);
  const missing = owed - (payment.refundedCents || 0);
  try {
    if (missing > 0) await refundPayment(payment, missing, { reason: `${purpose} cancelled` });
  } catch (err) {
    console.error(`[refunds] ${purpose} ${booking._id} refund failed:`, err.message);
    await Model.updateOne({ _id: booking._id }, { $set: { paymentStatus: "paid" } });
    return { error: err.message };
  }
  const after = await Payment.findById(payment._id);
  const refunded = after.refundedCents || 0;
  const updated = await Model.findByIdAndUpdate(
    booking._id,
    { $set: { paymentStatus: refunded >= after.amountCents ? "refunded" : "partially_refunded" } },
    { new: true },
  );
  return { booking: updated, refundedCents: refunded };
}

/** Sweeper: cancelled bookings whose refund hasn't gone out yet (earlier Stripe error). */
export async function sweepBookingRefunds(Model, purpose) {
  const owed = await Model.find({ status: "cancelled", paymentStatus: "paid", refundCents: { $gt: 0 } })
    .select("_id")
    .limit(100)
    .lean();
  let settled = 0;
  for (const b of owed) {
    const r = await settleBookingRefund(Model, purpose, b._id).catch(() => null);
    if (r?.booking) settled += 1;
  }
  return settled;
}

export const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
