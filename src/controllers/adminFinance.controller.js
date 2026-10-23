import { z } from "zod";
import { Trip } from "../models/Trip.js";
import { Payment } from "../models/Payment.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { DriverSubscription } from "../models/DriverSubscription.js";
import { DriverEarning } from "../models/DriverEarning.js";
import { DriverPayout } from "../models/DriverPayout.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { audit } from "../utils/audit.js";
import { refundPayment, settleTripRefund } from "../utils/refunds.js";
import { settleBookingRefund } from "../utils/bookingRefunds.js";
import { runPayouts } from "../utils/payouts.js";
import { revenueSummary, subscriptionOverview } from "../utils/revenue.js";
import { brief, dateFilter, isObjectId, paged, parseDateRange, parsePaging, requireObjectId, userIdsMatching, usersById } from "../utils/adminQuery.js";
import { notifyUser } from "./notifications.controller.js";

/**
 * Admin finance (TRD 6.6 / 6.8): revenue by stream, driver payouts, refunds queue + manual
 * refunds, subscription transactions. Revenue definitions live in utils/revenue.js and are
 * shared with the dashboard.
 */

/** GET /api/admin/revenue?from=&to= */
export const revenue = asyncHandler(async (req, res) => {
  const range = parseDateRange(req);
  const [summary, subscriptions] = await Promise.all([revenueSummary(range), subscriptionOverview()]);
  // Back-compat field names used by older admin builds
  res.json({
    ok: true,
    ...summary,
    tripGrossCents: summary.rideFareCents,
    paidOnlineCents: summary.collectedCents,
    cancelFeeCents: summary.rideCancelFeeCents,
    subscriptionOverview: subscriptions,
  });
});

// ----------------------------------------------------------------------------- payouts

/**
 * POST /api/admin/payouts/run — body: { driverId? }
 * Transfers pending earnings to drivers' Stripe Connect accounts (simulated in mock mode and
 * for seeded acct_seedtest_* accounts).
 */
export const runDriverPayouts = asyncHandler(async (req, res) => {
  const driverId = req.body?.driverId ? String(req.body.driverId) : null;
  if (driverId && !isObjectId(driverId)) throw httpError(400, "Invalid driverId");
  const results = await runPayouts({ driverId, initiatedBy: req.user._id });
  const paid = results.filter((r) => r.payout?.status === "paid");
  await audit(req, "payouts.run", "DriverPayout", driverId || "all", {
    drivers: results.length,
    paid: paid.length,
    failed: results.filter((r) => r.error).length,
    skipped: results.filter((r) => r.skipped).length,
    totalCents: paid.reduce((a, r) => a + r.payout.amountCents, 0),
  });
  res.json({ ok: true, results });
});

/** GET /api/admin/payouts?driverId=&status=&from=&to=&page= — payout history */
export const listPayouts = asyncHandler(async (req, res) => {
  const filter = { ...dateFilter("createdAt", parseDateRange(req)) };
  if (isObjectId(req.query.driverId)) filter.driverId = req.query.driverId;
  if (["processing", "paid", "failed"].includes(String(req.query.status))) filter.status = req.query.status;
  const paging = parsePaging(req, 25);
  const [total, rows, pending] = await Promise.all([
    DriverPayout.countDocuments(filter),
    DriverPayout.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
    DriverEarning.aggregate([
      { $match: { status: "pending" } },
      { $group: { _id: null, total: { $sum: "$netCents" }, drivers: { $addToSet: "$driverId" } } },
    ]),
  ]);
  const people = await usersById(rows.map((r) => r.driverId));
  res.json({
    ...paged(
      paging,
      total,
      "payouts",
      rows.map((p) => {
        const u = brief(people, p.driverId);
        return { ...p.toSafeJSON(), fullName: u?.fullName ?? null, email: u?.email ?? null };
      }),
    ),
    pendingCents: pending[0]?.total ?? 0,
    pendingDrivers: pending[0]?.drivers?.length ?? 0,
  });
});

