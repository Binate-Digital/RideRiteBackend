import { DriverEarning, EARNING_TYPES } from "../models/DriverEarning.js";
import { getSettings } from "./settings.js";

const OFFLINE_PAY = new Set(["cash", "venmo", "zelle"]);

/**
 * Driver's share of a ride. Commission is taken on the base fare (meter + booking fee) only:
 * the service fee and sales tax are platform revenue / pass-through, and promo discounts are
 * platform-funded, so they never reduce what the driver earns.
 */
export function tripEarningBreakdown(trip) {
  const grossCents = Math.max(0, Math.round(trip.baseFareCents || 0));
  const commissionCents = Math.round(grossCents * getSettings().commission.platformRate);
  return { grossCents, commissionCents, netCents: grossCents - commissionCents };
}

/** Insert once; a duplicate (same trip/booking + type) is the earlier entry. */
async function insertOnce(doc) {
  try {
    return await DriverEarning.create(doc);
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const key = doc.tripId
      ? { tripId: doc.tripId }
      : doc.chauffeurBookingId
        ? { chauffeurBookingId: doc.chauffeurBookingId }
        : doc.bonusId
          ? { bonusId: doc.bonusId }
          : { rentalBookingId: doc.rentalBookingId };
    return DriverEarning.findOne({ ...key, type: doc.type });
  }
}

/**
 * Completed trip → ledger. Card trips are owed to the driver (pending payout). Pay-on-pickup
 * trips: the driver already holds the whole fare, so the trip entry is `collected` and a
 * deduction of (fare − net) is what they owe back, netted against their next payout.
 */
export async function recordTripEarning(trip) {
  if (!trip?.driverId) return null;
  const { grossCents, commissionCents, netCents } = tripEarningBreakdown(trip);
  const offline = OFFLINE_PAY.has(trip.paymentMethod);
  const route = `${trip.pickupAddress} → ${trip.destinationAddress}`;
  const earnedAt = trip.completedAt || new Date();
  const entry = await insertOnce({
    driverId: trip.driverId,
    type: "trip",
    tripId: trip._id,
    grossCents,
    commissionCents,
    netCents,
    description: route,
    status: offline ? "collected" : "pending",
    earnedAt,
  });
  if (offline) {
    const owed = (trip.fareCents || 0) - netCents;
    if (owed > 0) {
      await insertOnce({
        driverId: trip.driverId,
        type: "deduction",
        tripId: trip._id,
        netCents: -owed,
        description: `${trip.paymentMethod} fare collected by driver (platform share)`,
        earnedAt,
      });
    }
  }
  return entry;
}

/** Late-cancel fee goes to the driver in full (TRD 4.7: fees compensate drivers). */
export async function recordCancellationFeeEarning(trip, feeCents) {
  if (!trip?.driverId || !(feeCents > 0)) return null;
  return insertOnce({
    driverId: trip.driverId,
    type: "cancellation_fee",
    tripId: trip._id,
    grossCents: feeCents,
    commissionCents: 0,
    netCents: feeCents,
    description: "Rider cancelled after you were en route",
  });
}

/** Peer-to-peer rental paid → owner's share is owed to them (fleet rentals: platform revenue). */
export async function recordRentalOwnerEarning(booking) {
  if (booking.source !== "peer") return null;
  const grossCents = booking.subtotalCents;
  return insertOnce({
    driverId: booking.ownerId,
    type: "rental",
    rentalBookingId: booking._id,
    grossCents,
    commissionCents: booking.commissionCents,
    netCents: grossCents - booking.commissionCents,
    description: `Rental ${new Date(booking.startDate).toISOString().slice(0, 10)} → ${new Date(booking.endDate).toISOString().slice(0, 10)}`,
  });
}

/**
 * A paid P2P rental was cancelled and the platform keeps `retainedCents` of the subtotal.
 * The owner's entry is rescaled to that amount (voided when nothing is kept). If it was
 * already swept into a payout, the difference becomes a deduction against the next one.
 */
