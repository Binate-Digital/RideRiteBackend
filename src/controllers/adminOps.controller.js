import { z } from "zod";
import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { Trip, TRIP_STATUSES } from "../models/Trip.js";
import { Payment } from "../models/Payment.js";
import { RentalListing } from "../models/RentalListing.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { DriverBonus } from "../models/DriverBonus.js";
import { MaintenanceRecord } from "../models/MaintenanceRecord.js";
import { DriverEarning } from "../models/DriverEarning.js";
import { PromoCode } from "../models/PromoCode.js";
import { TripMessage } from "../models/TripMessage.js";
import { Dispute, DISPUTE_STATUSES } from "../models/Dispute.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { audit } from "../utils/audit.js";
import { hasPermission } from "../utils/permissions.js";
import { findTripPayment, refundPayment } from "../utils/refunds.js";
import { reviewBonus } from "../utils/bonus.js";
import {
  brief,
  dateFilter,
  escapeRegex,
  isObjectId,
  paged,
  parseDateRange,
  parsePaging,
  requireObjectId,
  userIdsMatching,
  usersById,
} from "../utils/adminQuery.js";
import { notifyUser } from "./notifications.controller.js";

/**
 * Admin operations: trips & disputes (TRD 6.4), rentals (6.5), chauffeur bookings, bonuses &
 * maintenance (6.7), cancellations (6.8) and promo codes. Lists are filtered and paginated
 * server-side; every write is audited.
 */

const ACTIVE_TRIP_STATUSES = ["requested", "accepted", "en_route", "arrived", "in_progress"];
const money = (c) => `$${((c || 0) / 100).toFixed(2)}`;

// ----------------------------------------------------------------------------- trips

/** GET /api/admin/trips?status=&from=&to=&q=&riderId=&driverId=&page=&limit= */
export const listTrips = asyncHandler(async (req, res) => {
  const status = String(req.query.status || "all");
  const q = String(req.query.q || "").trim();
  const filter = { ...dateFilter("createdAt", parseDateRange(req)) };
  if (status === "active") filter.status = { $in: ACTIVE_TRIP_STATUSES };
  else if (status === "disputed") filter._id = { $in: await Dispute.distinct("tripId") };
  else if (status !== "all") {
    if (!TRIP_STATUSES.includes(status)) throw httpError(400, "Unknown trip status");
    filter.status = status;
  }
  if (isObjectId(req.query.riderId)) filter.riderId = req.query.riderId;
  if (isObjectId(req.query.driverId)) filter.driverId = req.query.driverId;
  if (q) {
    if (isObjectId(q)) filter.$or = [{ _id: q }, { riderId: q }, { driverId: q }];
    else {
      const ids = await userIdsMatching(q);
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ riderId: { $in: ids } }, { driverId: { $in: ids } }, { pickupAddress: rx }, { destinationAddress: rx }];
    }
  }
  const paging = parsePaging(req, 25);
  const [total, trips] = await Promise.all([
    Trip.countDocuments(filter),
    Trip.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
  ]);
  const people = await usersById(trips.flatMap((t) => [t.riderId, t.driverId]));
  const disputed = new Set((await Dispute.distinct("tripId", { tripId: { $in: trips.map((t) => t._id) } })).map(String));
  res.json(
    paged(
      paging,
      total,
      "trips",
      trips.map((t) => ({
        id: t._id.toString(),
        status: t.status,
        pickupAddress: t.pickupAddress,
        destinationAddress: t.destinationAddress,
        vehicleType: t.vehicleType,
        paymentMethod: t.paymentMethod,
        paid: Boolean(t.paid),
        paymentStatus: t.paymentStatus,
        fareCents: t.fareCents,
        cancelFeeCents: t.cancelFeeCents ?? 0,
        refundCents: t.refundCents ?? 0,
        riderId: t.riderId?.toString() ?? null,
        driverId: t.driverId?.toString() ?? null,
        rider: brief(people, t.riderId),
        driver: brief(people, t.driverId),
        disputed: disputed.has(String(t._id)),
        createdAt: t.createdAt,
      })),
    ),
  );
});

function tripTimeline(t) {
  const steps = [
    ["created", t.createdAt],
    ["requested", t.requestedAt],
    ["paid", t.paidAt],
    ["dispatch started", t.dispatchStartedAt],
    ["accepted", t.acceptedAt],
    ["driver en route", t.enRouteAt],
    ["driver arrived", t.arrivedAt],
    ["trip started", t.startedAt],
    ["completed", t.completedAt],
    ["cancelled", t.cancelledAt],
    ["no drivers", t.noDriversAt],
  ];
  return steps.filter(([, at]) => at).map(([label, at]) => ({ label, at })).sort((a, b) => new Date(a.at) - new Date(b.at));
}