/** GET /api/admin/payouts/balances?q=&page= — per-driver pending balance (what the next run pays) */
export const payoutBalances = asyncHandler(async (req, res) => {
  const match = { status: "pending" };
  const q = String(req.query.q || "").trim();
  if (q) match.driverId = { $in: await userIdsMatching(q) };
  const paging = parsePaging(req, 25);
  const [rows, count] = await Promise.all([
    DriverEarning.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$driverId",
          pendingCents: { $sum: "$netCents" },
          entries: { $sum: 1 },
          oldest: { $min: "$earnedAt" },
        },
      },
      { $sort: { pendingCents: -1 } },
      { $skip: paging.skip },
      { $limit: paging.limit },
    ]),
    DriverEarning.aggregate([{ $match: match }, { $group: { _id: "$driverId" } }, { $count: "n" }]),
  ]);
  const ids = rows.map((r) => r._id);
  const [people, profiles, lastPayouts] = await Promise.all([
    usersById(ids),
    DriverProfile.find({ userId: { $in: ids } }).select("userId stripeConnectAccountId stripeConnectPayoutsEnabled").lean(),
    DriverPayout.aggregate([
      { $match: { driverId: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$driverId", at: { $first: "$createdAt" }, status: { $first: "$status" }, amountCents: { $first: "$amountCents" } } },
    ]),
  ]);
  const prof = new Map(profiles.map((p) => [String(p.userId), p]));
  const last = new Map(lastPayouts.map((p) => [String(p._id), p]));
  res.json(
    paged(
      paging,
      count[0]?.n ?? 0,
      "balances",
      rows.map((r) => {
        const p = prof.get(String(r._id));
        const l = last.get(String(r._id));
        return {
          driverId: String(r._id),
          driver: brief(people, r._id),
          pendingCents: r.pendingCents,
          entries: r.entries,
          oldestEarnedAt: r.oldest,
          connectReady: Boolean(p?.stripeConnectAccountId && p?.stripeConnectPayoutsEnabled),
          lastPayout: l ? { at: l.at, status: l.status, amountCents: l.amountCents } : null,
        };
      }),
    ),
  );
});

// ----------------------------------------------------------------------------- refunds

/**
 * GET /api/admin/refunds?state=pending|failed|issued&page=
 *   pending  refunds owed but not yet sent (trip refund_pending / refunding, cancelled paid bookings)
 *   failed   card payments that failed, and payouts whose transfer failed
 *   issued   refunds already sent (latest first)
 */
