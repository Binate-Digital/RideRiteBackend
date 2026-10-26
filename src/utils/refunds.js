import crypto from "node:crypto";
import { Payment } from "../models/Payment.js";
import { Trip } from "../models/Trip.js";
import { getStripe, isStripeMock } from "../lib/stripe.js";
import { httpError } from "../middleware/errorHandler.js";

/** Payments that never touched Stripe (mock mode / mock intents) get simulated refunds. */
function isSimulatedPayment(payment) {
  return (
    isStripeMock() ||
    payment.provider !== "stripe" ||
    !payment.stripePaymentIntentId ||
    payment.stripePaymentIntentId.startsWith("pi_mock_")
  );
}

/**
 * Refund up to `amountCents` of a succeeded payment (capped at what is still refundable).
 * The amount is reserved on the Payment with a conditional update first, so two concurrent
 * refunds can never exceed the amount paid; a Stripe failure releases the reservation.
 * Returns { refundId, amountCents, simulated } or null when nothing is refundable.
 */
export async function refundPayment(payment, amountCents, { reason = "requested_by_customer" } = {}) {
  const fresh = await Payment.findById(payment._id);
  if (!fresh || !["succeeded", "partially_refunded"].includes(fresh.status)) return null;
  const refundable = fresh.amountCents - (fresh.refundedCents || 0);
  const amount = Math.min(Math.max(0, Math.round(amountCents)), refundable);
  if (amount <= 0) return null;

  const reserved = await Payment.findOneAndUpdate(
    { _id: fresh._id, refundedCents: fresh.refundedCents || 0 },
    { $inc: { refundedCents: amount } },
    { new: true },
  );
  if (!reserved) throw httpError(409, "Another refund is in progress for this payment — try again");

  const simulated = isSimulatedPayment(fresh);
  let refundId;
  try {
    if (simulated) {
      refundId = `re_mock_${crypto.randomBytes(10).toString("hex")}`;
    } else {
      const refund = await getStripe().refunds.create(
        {
          payment_intent: fresh.stripePaymentIntentId,
          amount,
          reason: ["duplicate", "fraudulent", "requested_by_customer"].includes(reason)
            ? reason
            : "requested_by_customer",
          metadata: {
            app: "riderite",
            paymentId: fresh._id.toString(),
            purpose: fresh.purpose,
            userId: String(fresh.userId),
            ...(fresh.tripId ? { tripId: String(fresh.tripId) } : {}),
            ...(fresh.refId ? { [fresh.purpose === "rental" ? "rentalBookingId" : fresh.purpose === "chauffeur" ? "chauffeurBookingId" : "refId"]: String(fresh.refId) } : {}),
            note: String(reason).slice(0, 200),
          },
        },
        // Same payment + same running total → Stripe returns the same refund on a retry
        { idempotencyKey: `refund_${fresh._id}_${fresh.refundedCents || 0}_${amount}` },
      );
      refundId = refund.id;
    }
  } catch (err) {
    await Payment.updateOne({ _id: fresh._id }, { $inc: { refundedCents: -amount } });
    throw err;
  }

  const fullyRefunded = reserved.refundedCents >= reserved.amountCents;
  await Payment.updateOne(
    { _id: fresh._id },
    {
      $set: { status: fullyRefunded ? "refunded" : "partially_refunded" },
      $push: { refunds: { refundId, amountCents: amount, reason, simulated, createdAt: new Date() } },
    },
  );
  return { refundId, amountCents: amount, simulated };
}

/** The succeeded card payment behind a trip (latest first). */
export function findTripPayment(tripId) {
  return Payment.findOne({
    tripId,
    purpose: "ride",
    status: { $in: ["succeeded", "partially_refunded", "refunded"] },
  }).sort({ createdAt: -1 });
}

/**
 * Bring a trip's refunds up to `trip.refundCents` (the amount owed back to the rider).
 * Used by rider cancel, the no-drivers path and the sweeper; safe to call repeatedly.
 *
 * The trip is claimed first (refund_pending → refunding) so a concurrent settle, or a rider
 * re-requesting a no-drivers trip (which needs refund_pending), can't interleave with the
 * Stripe call. On a Stripe error it goes back to `refund_pending` for the sweeper to retry.
 */
export async function settleTripRefund(tripOrId, { reason = "requested_by_customer" } = {}) {
  // (an ObjectId also has `_id`, so test for a loaded document instead)
  const tripId = tripOrId?.riderId ? tripOrId._id : tripOrId;
  const trip = await Trip.findOneAndUpdate(
    { _id: tripId, paymentStatus: "refund_pending" },
    { $set: { paymentStatus: "refunding" } },
    { new: true },
  );
  if (!trip) return null; // nothing owed, or another settle has it
  const payment = await findTripPayment(trip._id);
  if (!payment) {
    // Nothing was charged online — nothing to send back
    const updated = await Trip.findOneAndUpdate({ _id: trip._id }, { $set: { paymentStatus: "refunded" } }, { new: true });
    return { trip: updated, refund: null, refundedCents: 0 };
  }
  const owed = Math.min(trip.refundCents || 0, payment.amountCents);
  const missing = owed - (payment.refundedCents || 0);
  let result = null;
  try {
    if (missing > 0) result = await refundPayment(payment, missing, { reason });
  } catch (err) {
    console.error(`[refunds] trip ${trip._id} refund failed:`, err.message);
    await Trip.updateOne({ _id: trip._id }, { $set: { paymentStatus: "refund_pending" } });
    return { error: err.message };
  }
  const after = await Payment.findById(payment._id);
  const refunded = after.refundedCents || 0;
  const paymentStatus =
    refunded <= 0 ? "paid" : refunded >= after.amountCents ? "refunded" : "partial_refund";
  const updated = await Trip.findOneAndUpdate(
    { _id: trip._id },
    { $set: { paymentStatus } },
    { new: true },
  );
  if (result?.amountCents > 0) {
    try {
      const { notifyUser } = await import("../controllers/notifications.controller.js");
      await notifyUser(trip.riderId, {
        category: "payment",
        title: "Refund issued",
        body: `$${(result.amountCents / 100).toFixed(2)} is on its way back to your card (${trip.status === "no_drivers" ? "no driver was available" : "ride cancelled"}).`,
        data: { tripId: trip._id.toString(), href: "/trips", refundCents: result.amountCents },
        email: true,
      });
    } catch {
      /* non-fatal */
    }
  }
  return { trip: updated, refund: result, refundedCents: refunded };
}