/** GET /api/admin/trips/:id — rider, driver, route, timeline, fare, payments / refunds, disputes */
export const getTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(requireObjectId(req.params.id));
  if (!trip) throw httpError(404, "Trip not found");
  const [people, profile, payments, earnings, disputes, messageCount] = await Promise.all([
    usersById([trip.riderId, trip.driverId]),
    trip.driverId ? DriverProfile.findOne({ userId: trip.driverId }).select("vehicleType vehicleMake vehicleModel vehicleColor vehiclePlate").lean() : null,
    Payment.find({ tripId: trip._id }).sort({ createdAt: 1 }),
    DriverEarning.find({ tripId: trip._id }).lean(),
    Dispute.find({ tripId: trip._id }).sort({ createdAt: -1 }),
    TripMessage.countDocuments({ tripId: trip._id }),
  ]);
  res.json({
    ok: true,
    trip: trip.toSafeJSON(),
    rider: brief(people, trip.riderId),
    driver: trip.driverId ? { ...brief(people, trip.driverId), vehicle: profile || null } : null,
    timeline: tripTimeline(trip),
    payments: payments.map((p) => p.toSafeJSON()),
    earnings: earnings.map((e) => ({ type: e.type, grossCents: e.grossCents, commissionCents: e.commissionCents, netCents: e.netCents, status: e.status })),
    disputes: disputes.map((d) => d.toSafeJSON()),
    chat: {
      messages: messageCount,
      // Transcript only for trips with a reported problem (GET /api/admin/trips/:id/chat)
      available: disputes.length > 0 && hasPermission(req.user, "trips:chat"),
    },
  });
});

/** GET /api/admin/trips/:id/chat — transcript, only for disputed trips (audited) */
export const getTripChat = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(requireObjectId(req.params.id)).select("riderId driverId");
  if (!trip) throw httpError(404, "Trip not found");
  if (!(await Dispute.exists({ tripId: trip._id }))) {
    throw httpError(403, "Chat transcripts are only available for trips with a reported problem", { code: "NO_DISPUTE" });
  }
  const rows = await TripMessage.find({ tripId: trip._id }).sort({ createdAt: 1 }).limit(500);
  await audit(req, "trip.chat.view", "Trip", trip._id, { messages: rows.length });
  res.json({
    ok: true,
    messages: rows.map((m) => ({
      ...m.toSafeJSON(),
      from: String(m.senderId) === String(trip.riderId) ? "rider" : String(m.senderId) === String(trip.driverId) ? "driver" : "other",
    })),
  });
});

/**
 * Refund part of a trip's card payment (capped at what is still refundable). Used by the trip
 * refund endpoint and dispute resolution. Returns { result, trip, payment, requested }.
 */
async function refundTripCore(trip, requested, reason) {
  if (!(requested > 0)) throw httpError(400, "refundCents must be a positive amount");
  const payment = trip.paid ? await findTripPayment(trip._id) : null;
  if (!payment) throw httpError(400, "This trip has no online payment to refund (unpaid or paid in cash)");
  if (payment.amountCents - (payment.refundedCents || 0) <= 0) throw httpError(400, "This trip's payment is already fully refunded");
  const result = await refundPayment(payment, requested, { reason });
  if (!result) throw httpError(400, "Nothing left to refund on this payment");
  const after = await Payment.findById(payment._id);
  trip.refundCents = after.refundedCents;
  trip.paymentStatus = after.refundedCents >= after.amountCents ? "refunded" : "partial_refund";
  await trip.save();
  return { result, trip, payment: after };
}

/**
 * PATCH /api/admin/trips/:id/refund — body: { refundCents, reason? }
 * Refunds through Stripe (simulated in mock mode), capped at what is still refundable on the
 * trip's card payment. Only trips paid online can be refunded.
 */
export const refundTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(requireObjectId(req.params.id));
  if (!trip) throw httpError(404, "Trip not found");
  const requested = Math.round(Number(req.body?.refundCents) || 0);
  const reason = String(req.body?.reason || "admin refund").slice(0, 200);
  const { result, payment } = await refundTripCore(trip, requested, reason);
  await audit(req, "trip.refund", "Trip", trip._id, {
    requestedCents: requested,
    refundedCents: result.amountCents,
    totalRefundedCents: payment.refundedCents,
    refundId: result.refundId,
    simulated: result.simulated,
    reason,
  });
  await notifyUser(trip.riderId, {
    category: "payment",
    title: "Refund issued",
    body: `${money(result.amountCents)} is on its way back to your card for your trip to ${trip.destinationAddress}.`,
    data: { tripId: trip._id.toString(), href: "/trips", refundCents: result.amountCents },
    email: true,
  });
  res.json({
    ok: true,
    refund: { ...result, capped: result.amountCents < requested },
    trip: trip.toSafeJSON(),
    payment: payment.toSafeJSON(),
  });
});