export const listRefunds = asyncHandler(async (req, res) => {
  const state = String(req.query.state || "pending");
  const paging = parsePaging(req, 25);
  if (state === "issued") {
    const [rows, count] = await Promise.all([
      Payment.aggregate([
        { $match: { "refunds.0": { $exists: true } } },
        { $unwind: "$refunds" },
        { $sort: { "refunds.createdAt": -1 } },
        { $skip: paging.skip },
        { $limit: paging.limit },
      ]),
      Payment.aggregate([{ $match: { "refunds.0": { $exists: true } } }, { $unwind: "$refunds" }, { $count: "n" }]),
    ]);
    const people = await usersById(rows.map((r) => r.userId));
    return res.json(
      paged(
        paging,
        count[0]?.n ?? 0,
        "refunds",
        rows.map((r) => ({
          paymentId: String(r._id),
          purpose: r.purpose,
          tripId: r.tripId ? String(r.tripId) : null,
          refId: r.refId ? String(r.refId) : null,
          user: brief(people, r.userId),
          paidCents: r.amountCents,
          refundedTotalCents: r.refundedCents,
          amountCents: r.refunds.amountCents,
          reason: r.refunds.reason,
          refundId: r.refunds.refundId,
          simulated: Boolean(r.refunds.simulated),
          createdAt: r.refunds.createdAt,
        })),
      ),
    );
  }
  if (state === "failed") {
    const [payments, payouts] = await Promise.all([
      Payment.find({ status: "failed" }).sort({ updatedAt: -1 }).limit(100).lean(),
      DriverPayout.find({ status: "failed" }).sort({ updatedAt: -1 }).limit(100).lean(),
    ]);
    const people = await usersById([...payments.map((p) => p.userId), ...payouts.map((p) => p.driverId)]);
    const items = [
      ...payments.map((p) => ({
        kind: "payment",
        id: String(p._id),
        purpose: p.purpose,
        user: brief(people, p.userId),
        amountCents: p.amountCents,
        reason: p.metadata?.failureMessage || p.metadata?.lastError || "Payment failed",
        at: p.updatedAt,
      })),
      ...payouts.map((p) => ({
        kind: "payout",
        id: String(p._id),
        purpose: "payout",
        user: brief(people, p.driverId),
        amountCents: p.amountCents,
        reason: p.failureReason || "Transfer failed",
        at: p.updatedAt,
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));
    return res.json({ ok: true, page: 1, limit: items.length, total: items.length, totalPages: 1, refunds: items });
  }
  // pending
  const [trips, rentals, chauffeur] = await Promise.all([
    Trip.find({ paymentStatus: { $in: ["refund_pending", "refunding"] } }).sort({ updatedAt: 1 }).limit(100).lean(),
    RentalBooking.find({ status: "cancelled", paymentStatus: { $in: ["paid", "refunding"] }, refundCents: { $gt: 0 } }).limit(100).lean(),
    ChauffeurBooking.find({ status: "cancelled", paymentStatus: { $in: ["paid", "refunding"] }, refundCents: { $gt: 0 } }).limit(100).lean(),
  ]);
  const people = await usersById([...trips.map((t) => t.riderId), ...rentals.map((b) => b.renterId), ...chauffeur.map((b) => b.riderId)]);
  const items = [
    ...trips.map((t) => ({
      kind: "trip",
      id: String(t._id),
      user: brief(people, t.riderId),
      amountCents: t.refundCents,
      paymentStatus: t.paymentStatus,
      summary: `${t.pickupAddress} → ${t.destinationAddress}`,
      at: t.cancelledAt || t.noDriversAt || t.updatedAt,
    })),
    ...rentals.map((b) => ({
      kind: "rental",
      id: String(b._id),
      user: brief(people, b.renterId),
      amountCents: b.refundCents,
      paymentStatus: b.paymentStatus,
      summary: `${b.days} day rental`,
      at: b.cancelledAt || b.updatedAt,
    })),
    ...chauffeur.map((b) => ({
      kind: "chauffeur",
      id: String(b._id),
      user: brief(people, b.riderId),
      amountCents: b.refundCents,
      paymentStatus: b.paymentStatus,
      summary: `${b.durationHours}h private driver`,
      at: b.cancelledAt || b.updatedAt,
    })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  res.json({ ok: true, page: 1, limit: items.length, total: items.length, totalPages: 1, refunds: items });
});

/** POST /api/admin/refunds/retry — body: { kind: trip|rental|chauffeur, id } — send an owed refund now */
export const retryRefund = asyncHandler(async (req, res) => {
  const kind = String(req.body?.kind || "");
  const id = requireObjectId(req.body?.id);
  let result;
  if (kind === "trip") result = await settleTripRefund(id, { reason: "admin retry" });
  else if (kind === "rental") result = await settleBookingRefund(RentalBooking, "rental", id);
  else if (kind === "chauffeur") result = await settleBookingRefund(ChauffeurBooking, "chauffeur", id);
  else throw httpError(400, "kind must be trip, rental or chauffeur");
  if (!result) throw httpError(409, "Nothing to retry — the refund isn't pending (or another run has it)");
  if (result.error) throw httpError(502, `Refund failed again: ${result.error}`);
  await audit(req, "refund.retry", kind === "trip" ? "Trip" : kind === "rental" ? "RentalBooking" : "ChauffeurBooking", id, {
    refundedCents: result.refundedCents ?? null,
  });
  res.json({ ok: true, result: { refundedCents: result.refundedCents ?? 0 } });
});

/** GET /api/admin/payments?q=&purpose=&status=&page= — payments to pick for a manual refund */
export const listPayments = asyncHandler(async (req, res) => {
  const filter = { ...dateFilter("createdAt", parseDateRange(req)) };
  if (["ride", "rental", "chauffeur", "subscription"].includes(String(req.query.purpose))) filter.purpose = req.query.purpose;
  else filter.purpose = { $ne: "setup_card" };
  if (req.query.status && req.query.status !== "all") filter.status = String(req.query.status);
  const q = String(req.query.q || "").trim();
  if (q) {
    if (isObjectId(q)) filter.$or = [{ _id: q }, { tripId: q }, { refId: q }, { userId: q }];
    else filter.userId = { $in: await userIdsMatching(q) };
  }
  const paging = parsePaging(req, 25);
  const [total, rows] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
  ]);
  const people = await usersById(rows.map((r) => r.userId));
  res.json(
    paged(
      paging,
      total,
      "payments",
      rows.map((p) => ({
        ...p.toSafeJSON(),
        user: brief(people, p.userId),
        refundableCents: ["succeeded", "partially_refunded"].includes(p.status) ? p.amountCents - (p.refundedCents || 0) : 0,
      })),
    ),
  );
});

const manualRefundSchema = z.object({
  paymentId: z.string(),
  amountCents: z.number().int().min(1),
  reason: z.string().trim().min(3).max(200),
});

/**
 * POST /api/admin/refunds — body: { paymentId, amountCents, reason }
 * Manual refund of any succeeded payment. The amount may not exceed what is still refundable
 * (paid − already refunded): a larger amount is rejected, not silently capped.
 */
export const manualRefund = asyncHandler(async (req, res) => {
  const data = manualRefundSchema.parse(req.body || {});
  const payment = await Payment.findById(requireObjectId(data.paymentId, "paymentId"));
  if (!payment) throw httpError(404, "Payment not found");
  if (!["succeeded", "partially_refunded"].includes(payment.status)) {
    throw httpError(400, `This payment is ${payment.status.replace("_", " ")} — nothing to refund`);
  }
  const refundable = payment.amountCents - (payment.refundedCents || 0);
  if (data.amountCents > refundable) {
    throw httpError(400, `At most $${(refundable / 100).toFixed(2)} can still be refunded on this payment`, {
      code: "REFUND_EXCEEDS_PAID",
      refundableCents: refundable,
    });
  }
  const result = await refundPayment(payment, data.amountCents, { reason: data.reason });
  if (!result) throw httpError(400, "Nothing left to refund on this payment");
  const after = await Payment.findById(payment._id);
  // Keep the trip / booking in step with its payment
  const fully = after.refundedCents >= after.amountCents;
  if (payment.purpose === "ride" && payment.tripId) {
    await Trip.updateOne(
      { _id: payment.tripId },
      { $set: { refundCents: after.refundedCents, paymentStatus: fully ? "refunded" : "partial_refund" } },
    );
  } else if (["rental", "chauffeur"].includes(payment.purpose) && payment.refId) {
    const Model = payment.purpose === "rental" ? RentalBooking : ChauffeurBooking;
    await Model.updateOne(
      { _id: payment.refId },
      { $set: { refundCents: after.refundedCents, paymentStatus: fully ? "refunded" : "partially_refunded" } },
    );
  }
  await audit(req, "refund.manual", "Payment", payment._id, {
    purpose: payment.purpose,
    tripId: payment.tripId ? String(payment.tripId) : null,
    refId: payment.refId ? String(payment.refId) : null,
    amountCents: result.amountCents,
    refundId: result.refundId,
    simulated: result.simulated,
    reason: data.reason,
  });
  await notifyUser(payment.userId, {
    category: "payment",
    title: "Refund issued",
    body: `$${(result.amountCents / 100).toFixed(2)} is on its way back to your card.`,
    data: { paymentId: payment._id.toString(), href: payment.purpose === "ride" ? "/trips" : "/notifications" },
    email: true,
  });
  res.json({ ok: true, refund: result, payment: after.toSafeJSON() });
});

// ----------------------------------------------------------------------------- subscriptions

/** GET /api/admin/subscriptions?status=&plan=&q=&page= */
export const listSubscriptions = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== "all") filter.status = String(req.query.status);
  if (["monthly", "weekly"].includes(String(req.query.plan))) filter.plan = req.query.plan;
  const q = String(req.query.q || "").trim();
  if (q) filter.userId = { $in: await userIdsMatching(q) };
  const paging = parsePaging(req, 25);
  const [total, rows, overview] = await Promise.all([
    DriverSubscription.countDocuments(filter),
    DriverSubscription.find(filter).sort({ updatedAt: -1 }).skip(paging.skip).limit(paging.limit),
    subscriptionOverview(),
  ]);
  const people = await usersById(rows.map((r) => r.userId));
  res.json({
    ...paged(
      paging,
      total,
      "subscriptions",
      rows.map((s) => {
        const u = brief(people, s.userId);
        return { ...s.toSafeJSON(), fullName: u?.fullName ?? null, email: u?.email ?? null };
      }),
    ),
    overview,
  });
});

/** GET /api/admin/subscriptions/transactions?status=&from=&to=&q=&page= — membership charges */
export const listSubscriptionTransactions = asyncHandler(async (req, res) => {
  const filter = { purpose: "subscription", ...dateFilter("createdAt", parseDateRange(req)) };
  if (req.query.status && req.query.status !== "all") filter.status = String(req.query.status);
  const q = String(req.query.q || "").trim();
  if (q) filter.userId = { $in: await userIdsMatching(q) };
  const paging = parsePaging(req, 25);
  const [total, rows, totals] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
    Payment.aggregate([
      { $match: { ...filter, status: { $in: ["succeeded", "partially_refunded", "refunded"] } } },
      { $group: { _id: null, gross: { $sum: "$amountCents" }, refunded: { $sum: "$refundedCents" } } },
    ]),
  ]);
  const people = await usersById(rows.map((r) => r.userId));
  res.json({
    ...paged(
      paging,
      total,
      "transactions",
      rows.map((p) => ({ ...p.toSafeJSON(), plan: p.metadata?.plan ?? null, user: brief(people, p.userId) })),
    ),
    totals: { grossCents: totals[0]?.gross ?? 0, refundedCents: totals[0]?.refunded ?? 0 },
  });
});

