import { Trip } from "../models/Trip.js";
import { Payment } from "../models/Payment.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { DriverEarning } from "../models/DriverEarning.js";
import { DriverSubscription } from "../models/DriverSubscription.js";

/**
 * Revenue definitions shared by the admin dashboard and revenue page (TRD 6.2 / 6.6), so the
 * two never disagree. All amounts in cents; `from` / `to` (optional Dates) bound each figure
 * by the date it was earned:
 *
 *  rideCommissionCents       platform commission on completed rides' base fare (earnings ledger)
 *  rideServiceFeeCents       rider service fee on completed rides (kept by the platform)
 *  rideDiscountCents         promo discounts on completed rides (platform-funded, subtracted)
 *  rentalCommissionCents     commission on completed peer-to-peer rentals (TRD 5.8)
 *  fleetRevenueCents         completed company-fleet rentals (100% platform)
 *  chauffeurCommissionCents  commission on completed chauffeur bookings (ledger)
 *  subscriptionRevenueCents  driver membership payments, net of their refunds
 *  bookingCancelRetainedCents  paid rental / chauffeur bookings cancelled late: paid − refunded
 *  rideCancelFeePlatformCents  ride late-cancel fees kept by the platform (Trip.cancelFeeRecipient)
 *  platformRevenueCents      sum of the above (commission − discounts + fees + subscriptions)
 *
 *  rideCancelFeeCents        all ride late-cancel fees collected from riders
 *  rideCancelFeeDriverCents  of which credited to drivers (legacy, before fees became platform revenue)
 *  collectedCents            every succeeded online payment (rides, rentals, chauffeur, memberships)
 *  refundedCents             refunds issued in the period
 *  payablePendingCents       driver earnings owed and not yet paid out (now, not ranged)
 */

function range(field, from, to) {
  if (!from && !to) return {};
  return { [field]: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } };
}

const sum = async (Model, match, expr) => {
  const [row] = await Model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: expr } } }]);
  return row?.total ?? 0;
};

const PAID_STATUSES = ["succeeded", "partially_refunded", "refunded"];

export async function revenueSummary({ from = null, to = null } = {}) {
  const [
    rides,
    rideCommissionCents,
    chauffeurCommissionCents,
    rentals,
    subscriptionRevenueCents,
    rideCancelFees,
    bookingCancelRetainedCents,
    collectedCents,
    refundedCents,
    payable,
    paidOutCents,
  ] = await Promise.all([
    Trip.aggregate([
      { $match: { status: "completed", ...range("completedAt", from, to) } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          fare: { $sum: "$fareCents" },
          serviceFee: { $sum: "$serviceFeeCents" },
          tax: { $sum: "$taxCents" },
          discount: { $sum: "$discountCents" },
        },
      },
    ]),
    sum(DriverEarning, { type: "trip", status: { $ne: "void" }, ...range("earnedAt", from, to) }, "$commissionCents"),
    sum(DriverEarning, { type: "chauffeur", status: { $ne: "void" }, ...range("earnedAt", from, to) }, "$commissionCents"),
    RentalBooking.aggregate([
      // Earned when the rental completes (owner share becomes payable at the same moment)
      { $match: { paid: true, status: "completed", ...range("completedAt", from, to) } },
      {
        $group: {
          _id: "$source",
          count: { $sum: 1 },
          total: { $sum: "$totalCents" },
          commission: { $sum: "$commissionCents" },
        },
      },
    ]),
    sum(
      Payment,
      { purpose: "subscription", status: { $in: PAID_STATUSES }, ...range("createdAt", from, to) },
      { $subtract: ["$amountCents", { $ifNull: ["$refundedCents", 0] }] },
    ),
    Trip.aggregate([
      { $match: { status: "cancelled", cancelFeeCents: { $gt: 0 }, ...range("cancelledAt", from, to) } },
      {
        $group: {
          _id: { $cond: [{ $eq: ["$cancelFeeRecipient", "platform"] }, "platform", "driver"] },
          total: { $sum: "$cancelFeeCents" },
        },
      },
    ]),
    Promise.all(
      [RentalBooking, ChauffeurBooking].map((M) =>
        sum(
          M,
          { status: "cancelled", paid: true, ...range("cancelledAt", from, to) },
          { $max: [0, { $subtract: ["$totalCents", { $ifNull: ["$refundCents", 0] }] }] },
        ),
      ),
    ).then(([a, b]) => a + b),
    sum(
      Payment,
      { purpose: { $ne: "setup_card" }, status: { $in: PAID_STATUSES }, ...range("createdAt", from, to) },
      "$amountCents",
    ),
    Payment.aggregate([
      { $match: { "refunds.0": { $exists: true } } },
      { $unwind: "$refunds" },
      { $match: range("refunds.createdAt", from, to) },
      { $group: { _id: null, total: { $sum: "$refunds.amountCents" } } },
    ]).then((r) => r[0]?.total ?? 0),
    DriverEarning.aggregate([
      { $match: { status: { $in: ["pending", "processing"] } } },
      { $group: { _id: "$status", total: { $sum: "$netCents" }, drivers: { $addToSet: "$driverId" } } },
    ]),
    sum(DriverEarning, { status: "paid", ...range("paidAt", from, to) }, "$netCents"),
  ]);

  const r = rides[0] || {};
  const peer = rentals.find((x) => x._id === "peer") || {};
  const fleet = rentals.find((x) => x._id === "fleet") || {};
  const pending = payable.find((p) => p._id === "pending") || {};
  const processing = payable.find((p) => p._id === "processing") || {};

  const out = {
    from,
    to,
    ridesCompleted: r.count ?? 0,
    rideFareCents: r.fare ?? 0,
    rideTaxCents: r.tax ?? 0,
    rideCommissionCents,
    rideServiceFeeCents: r.serviceFee ?? 0,
    rideDiscountCents: r.discount ?? 0,
    rentalCommissionCents: peer.commission ?? 0,
    rentalVolumeCents: (peer.total ?? 0) + (fleet.total ?? 0),
    peerRentalCount: peer.count ?? 0,
    fleetRevenueCents: fleet.total ?? 0,
    fleetRentalCount: fleet.count ?? 0,
    chauffeurCommissionCents,
    subscriptionRevenueCents,
    bookingCancelRetainedCents,
    rideCancelFeeCents: rideCancelFees.reduce((a, r) => a + r.total, 0),
    rideCancelFeePlatformCents: rideCancelFees.find((r) => r._id === "platform")?.total ?? 0,
    rideCancelFeeDriverCents: rideCancelFees.find((r) => r._id === "driver")?.total ?? 0,
    collectedCents,
    refundedCents,
    payablePendingCents: pending.total ?? 0,
    payablePendingDrivers: pending.drivers?.length ?? 0,
    payableProcessingCents: processing.total ?? 0,
    paidOutCents,
  };
  out.platformRevenueCents =
    out.rideCommissionCents +
    out.rideServiceFeeCents -
    out.rideDiscountCents +
    out.rentalCommissionCents +
    out.fleetRevenueCents +
    out.chauffeurCommissionCents +
    out.subscriptionRevenueCents +
    out.bookingCancelRetainedCents +
    out.rideCancelFeePlatformCents;
  return out;
}