// ----------------------------------------------------------------------------- disputes

/** GET /api/admin/disputes?status=&q=&page= */
export const listDisputes = asyncHandler(async (req, res) => {
  const filter = {};
  const status = String(req.query.status || "all");
  if (status === "unresolved") filter.status = { $ne: "resolved" };
  else if (DISPUTE_STATUSES.includes(status)) filter.status = status;
  const q = String(req.query.q || "").trim();
  if (q) {
    if (isObjectId(q)) filter.$or = [{ _id: q }, { tripId: q }];
    else {
      const ids = await userIdsMatching(q);
      filter.$or = [{ riderId: { $in: ids } }, { driverId: { $in: ids } }];
    }
  }
  const paging = parsePaging(req);
  const [total, rows] = await Promise.all([
    Dispute.countDocuments(filter),
    Dispute.find(filter).sort({ status: 1, priority: -1, createdAt: -1 }).skip(paging.skip).limit(paging.limit),
  ]);
  const people = await usersById(rows.flatMap((d) => [d.riderId, d.driverId, d.assignedTo]));
  const trips = new Map(
    (await Trip.find({ _id: { $in: rows.map((d) => d.tripId) } }).select("pickupAddress destinationAddress fareCents status paid paymentMethod refundCents").lean()).map(
      (t) => [String(t._id), t],
    ),
  );
  res.json(
    paged(
      paging,
      total,
      "disputes",
      rows.map((d) => {
        const t = trips.get(String(d.tripId));
        return {
          ...d.toSafeJSON(),
          rider: brief(people, d.riderId),
          driver: brief(people, d.driverId),
          assignee: brief(people, d.assignedTo),
          trip: t
            ? {
                pickupAddress: t.pickupAddress,
                destinationAddress: t.destinationAddress,
                fareCents: t.fareCents,
                status: t.status,
                paidOnline: Boolean(t.paid) && !["cash", "venmo", "zelle"].includes(t.paymentMethod),
                refundCents: t.refundCents || 0,
              }
            : null,
        };
      }),
    ),
  );
});

const disputeUpdateSchema = z.object({
  status: z.enum(["open", "in_review", "resolved"]).optional(),
  resolutionNotes: z.string().trim().max(2000).optional(),
  driverNote: z.string().trim().max(1000).optional(),
  refundCents: z.number().int().min(0).optional(),
});

/**
 * PATCH /api/admin/disputes/:id — body: { status?, resolutionNotes?, driverNote?, refundCents? }
 * Resolving needs resolution notes; refundCents > 0 refunds the trip's card payment (needs the
 * trips:refund permission). The rider is notified on resolution, the driver when a note is sent.
 */
export const updateDispute = asyncHandler(async (req, res) => {
  const data = disputeUpdateSchema.parse(req.body || {});
  const dispute = await Dispute.findById(requireObjectId(req.params.id));
  if (!dispute) throw httpError(404, "Dispute not found");
  if (dispute.status === "resolved" && data.status !== "open") throw httpError(409, "This dispute is already resolved (reopen it first)");
  const from = dispute.status;
  if (data.resolutionNotes != null) dispute.resolutionNotes = data.resolutionNotes;
  if (data.driverNote != null) dispute.driverNote = data.driverNote;
  const resolving = data.status === "resolved";
  let refund = null;

  if (resolving) {
    if (!dispute.resolutionNotes) throw httpError(400, "Add resolution notes before resolving");
    if (data.refundCents > 0) {
      if (!dispute.tripId) throw httpError(400, "This complaint isn't linked to a trip — there is nothing to refund");
      if (!hasPermission(req.user, "trips:refund")) throw httpError(403, "Your admin role can't issue refunds (needs trips:refund)", { code: "FORBIDDEN_PERMISSION" });
      const trip = await Trip.findById(dispute.tripId);
      const out = await refundTripCore(trip, data.refundCents, `dispute ${dispute._id}`);
      refund = out.result;
      dispute.refundCents = (dispute.refundCents || 0) + refund.amountCents;
      dispute.refundId = refund.refundId;
      await audit(req, "trip.refund", "Trip", trip._id, {
        requestedCents: data.refundCents,
        refundedCents: refund.amountCents,
        refundId: refund.refundId,
        simulated: refund.simulated,
        disputeId: dispute._id.toString(),
      });
    }
    dispute.status = "resolved";
    dispute.resolvedAt = new Date();
    dispute.resolvedBy = req.user._id;
  } else if (data.status) {
    dispute.status = data.status;
    if (data.status === "in_review" && !dispute.assignedTo) dispute.assignedTo = req.user._id;
    if (data.status === "open") {
      dispute.resolvedAt = null;
      dispute.resolvedBy = null;
    }
  }
  await dispute.save();
  await audit(req, resolving ? "dispute.resolve" : "dispute.update", "Dispute", dispute._id, {
    tripId: dispute.tripId ? dispute.tripId.toString() : null,
    source: dispute.source || "trip",
    from,
    to: dispute.status,
    refundCents: refund?.amountCents || 0,
    driverNote: Boolean(dispute.driverNote),
  });

  if (resolving && !dispute.riderId && dispute.contact?.email) {
    // Public complaint from someone without (or not signed in to) an account: reply by email
    const { sendMail } = await import("../utils/mailer.js");
    await sendMail({
      to: dispute.contact.email,
      subject: "We've reviewed your RideRite complaint",
      text: `Hi ${dispute.contact.name || "there"},\n\n${dispute.resolutionNotes}\n\nRideRite Safety Team`,
    }).catch(() => {});
  }
  if (resolving && dispute.riderId) {
    await notifyUser(dispute.riderId, {
      category: "ride",
      title: "We've reviewed your report",
      body: `${dispute.resolutionNotes}${refund ? ` A refund of ${money(refund.amountCents)} is on its way to your card.` : ""}`.slice(0, 500),
      data: { tripId: dispute.tripId ? dispute.tripId.toString() : null, disputeId: dispute._id.toString(), href: "/trips" },
      email: true,
    });
    if (dispute.driverId && dispute.driverNote) {
      await notifyUser(dispute.driverId, {
        category: "system",
        title: "A note from RideRite about a recent trip",
        body: dispute.driverNote.slice(0, 500),
        data: { tripId: dispute.tripId ? dispute.tripId.toString() : null, href: "/driver" },
        email: true,
      });
    }
  }
  res.json({ ok: true, dispute: dispute.toSafeJSON(), refund });
});

