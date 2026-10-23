import mongoose from "mongoose";
import { DriverBonus } from "../models/DriverBonus.js";
import { DriverEarning } from "../models/DriverEarning.js";
import { Trip } from "../models/Trip.js";
import { httpError } from "../middleware/errorHandler.js";
import { recordBonusEarning } from "./earnings.js";
import { getSettings } from "./settings.js";

/**
 * Monthly driver bonus (TRD 5.5), computed from the driver's real trips in a UTC month.
 *
 *  on-time trip      arrivedAt − acceptedAt ≤ quotedPickupEtaMinutes + BONUS_ONTIME_GRACE_MINUTES
 *                    (the ETA is stored on the trip when the driver accepts). Trips without a
 *                    quoted ETA or an arrival (older trips) are left out of the rate.
 *  incidents         rider complaints — there is no complaint model yet, so each completed
 *                    trip the rider rated 1 or 2 stars counts as one incident.
 *  safe-driving      100 − 15 × incidents − 5 × driver cancellations
 *  score             − (average rating below 4.5 ? round((4.5 − average) × 20) : 0), floored at 0.
 *                    e.g. 1 incident, 0 cancellations, 4.3 average → 100 − 15 − 4 = 81.
 *  eligible          trips ≥ BONUS_MIN_TRIPS, on-time rate ≥ BONUS_MIN_ONTIME_RATE and
 *                    safe-driving score ≥ BONUS_MIN_SAFE_SCORE.
 *
 * The current month is recomputed whenever the driver views it and nightly. Once a month
 * has ended the nightly sweep freezes it: eligible → `pending_review` (a BONUS_AMOUNT_CENTS
 * bonus for admin approval), otherwise `ineligible`. Approval credits a `bonus` entry to the
 * earnings ledger, paid with the next payout; a gift-card code can be recorded as well.
 */

export const SAFE_SCORE_RULES = {
  incidentPenalty: 15,
  cancellationPenalty: 5,
  ratingFloor: 4.5,
  ratingPenaltyPerStar: 20,
};