/** Membership overview: counts by status and monthly recurring revenue of active plans. */
export async function subscriptionOverview() {
  const now = new Date();
  const rows = await DriverSubscription.aggregate([
    {
      $group: {
        _id: { status: "$status", plan: "$plan" },
        count: { $sum: 1 },
        amount: { $sum: "$amountCents" },
        live: {
          $sum: {
            $cond: [{ $and: [{ $eq: ["$status", "active"] }, { $gt: ["$currentPeriodEnd", now] }] }, 1, 0],
          },
        },
        liveAmount: {
          $sum: {
            $cond: [{ $and: [{ $eq: ["$status", "active"] }, { $gt: ["$currentPeriodEnd", now] }] }, "$amountCents", 0],
          },
        },
      },
    },
  ]);
  const byStatus = {};
  let mrrCents = 0;
  const byPlan = {};
  for (const r of rows) {
    byStatus[r._id.status] = (byStatus[r._id.status] || 0) + r.count;
    if (r._id.status === "active") {
      byPlan[r._id.plan] = (byPlan[r._id.plan] || 0) + r.live;
      // Weekly plans: 52 weeks / 12 months of revenue a month
      mrrCents += r._id.plan === "weekly" ? Math.round((r.liveAmount * 52) / 12) : r.liveAmount;
    }
  }
  return {
    active: byStatus.active || 0,
    pastDue: byStatus.past_due || 0,
    canceled: byStatus.canceled || 0,
    expired: byStatus.expired || 0,
    incomplete: byStatus.incomplete || 0,
    byPlan,
    mrrCents,
  };
}

/** Daily series for the dashboard trend chart: trips created / completed / cancelled, money collected. */
export async function dailyTrends(days = 7) {
  const n = Math.min(90, Math.max(1, Math.round(days)));
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (n - 1)));
  const day = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: "UTC" } });
  const [trips, payments, signups] = await Promise.all([
    Trip.aggregate([
      { $match: { createdAt: { $gte: start } } },
      {
        $group: {
          _id: day("$createdAt"),
          trips: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { createdAt: { $gte: start }, purpose: { $ne: "setup_card" }, status: { $in: PAID_STATUSES } } },
      { $group: { _id: day("$createdAt"), collectedCents: { $sum: "$amountCents" } } },
    ]),
    (async () => {
      const { User } = await import("../models/User.js");
      return User.aggregate([
        { $match: { createdAt: { $gte: start }, role: { $ne: "admin" } } },
        { $group: { _id: day("$createdAt"), signups: { $sum: 1 } } },
      ]);
    })(),
  ]);
  const t = new Map(trips.map((r) => [r._id, r]));
  const p = new Map(payments.map((r) => [r._id, r]));
  const s = new Map(signups.map((r) => [r._id, r]));
  const series = [];
  for (let i = 0; i < n; i += 1) {
    const key = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    series.push({
      date: key,
      trips: t.get(key)?.trips ?? 0,
      completed: t.get(key)?.completed ?? 0,
      cancelled: t.get(key)?.cancelled ?? 0,
      collectedCents: p.get(key)?.collectedCents ?? 0,
      signups: s.get(key)?.signups ?? 0,
    });
  }
  return series;
}