// ----------------------------------------------------------------------------- rentals

/** GET /api/admin/rentals/listings?status=&source=&review=1&q=&page= */
export const listRentalListings = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== "all") filter.status = String(req.query.status);
  if (["peer", "fleet"].includes(String(req.query.source))) filter.source = req.query.source;
  // Review queue: new listings and approved ones whose price / details changed (Phase 4)
  if (req.query.review === "1") filter.status = "pending";
  const q = String(req.query.q || "").trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ title: rx }, { make: rx }, { model: rx }, { plate: rx }, { city: rx }, { ownerId: { $in: await userIdsMatching(q) } }];
  }
  const paging = parsePaging(req);
  const [total, rows] = await Promise.all([
    RentalListing.countDocuments(filter),
    RentalListing.find(filter).sort({ updatedAt: -1 }).skip(paging.skip).limit(paging.limit),
  ]);
  const owners = await usersById(rows.map((r) => r.ownerId));
  res.json(
    paged(paging, total, "listings", rows.map((r) => ({ ...r.toSafeJSON(), owner: brief(owners, r.ownerId) }))),
  );
});

/** PATCH /api/admin/rentals/listings/:id — body: { status?, dailyRateCents?, note? } (approve / pause / reject) */
export const updateRentalListing = asyncHandler(async (req, res) => {
  const row = await RentalListing.findById(requireObjectId(req.params.id));
  if (!row) throw httpError(404, "Listing not found");
  const from = { status: row.status, dailyRateCents: row.dailyRateCents };
  if (req.body?.status) {
    if (!["pending", "active", "paused", "rejected"].includes(req.body.status)) throw httpError(400, "Invalid listing status");
    row.status = req.body.status;
  }
  if (req.body?.dailyRateCents != null) {
    const rate = Math.round(Number(req.body.dailyRateCents));
    if (!Number.isFinite(rate) || rate < 1000) throw httpError(400, "dailyRateCents must be at least 1000 ($10)");
    row.dailyRateCents = rate;
  }
  const reviewReason = row.reviewReason;
  if (row.status === "active") {
    // Approved: this price is the new baseline for the owner's >50% re-review rule
    row.approvedDailyRateCents = row.dailyRateCents;
    row.reviewReason = null;
  }
  await row.save();
  await audit(req, "rental.listing.update", "RentalListing", row._id, {
    from,
    to: { status: row.status, dailyRateCents: row.dailyRateCents },
    reviewReason,
    note: req.body?.note || "",
  });
  if (row.source === "peer" && from.status !== row.status && ["active", "rejected", "paused"].includes(row.status)) {
    await notifyUser(row.ownerId, {
      category: "rental",
      title: row.status === "active" ? "Your listing is live" : row.status === "rejected" ? "Your listing wasn't approved" : "Your listing was paused",
      body: `${row.title}${req.body?.note ? ` — ${String(req.body.note).slice(0, 300)}` : ""}`,
      data: { href: "/rentals", listingId: row._id.toString() },
    });
  }
  res.json({ ok: true, listing: row.toSafeJSON() });
});

const fleetSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).optional().default(""),
  vehicleType: z.enum(["sedan", "suv", "truck"]),
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  year: z.number().int().min(1990).max(new Date().getFullYear() + 1),
  plate: z.string().trim().max(15).optional().default(""),
  color: z.string().trim().max(30).optional().default(""),
  city: z.string().trim().max(80).optional().default(""),
  state: z.string().trim().max(2).optional().default("FL"),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  dailyRateCents: z.number().int().min(1000).max(1_000_000),
  photos: z.array(z.string().trim().url().max(2000)).max(8).optional().default([]),
  status: z.enum(["active", "paused"]).optional().default("active"),
});

/** POST /api/admin/rentals/fleet — a company-owned fleet vehicle (live immediately unless paused) */
export const createFleetListing = asyncHandler(async (req, res) => {
  const data = fleetSchema.parse(req.body || {});
  const row = await RentalListing.create({
    ...data,
    plate: data.plate.toUpperCase(),
    state: (data.state || "FL").toUpperCase(),
    ownerId: req.user._id,
    source: "fleet",
    approvedDailyRateCents: data.dailyRateCents,
  });
  await audit(req, "rental.fleet.create", "RentalListing", row._id, { title: row.title, dailyRateCents: row.dailyRateCents });
  res.status(201).json({ ok: true, listing: row.toSafeJSON() });
});

/** PATCH /api/admin/rentals/fleet/:id — edit a fleet vehicle (any subset of the create fields) */
export const updateFleetListing = asyncHandler(async (req, res) => {
  const row = await RentalListing.findById(requireObjectId(req.params.id));
  if (!row || row.source !== "fleet") throw httpError(404, "Fleet vehicle not found");
  const data = fleetSchema.partial().parse(req.body || {});
  const before = { title: row.title, dailyRateCents: row.dailyRateCents, status: row.status };
  Object.assign(row, data);
  if (data.plate != null) row.plate = data.plate.toUpperCase();
  if (data.state != null) row.state = data.state.toUpperCase();
  if (data.dailyRateCents != null) row.approvedDailyRateCents = data.dailyRateCents;
  await row.save();
  await audit(req, "rental.fleet.update", "RentalListing", row._id, { before, changed: Object.keys(data) });
  res.json({ ok: true, listing: row.toSafeJSON() });
});

/** DELETE /api/admin/rentals/fleet/:id — only when no upcoming / active bookings hold it */
export const deleteFleetListing = asyncHandler(async (req, res) => {
  const row = await RentalListing.findById(requireObjectId(req.params.id));
  if (!row || row.source !== "fleet") throw httpError(404, "Fleet vehicle not found");
  const live = await RentalBooking.countDocuments({
    listingId: row._id,
    status: { $in: ["pending_payment", "confirmed", "active"] },
    endDate: { $gt: new Date() },
  });
  if (live) throw httpError(409, `This vehicle has ${live} upcoming or active booking(s) — pause it instead`, { code: "FLEET_IN_USE" });
  const hasHistory = await RentalBooking.exists({ listingId: row._id });
  if (hasHistory) {
    // Past bookings reference it: retire instead of deleting so receipts still resolve
    row.status = "rejected";
    row.reviewReason = "retired";
    await row.save();
  } else {
    await row.deleteOne();
  }
  await audit(req, "rental.fleet.delete", "RentalListing", row._id, { title: row.title, retired: Boolean(hasHistory) });
  res.json({ ok: true, deleted: !hasHistory, retired: Boolean(hasHistory) });
});

/** GET /api/admin/rentals/bookings?status=&source=&from=&to=&q=&page= */
export const listRentalBookings = asyncHandler(async (req, res) => {
  const filter = { ...dateFilter("createdAt", parseDateRange(req)) };
  if (req.query.status && req.query.status !== "all") filter.status = String(req.query.status);
  if (["peer", "fleet"].includes(String(req.query.source))) filter.source = req.query.source;
  const q = String(req.query.q || "").trim();
  if (q) {
    const ids = await userIdsMatching(q);
    filter.$or = [{ renterId: { $in: ids } }, { ownerId: { $in: ids } }];
  }
  const paging = parsePaging(req);
  const [total, rows, totals] = await Promise.all([
    RentalBooking.countDocuments(filter),
    RentalBooking.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
    RentalBooking.aggregate([
      { $match: { ...filter, paid: true } },
      { $group: { _id: "$source", total: { $sum: "$totalCents" }, commission: { $sum: "$commissionCents" }, refunds: { $sum: "$refundCents" } } },
    ]),
  ]);
  const people = await usersById(rows.flatMap((b) => [b.renterId, b.ownerId]));
  const listings = new Map(
    (await RentalListing.find({ _id: { $in: rows.map((b) => b.listingId) } }).select("title").lean()).map((l) => [String(l._id), l.title]),
  );
  res.json({
    ...paged(
      paging,
      total,
      "bookings",
      rows.map((b) => ({
        ...b.toSafeJSON(),
        listingTitle: listings.get(String(b.listingId)) || null,
        renter: brief(people, b.renterId),
        owner: b.source === "fleet" ? null : brief(people, b.ownerId),
        platformCents: b.source === "fleet" ? b.totalCents : b.commissionCents,
      })),
    ),
    totals: Object.fromEntries(totals.map((t) => [t._id, { totalCents: t.total, commissionCents: t.commission, refundCents: t.refunds }])),
  });
});