export function monthKeyOf(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthRange(key) {
  const [y, m] = key.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export function monthLabel(key) {
  const { start } = monthRange(key);
  return start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function bonusThresholds() {
  // Admin settings (utils/settings.js), defaulting to the BONUS_* env
  const b = getSettings().bonus;
  return {
    minTrips: b.minTrips,
    minOnTimeRate: b.minOnTimeRate,
    minSafeScore: b.minSafeScore,
    onTimeGraceMinutes: b.onTimeGraceMinutes,
    amountCents: b.amountCents,
  };
}

export function safeDrivingScore({ incidents, driverCancellations, averageRating }) {
  const r = SAFE_SCORE_RULES;
  const ratingPenalty =
    averageRating != null && averageRating < r.ratingFloor
      ? Math.round((r.ratingFloor - averageRating) * r.ratingPenaltyPerStar)
      : 0;
  return Math.max(0, 100 - r.incidentPenalty * incidents - r.cancellationPenalty * driverCancellations - ratingPenalty);
}

/** Metrics for one driver and month, straight from trips. */
export async function computeMonthMetrics(driverId, key) {
  const { start, end } = monthRange(key);
  const id = new mongoose.Types.ObjectId(String(driverId));
  const [completed, driverCancellations] = await Promise.all([
    Trip.find({ driverId: id, status: "completed", completedAt: { $gte: start, $lt: end } })
      .select("acceptedAt arrivedAt quotedPickupEtaMinutes riderRating")
      .lean(),
    Trip.countDocuments({ driverId: id, status: "cancelled", cancelledBy: "driver", cancelledAt: { $gte: start, $lt: end } }),
  ]);
  const grace = getSettings().bonus.onTimeGraceMinutes;
  let measuredTrips = 0;
  let onTimeTrips = 0;
  let ratingSum = 0;
  let ratedTrips = 0;
  let incidents = 0;
  for (const t of completed) {
    if (t.acceptedAt && t.arrivedAt && t.quotedPickupEtaMinutes != null) {
      measuredTrips += 1;
      const minutes = (new Date(t.arrivedAt) - new Date(t.acceptedAt)) / 60000;
      if (minutes <= t.quotedPickupEtaMinutes + grace) onTimeTrips += 1;
    }
    if (t.riderRating) {
      ratedTrips += 1;
      ratingSum += t.riderRating;
      if (t.riderRating <= 2) incidents += 1;
    }
  }
  const averageRating = ratedTrips ? Math.round((ratingSum / ratedTrips) * 100) / 100 : null;
  const metrics = {
    tripsCompleted: completed.length,
    measuredTrips,
    onTimeTrips,
    onTimeRate: measuredTrips ? onTimeTrips / measuredTrips : 0,
    driverCancellations,
    ratedTrips,
    averageRating,
    incidents,
  };
  metrics.safeDrivingScore = safeDrivingScore(metrics);
  const th = bonusThresholds();
  metrics.eligible =
    metrics.tripsCompleted >= th.minTrips &&
    metrics.onTimeRate >= th.minOnTimeRate &&
    metrics.safeDrivingScore >= th.minSafeScore;
  return metrics;
}

/** Records written before Phase 4 were frozen on first view; anything unreviewed is recomputable. */
function recomputable(row) {
  return !row || (!row.frozenAt && !row.reviewedAt && !row.earningId);
}

/** Current (or any open) month: recompute and store. Frozen / reviewed months are returned as-is. */
export async function refreshMonth(driverId, key = monthKeyOf()) {
  const existing = await DriverBonus.findOne({ userId: driverId, monthKey: key });
  if (!recomputable(existing)) return existing;
  const metrics = await computeMonthMetrics(driverId, key);
  return DriverBonus.findOneAndUpdate(
    { userId: driverId, monthKey: key, frozenAt: null, reviewedAt: null },
    {
      $set: {
        ...metrics,
        thresholds: bonusThresholds(),
        giftCardCents: getSettings().bonus.amountCents,
        status: "in_progress",
        computedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch(async (err) => {
    // Lost an upsert race with a concurrent view: the other write is just as fresh
    if (err?.code === 11000) return DriverBonus.findOne({ userId: driverId, monthKey: key });
    throw err;
  });
}

async function notify(userId, payload) {
  const { notifyUser } = await import("../controllers/notifications.controller.js");
  return notifyUser(userId, payload);
}

/** Close a finished month for one driver: final metrics, then pending_review or ineligible. */
export async function freezeMonth(driverId, key) {
  const existing = await DriverBonus.findOne({ userId: driverId, monthKey: key });
  if (!recomputable(existing)) return existing;
  const metrics = await computeMonthMetrics(driverId, key);
  const status = metrics.eligible ? "pending_review" : "ineligible";
  // Only the call whose write actually froze the month notifies (concurrent sweeps race here)
  let froze = true;
  const row = await DriverBonus.findOneAndUpdate(
    { userId: driverId, monthKey: key, frozenAt: null, reviewedAt: null },
    {
      $set: {
        ...metrics,
        thresholds: bonusThresholds(),
        giftCardCents: getSettings().bonus.amountCents,
        status,
        computedAt: new Date(),
        frozenAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch(async (err) => {
    if (err?.code !== 11000) throw err;
    froze = false;
    return DriverBonus.findOne({ userId: driverId, monthKey: key });
  });
  if (froze && row?.status === "pending_review") {
    await notify(driverId, {
      category: "bonus",
      title: `You qualified for the ${monthLabel(key)} bonus`,
      body: `${metrics.tripsCompleted} trips, ${Math.round(metrics.onTimeRate * 100)}% on time, safe-driving score ${metrics.safeDrivingScore}. Your $${(getSettings().bonus.amountCents / 100).toFixed(0)} bonus is waiting for admin approval.`,
      data: { href: "/driver", monthKey: key, bonusId: row._id.toString() },
      email: true,
    });
  }
  return row;
}

/**
 * Nightly: refresh every active driver's current month, and freeze every ended month that is
 * still open (last month's drivers with trips, plus any earlier unfrozen rows).
 */
export async function sweepBonuses(now = new Date()) {
  const current = monthKeyOf(now);
  const { start: currentStart } = monthRange(current);
  const prevKey = monthKeyOf(new Date(currentStart.getTime() - 86400000));
  const { start: prevStart } = monthRange(prevKey);

  const [activeNow, activeLastMonth, openRows] = await Promise.all([
    Trip.distinct("driverId", { driverId: { $ne: null }, completedAt: { $gte: currentStart } }),
    Trip.distinct("driverId", { driverId: { $ne: null }, completedAt: { $gte: prevStart, $lt: currentStart } }),
    DriverBonus.find({ frozenAt: null, reviewedAt: null, monthKey: { $lt: current } }).select("userId monthKey").lean(),
  ]);
  let frozen = 0;
  const toFreeze = new Map();
  for (const id of activeLastMonth) toFreeze.set(`${id}|${prevKey}`, [id, prevKey]);
  for (const r of openRows) toFreeze.set(`${r.userId}|${r.monthKey}`, [r.userId, r.monthKey]);
  for (const [id, key] of toFreeze.values()) {
    await freezeMonth(id, key);
    frozen += 1;
  }
  for (const id of activeNow) await refreshMonth(id, current);
  return { frozen, refreshed: activeNow.length };
}

/**
 * Admin decision (TRD 5.5 "approved by the admin before disbursement"):
 *   approved  (from pending_review / rejected) → `bonus` ledger entry, paid with the next payout
 *   rejected  (from pending_review / approved) → an unpaid ledger entry is voided
 *   disbursed (from approved) → the gift card was sent; giftCardCode records it
 */
export async function reviewBonus(id, { status, adminNotes, giftCardCode, reviewerId = null }) {
  const row = await DriverBonus.findById(id);
  if (!row) throw httpError(404, "Bonus not found");
  if (adminNotes != null) row.adminNotes = String(adminNotes);
  if (giftCardCode != null) row.giftCardCode = String(giftCardCode).trim().slice(0, 120);

  if (status && status !== row.status) {
    const from = row.status;
    const allowed = {
      approved: ["pending_review", "rejected"],
      rejected: ["pending_review", "approved"],
      disbursed: ["approved"],
    }[status];
    if (!allowed) throw httpError(400, "status must be approved, rejected or disbursed");
    if (!allowed.includes(from)) throw httpError(409, `A ${from.replace("_", " ")} bonus can't be ${status}`);

    if (status === "approved") {
      row.status = "approved";
      row.reviewedAt = new Date();
      row.reviewedBy = reviewerId;
      const entry = await recordBonusEarning(row, `Monthly bonus — ${monthLabel(row.monthKey)}`);
      if (entry.status === "void") {
        // Re-approved after a rejection: revive the voided entry
        entry.status = "pending";
        await entry.save();
      }
      row.earningId = entry._id;
      await row.save();
      await notify(row.userId, {
        category: "bonus",
        title: "Bonus approved",
        body: `Your ${monthLabel(row.monthKey)} bonus of $${(row.giftCardCents / 100).toFixed(2)} will be paid with your next payout.`,
        data: { href: "/driver", bonusId: row._id.toString() },
        email: true,
      });
      return row;
    }
    if (status === "rejected") {
      if (row.earningId) {
        const voided = await DriverEarning.findOneAndUpdate(
          { _id: row.earningId, status: "pending" },
          { $set: { status: "void" } },
        );
        if (!voided && (await DriverEarning.exists({ _id: row.earningId, status: { $in: ["processing", "paid"] } }))) {
          throw httpError(409, "This bonus was already paid out");
        }
      }
      row.status = "rejected";
      row.reviewedAt = new Date();
      row.reviewedBy = reviewerId;
    }
    if (status === "disbursed") {
      row.status = "disbursed";
      row.disbursedAt = new Date();
    }
  }
  await row.save();
  return row;
}