export async function adjustRentalOwnerEarning(booking, retainedCents) {
  if (booking.source !== "peer") return null;
  const entry = await DriverEarning.findOne({ rentalBookingId: booking._id, type: "rental" });
  if (!entry || entry.status === "void") return null;
  const grossCents = Math.max(0, Math.min(retainedCents, booking.subtotalCents));
  const commissionCents = booking.subtotalCents
    ? Math.round((grossCents * booking.commissionCents) / booking.subtotalCents)
    : 0;
  const netCents = grossCents - commissionCents;
  if (entry.status === "pending") {
    // Conditional on still pending: a payout run claiming it meanwhile takes the deduction path
    const updated = await DriverEarning.findOneAndUpdate(
      { _id: entry._id, status: "pending" },
      grossCents > 0
        ? { $set: { grossCents, commissionCents, netCents, description: `${entry.description} (cancelled — partial)` } }
        : { $set: { status: "void", description: `${entry.description} (cancelled)` } },
      { new: true },
    );
    if (updated) return updated;
  }
  const owed = entry.netCents - netCents;
  if (owed <= 0) return entry;
  return insertOnce({
    driverId: entry.driverId,
    type: "deduction",
    rentalBookingId: booking._id,
    netCents: -owed,
    description: "Rental cancelled after payout — refunded share",
  });
}

/** Completed private-driver booking → the assigned driver's share is owed to them. */
export async function recordChauffeurEarning(booking) {
  if (!booking?.driverId) return null;
  const grossCents = Math.max(0, Math.round(booking.totalCents || 0));
  const commissionCents = Math.round(grossCents * getSettings().commission.chauffeurRate);
  return insertOnce({
    driverId: booking.driverId,
    type: "chauffeur",
    chauffeurBookingId: booking._id,
    grossCents,
    commissionCents,
    netCents: grossCents - commissionCents,
    description: `Private driver · ${booking.durationHours}h · ${booking.pickupAddress}`,
    earnedAt: booking.completedAt || new Date(),
  });
}

/** Admin-approved monthly bonus → owed to the driver with the next payout. */
export async function recordBonusEarning(bonus, description) {
  return insertOnce({
    driverId: bonus.userId,
    type: "bonus",
    bonusId: bonus._id,
    grossCents: bonus.giftCardCents,
    commissionCents: 0,
    netCents: bonus.giftCardCents,
    description,
  });
}

function startOfTodayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Driver earnings summary. "Earned" totals count what the driver made (trips net, fees,
 * rentals, chauffeur, bonuses, adjustments); deductions are listed separately and reduce the
 * payout balance, not the earnings. `byType` sums each ledger category (net), all time.
 */
export async function driverEarningsSummary(driverId, now = new Date()) {
  const entries = await DriverEarning.find({ driverId, status: { $ne: "void" } })
    .sort({ earnedAt: -1 })
    .limit(1000);
  const today = startOfTodayUtc(now).getTime();
  const weekAgo = now.getTime() - 7 * 86400000;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const totals = {
    todayCents: 0,
    weekCents: 0,
    monthCents: 0,
    allTimeCents: 0,
    commissionCents: 0,
    deductionsCents: 0,
    pendingPayoutCents: 0,
    paidOutCents: 0,
    byType: Object.fromEntries(EARNING_TYPES.map((t) => [t, 0])),
  };
  for (const e of entries) {
    const at = new Date(e.earnedAt).getTime();
    totals.byType[e.type] = (totals.byType[e.type] || 0) + e.netCents;
    if (e.type === "deduction") {
      totals.deductionsCents += -e.netCents;
    } else {
      totals.allTimeCents += e.netCents;
      if (at >= today) totals.todayCents += e.netCents;
      if (at >= weekAgo) totals.weekCents += e.netCents;
      if (at >= monthStart) totals.monthCents += e.netCents;
      totals.commissionCents += e.commissionCents || 0;
    }
    if (e.status === "pending" || e.status === "processing") totals.pendingPayoutCents += e.netCents;
    if (e.status === "paid") totals.paidOutCents += e.netCents;
  }
  return { totals, entries };
}