/** GET /api/admin/chauffeur?status=&from=&to=&q=&page= */
export const listChauffeur = asyncHandler(async (req, res) => {
  const filter = { ...dateFilter("startAt", parseDateRange(req)) };
  const status = String(req.query.status || "all");
  if (status === "active") filter.status = { $in: ["requested", "confirmed", "driver_assigned", "in_progress"] };
  else if (status !== "all") filter.status = status;
  const q = String(req.query.q || "").trim();
  if (q) {
    const ids = await userIdsMatching(q);
    filter.$or = [{ riderId: { $in: ids } }, { driverId: { $in: ids } }, { pickupAddress: new RegExp(escapeRegex(q), "i") }];
  }
  const paging = parsePaging(req);
  const [total, rows] = await Promise.all([
    ChauffeurBooking.countDocuments(filter),
    ChauffeurBooking.find(filter).sort({ startAt: -1 }).skip(paging.skip).limit(paging.limit),
  ]);
  const people = await usersById(rows.flatMap((b) => [b.riderId, b.driverId]));
  const commissions = new Map(
    (await DriverEarning.find({ chauffeurBookingId: { $in: rows.map((b) => b._id) }, type: "chauffeur" }).select("chauffeurBookingId commissionCents").lean()).map(
      (e) => [String(e.chauffeurBookingId), e.commissionCents],
    ),
  );
  res.json(
    paged(
      paging,
      total,
      "bookings",
      rows.map((b) => ({
        ...b.toSafeJSON(),
        rider: brief(people, b.riderId),
        driver: brief(people, b.driverId),
        commissionCents: commissions.get(String(b._id)) ?? null,
      })),
    ),
  );
});

// ----------------------------------------------------------------------------- bonuses & maintenance

/** GET /api/admin/bonuses?status=&month=&page= */
export const listBonuses = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== "all") filter.status = String(req.query.status);
  if (/^\d{4}-\d{2}$/.test(String(req.query.month || ""))) filter.monthKey = req.query.month;
  const paging = parsePaging(req);
  const [total, rows] = await Promise.all([
    DriverBonus.countDocuments(filter),
    DriverBonus.find(filter).sort({ monthKey: -1, createdAt: -1 }).skip(paging.skip).limit(paging.limit),
  ]);
  const people = await usersById(rows.map((r) => r.userId));
  res.json(
    paged(
      paging,
      total,
      "bonuses",
      rows.map((b) => {
        const u = brief(people, b.userId);
        return { ...b.toSafeJSON(), fullName: u?.fullName ?? null, email: u?.email ?? null };
      }),
    ),
  );
});

/**
 * PATCH /api/admin/bonuses/:id — body: { status: approved|rejected|disbursed, adminNotes?, giftCardCode? }
 * Phase 4 transitions (utils/bonus.js reviewBonus): approve credits the earnings ledger.
 */
export const updateBonus = asyncHandler(async (req, res) => {
  const before = await DriverBonus.findById(requireObjectId(req.params.id)).select("status").lean();
  const row = await reviewBonus(req.params.id, {
    status: req.body?.status,
    adminNotes: req.body?.adminNotes,
    giftCardCode: req.body?.giftCardCode,
    reviewerId: req.user._id,
  });
  await audit(req, `bonus.${req.body?.status || "update"}`, "DriverBonus", row._id, {
    driverId: row.userId.toString(),
    monthKey: row.monthKey,
    from: before?.status,
    to: row.status,
    giftCardCode: row.giftCardCode ? "set" : "",
    amountCents: row.giftCardCents,
  });
  if (req.body?.status === "rejected") {
    await notifyUser(row.userId, {
      category: "bonus",
      title: "Bonus not approved",
      body: `Your bonus for ${row.monthKey} wasn't approved${row.adminNotes ? `: ${row.adminNotes}` : "."}`,
      data: { href: "/driver", bonusId: row._id.toString() },
    });
  }
  res.json({ ok: true, bonus: row.toSafeJSON() });
});

