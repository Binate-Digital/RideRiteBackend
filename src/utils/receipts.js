import { Payment } from "../models/Payment.js";
import { CHAUFFEUR_TIERS } from "./chauffeurBooking.js";

/**
 * In-app receipts for rentals and chauffeur bookings (TRD 4.12), built from the booking and its
 * card Payment (refunds included), so what the rider sees matches what Stripe charged and
 * refunded. Rides keep their own receipt (fare breakdown on the trip).
 */

const PAID = ["succeeded", "partially_refunded", "refunded"];

/** One status for history lists: what happened to the booking and its money. */
export function bookingDisplayStatus(b) {
  if (b.status === "pending_payment") return "pending_payment";
  if (b.status === "expired") return "expired";
  if (b.status === "cancelled") {
    if (b.paymentStatus === "refunded") return "refunded";
    if (b.paymentStatus === "partially_refunded") return "partially_refunded";
    if (b.paymentStatus === "refunding" || (b.paid && (b.refundCents || 0) > 0 && b.paymentStatus === "paid")) return "refund_pending";
    return "cancelled";
  }
  return b.status;
}

async function paymentFor(purpose, bookingId) {
  return Payment.findOne({ refId: bookingId, purpose, status: { $in: PAID } }).sort({ createdAt: -1 });
}

function moneyBlock(booking, payment) {
  const paidCents = booking.paid ? booking.totalCents : 0;
  const refunds = (payment?.refunds || []).map((r) => ({ amountCents: r.amountCents, createdAt: r.createdAt }));
  const refundedCents = payment ? payment.refundedCents || 0 : 0;
  // Refund owed but not settled yet (Stripe retry pending) is shown as pending
  const refundPendingCents = Math.max(0, (booking.refundCents || 0) - refundedCents);
  return {
    paidCents,
    refunds,
    refundedCents,
    refundPendingCents: booking.status === "cancelled" ? refundPendingCents : 0,
    netCents: paidCents - refundedCents,
    paymentMethod: payment ? (payment.provider === "mock" ? "Card (test mode)" : "Card") : booking.paid ? "Card" : null,
    paidAt: booking.paidAt,
  };
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);

export async function rentalReceipt(booking, listing) {
  const payment = booking.paid ? await paymentFor("rental", booking._id) : null;
  return {
    number: `RR-R-${booking._id.toString().slice(-8).toUpperCase()}`,
    kind: "rental",
    bookingId: booking._id.toString(),
    issuedAt: booking.paidAt || booking.createdAt,
    title: listing?.title || "Vehicle rental",
    subtitle: [listing?.city, listing?.state].filter(Boolean).join(", ") || null,
    status: bookingDisplayStatus(booking),
    details: [
      { label: "Pickup", value: ymd(booking.startDate) },
      { label: "Return", value: ymd(booking.endDate) },
      { label: "Days", value: String(booking.days) },
      { label: "Provided by", value: booking.source === "fleet" ? "RideRite fleet" : "Vehicle owner (peer-to-peer)" },
      ...(booking.handedOverAt ? [{ label: "Picked up", value: new Date(booking.handedOverAt).toISOString() }] : []),
      ...(booking.completedAt ? [{ label: "Completed", value: new Date(booking.completedAt).toISOString() }] : []),
      ...(booking.cancelledAt ? [{ label: "Cancelled", value: new Date(booking.cancelledAt).toISOString() }] : []),
    ],
    lines: [{ label: `${booking.days} day(s) × $${(booking.dailyRateCents / 100).toFixed(2)}`, cents: booking.subtotalCents }],
    totalCents: booking.totalCents,
    ...moneyBlock(booking, payment),
  };
}

export async function chauffeurReceipt(booking) {
  const payment = booking.paid ? await paymentFor("chauffeur", booking._id) : null;
  const tier = CHAUFFEUR_TIERS.find((t) => t.id === booking.tier);
  return {
    number: `RR-C-${booking._id.toString().slice(-8).toUpperCase()}`,
    kind: "chauffeur",
    bookingId: booking._id.toString(),
    issuedAt: booking.paidAt || booking.createdAt,
    title: `Private driver · ${tier?.label || booking.vehicleType.toUpperCase()}`,
    subtitle: booking.pickupAddress,
    status: bookingDisplayStatus(booking),
    details: [
      { label: "Start", value: new Date(booking.startAt).toISOString() },
      { label: "Duration", value: `${booking.durationHours} h` },
      ...(booking.completedAt ? [{ label: "Completed", value: new Date(booking.completedAt).toISOString() }] : []),
      ...(booking.cancelledAt ? [{ label: "Cancelled", value: new Date(booking.cancelledAt).toISOString() }] : []),
    ],
    lines: [
      {
        label: `${booking.durationHours} h × $${(booking.hourlyRateCents / 100).toFixed(2)}/h`,
        cents: booking.hourlyRateCents * booking.durationHours,
      },
    ],
    totalCents: booking.totalCents,
    ...moneyBlock(booking, payment),
  };
}