/** GET /api/admin/maintenance?status=&type=&page= */
export const listMaintenance = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== "all") filter.status = String(req.query.status);
  if (req.query.type && req.query.type !== "all") filter.type = String(req.query.type);
  const paging = parsePaging(req);
  const [total, rows, spend] = await Promise.all([
    MaintenanceRecord.countDocuments(filter),
    MaintenanceRecord.find(filter).sort({ status: 1, dueAt: 1, createdAt: -1 }).skip(paging.skip).limit(paging.limit),
    MaintenanceRecord.aggregate([{ $match: { status: "completed" } }, { $group: { _id: "$type", cost: { $sum: "$costCents" }, count: { $sum: 1 } } }]),
  ]);
  const people = await usersById(rows.map((r) => r.userId));
  res.json({
    ...paged(
      paging,
      total,
      "records",
      rows.map((r) => {
        const u = brief(people, r.userId);
        return { ...r.toSafeJSON(), fullName: u?.fullName ?? null, email: u?.email ?? null };
      }),
    ),
    spend: Object.fromEntries(spend.map((s) => [s._id, { costCents: s.cost, count: s.count }])),
  });
});

/**
 * PATCH /api/admin/maintenance/:id — body: { status?, notes?, costCents?, scheduledFor?, completedAt? }
 * requested → scheduled → completed (or cancelled). Completing restarts that service's schedule.
 */
export const updateMaintenance = asyncHandler(async (req, res) => {
  const row = await MaintenanceRecord.findById(requireObjectId(req.params.id));
  if (!row) throw httpError(404, "Record not found");
  const from = row.status;
  const status = req.body?.status;
  if (status && status !== from) {
    const allowed = { scheduled: ["requested"], completed: ["requested", "scheduled"], cancelled: ["requested", "scheduled"], requested: ["scheduled", "cancelled"] }[status];
    if (!allowed) throw httpError(400, "Invalid maintenance status");
    if (!allowed.includes(from)) throw httpError(409, `A ${from} service can't be marked ${status}`);
    row.status = status;
    if (status === "completed") {
      const at = req.body?.completedAt ? new Date(req.body.completedAt) : new Date();
      row.completedAt = Number.isNaN(at.getTime()) ? new Date() : at;
    }
  }
  if (req.body?.notes != null) row.notes = String(req.body.notes).slice(0, 1000);
  if (req.body?.costCents != null) {
    const cost = Math.round(Number(req.body.costCents));
    if (!Number.isFinite(cost) || cost < 0) throw httpError(400, "costCents must be ≥ 0");
    row.costCents = cost;
  }
  if (req.body?.scheduledFor) {
    const at = new Date(req.body.scheduledFor);
    if (Number.isNaN(at.getTime())) throw httpError(400, "Invalid scheduledFor date");
    row.scheduledFor = at;
  }
  await row.save();
  await audit(req, "maintenance.update", "MaintenanceRecord", row._id, {
    driverId: row.userId.toString(),
    from,
    to: row.status,
    costCents: row.costCents,
  });
  if ((status === "scheduled" || status === "completed") && status !== from) {
    await notifyUser(row.userId, {
      category: "maintenance",
      title: status === "completed" ? `${row.title} — done` : `${row.title} — booked`,
      body:
        status === "completed"
          ? "Thanks — the service is recorded and your next one is now scheduled."
          : `Your covered service is booked${row.scheduledFor ? ` for ${row.scheduledFor.toLocaleDateString("en-US")}` : ""}.`,
      data: { href: "/driver", maintenanceId: row._id.toString() },
    });
  }
  res.json({ ok: true, record: row.toSafeJSON() });
});

// ----------------------------------------------------------------------------- cancellations

/** GET /api/admin/cancellations?kind=trips|rentals|chauffeur&by=&from=&to=&page= */
export const listCancellations = asyncHandler(async (req, res) => {
  const kind = String(req.query.kind || "trips");
  const by = String(req.query.by || "all");
  const range = parseDateRange(req);
  const paging = parsePaging(req, 25);
  const Model = kind === "rentals" ? RentalBooking : kind === "chauffeur" ? ChauffeurBooking : Trip;
  const filter = { status: "cancelled", ...dateFilter("cancelledAt", range) };
  if (by !== "all") filter.cancelledBy = by;
  const [total, rows, totals] = await Promise.all([
    Model.countDocuments(filter),
    Model.find(filter).sort({ cancelledAt: -1 }).skip(paging.skip).limit(paging.limit).lean(),
    Model.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          fees: { $sum: { $ifNull: ["$cancelFeeCents", 0] } },
          refunds: { $sum: { $ifNull: ["$refundCents", 0] } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);
  const people = await usersById(rows.flatMap((r) => [r.riderId, r.driverId, r.renterId, r.ownerId]));
  const out = rows.map((r) => {
    const base = {
      id: r._id.toString(),
      kind,
      cancelledAt: r.cancelledAt,
      cancelledBy: r.cancelledBy || null,
      reason: r.cancelReason || r.declineReason || null,
      refundCents: r.refundCents ?? 0,
      refundPercent: r.refundPercent ?? null,
      paymentStatus: r.paymentStatus,
    };
    if (kind === "trips") {
      return {
        ...base,
        fareCents: r.fareCents,
        feeCents: r.cancelFeeCents ?? 0,
        paidOnline: Boolean(r.paid),
        tripStatusAtCancel: r.acceptedAt ? (r.arrivedAt ? "driver arrived" : r.enRouteAt ? "driver en route" : "driver assigned") : "searching",
        rider: brief(people, r.riderId),
        driver: brief(people, r.driverId),
        summary: `${r.pickupAddress} → ${r.destinationAddress}`,
      };
    }
    const paid = r.paid ? r.totalCents : 0;
    return {
      ...base,
      fareCents: r.totalCents,
      feeCents: r.paid ? Math.max(0, paid - (r.refundCents || 0)) : 0,
      paidOnline: Boolean(r.paid),
      rider: brief(people, r.riderId || r.renterId),
      driver: brief(people, r.driverId || (r.source === "peer" ? r.ownerId : null)),
      summary: kind === "rentals" ? `${r.days} day rental` : `${r.durationHours}h · ${r.pickupAddress}`,
    };
  });
  const t = totals[0] || {};
  res.json({
    ...paged(paging, total, "cancellations", out),
    totals: { count: t.count || 0, feeCents: kind === "trips" ? t.fees || 0 : null, refundCents: t.refunds || 0 },
  });
});

// ----------------------------------------------------------------------------- promos

const promoSchema = z
  .object({
    code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only"),
    percentOff: z.number().min(1).max(100).nullable().optional(),
    amountOffCents: z.number().int().min(1).nullable().optional(),
    active: z.boolean().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    maxUses: z.number().int().min(1).nullable().optional(),
    /** Notify riders who opted in to promotions (in-app, email, push) */
    announce: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.percentOff) !== Boolean(d.amountOffCents), {
    message: "Set either percentOff or amountOffCents",
  });

/** GET /api/admin/promos?status=active|inactive|all&page= */
export const listPromos = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status === "active") filter.active = true;
  else if (req.query.status === "inactive") filter.active = false;
  const paging = parsePaging(req, 50);
  const [total, rows] = await Promise.all([
    PromoCode.countDocuments(filter),
    PromoCode.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
  ]);
  res.json(paged(paging, total, "promos", rows.map((p) => p.toSafeJSON())));
});

/** POST /api/admin/promos */
export const createPromo = asyncHandler(async (req, res) => {
  const data = promoSchema.parse(req.body || {});
  const code = data.code.toUpperCase();
  if (await PromoCode.exists({ code })) throw httpError(409, "Promo code already exists");
  const { announce, ...fields } = data;
  const promo = await PromoCode.create({ ...fields, code });
  await audit(req, "promo.create", "PromoCode", promo._id, { code, announce: Boolean(announce) });
  if (announce && promo.active !== false) void announcePromo(promo);
  res.status(201).json({ ok: true, promo: promo.toSafeJSON() });
});

/** Promo category notification to every rider who opted in (promo prefs default off). */
async function announcePromo(promo) {
  try {
    const off = promo.percentOff ? `${promo.percentOff}% off` : `${money(promo.amountOffCents)} off`;
    const riders = await User.find({ role: "rider", isActive: true, "notificationPrefs.promo": true })
      .select("_id")
      .limit(5000)
      .lean();
    for (const r of riders) {
      await notifyUser(r._id, {
        category: "promo",
        title: `${off} your next ride`,
        body: `Use code ${promo.code} at checkout${promo.expiresAt ? ` before ${new Date(promo.expiresAt).toLocaleDateString("en-US")}` : ""}.`,
        data: { href: "/ride", promoCode: promo.code },
        email: true,
      });
    }
  } catch (err) {
    console.error("[promo] announce failed:", err.message);
  }
}

/** PATCH /api/admin/promos/:id — body: { active?, expiresAt?, maxUses? } */
export const updatePromo = asyncHandler(async (req, res) => {
  const data = z
    .object({
      active: z.boolean().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      maxUses: z.number().int().min(1).nullable().optional(),
    })
    .parse(req.body || {});
  const promo = await PromoCode.findByIdAndUpdate(requireObjectId(req.params.id), data, { new: true });
  if (!promo) throw httpError(404, "Promo not found");
  await audit(req, "promo.update", "PromoCode", promo._id, { code: promo.code, ...data });
  res.json({ ok: true, promo: promo.toSafeJSON() });
});
