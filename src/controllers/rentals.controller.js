import { RentalListing } from "../models/RentalListing.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { isStripeMock } from "../lib/stripe.js";
import { createCheckoutIntent, retrieveIntentStatus } from "../utils/checkout.js";
import {
  bookedDaysForListing,
  cancelPaidRental,
  confirmRentalPaid,
  dayKey,
  declineRentalByOwner,
  ownerDeclineDeadline,
  ownerPayoutCents,
  expireRentalHold,
  listingsBookedBetween,
  quoteRental,
  releaseRentalDays,
  rentalCancelQuote,
  reserveRentalDays,
  toUtcDay,
} from "../utils/rentalBooking.js";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VEHICLE_TYPES = ["sedan", "suv", "truck"];

const FLEET_SEED = [
  {
    title: "Tesla Model 3 Long Range",
    make: "Tesla",
    model: "Model 3",
    year: 2025,
    vehicleType: "sedan",
    dailyRateCents: 8900,
    city: "Miami",
    state: "FL",
    photos: ["https://images.unsplash.com/photo-1560958089-b8a1929cea89?auto=format&fit=crop&w=800&q=80"],
  },
  {
    title: "Cadillac Escalade Platinum",
    make: "Cadillac",
    model: "Escalade",
    year: 2025,
    vehicleType: "suv",
    dailyRateCents: 18500,
    city: "Orlando",
    state: "FL",
    photos: ["https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=800&q=80"],
  },
  {
    title: "Ford F-150 Lightning",
    make: "Ford",
    model: "F-150 Lightning",
    year: 2024,
    vehicleType: "truck",
    dailyRateCents: 12500,
    city: "Jacksonville",
    state: "FL",
    photos: ["https://images.unsplash.com/photo-1605893477799-b99e3b8b93fe?auto=format&fit=crop&w=800&q=80"],
  },
];

async function ensureFleetSeed() {
  const fleetCount = await RentalListing.countDocuments({ source: "fleet" });
  if (fleetCount > 0) return;
  const { User } = await import("../models/User.js");
  let admin = await User.findOne({ role: "admin" });
  if (!admin) admin = await User.findOne().sort({ createdAt: 1 });
  if (!admin) return;
  await RentalListing.insertMany(
    FLEET_SEED.map((f) => ({
      ...f,
      ownerId: admin._id,
      source: "fleet",
      status: "active",
      description: "RideRite platform fleet vehicle",
      plate: "FLEET",
      color: "",
    })),
  );
}

/**
 * GET /api/rentals/listings — filters (all optional):
 *   source=peer|fleet  vehicleType=sedan|suv|truck  city=  q=
 *   minDailyCents= maxDailyCents=   price range per day
 *   startDate=YYYY-MM-DD endDate=   only listings free for every day of [start, end)
 */
export const listListings = asyncHandler(async (req, res) => {
  await ensureFleetSeed();
  const filter = { status: "active" };
  if (req.query.source === "peer" || req.query.source === "fleet") filter.source = req.query.source;
  if (VEHICLE_TYPES.includes(String(req.query.vehicleType || ""))) {
    filter.vehicleType = req.query.vehicleType;
  }
  if (req.query.city) filter.city = new RegExp(`^${escapeRegex(String(req.query.city).trim())}`, "i");
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), "i");
    filter.$or = [{ title: rx }, { make: rx }, { model: rx }, { city: rx }];
  }
  const minCents = Number(req.query.minDailyCents);
  const maxCents = Number(req.query.maxDailyCents);
  if (Number.isFinite(minCents) && minCents > 0) filter.dailyRateCents = { $gte: minCents };
  if (Number.isFinite(maxCents) && maxCents > 0) filter.dailyRateCents = { ...filter.dailyRateCents, $lte: maxCents };

  if (req.query.startDate || req.query.endDate) {
    const start = toUtcDay(req.query.startDate);
    const end = toUtcDay(req.query.endDate);
    if (!start || !end || !(start < end)) throw httpError(400, "Choose a return date after the pickup date");
    if ((end - start) / 86400000 > 60) throw httpError(400, "Rentals are limited to 60 days");
    // Inside the owner's availability window, and no booked / held day in the range
    filter.$and = [
      { $or: [{ availableFrom: null }, { availableFrom: { $lte: start } }] },
      { $or: [{ availableTo: null }, { availableTo: { $gte: end } }] },
    ];
    const taken = await listingsBookedBetween(start, end);
    if (taken.length) filter._id = { $nin: taken };
  }
  const rows = await RentalListing.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json({ ok: true, listings: rows.map((r) => r.toSafeJSON()) });
});

/** GET /api/rentals/locations — cities that have active listings (location filter options) */
export const listLocations = asyncHandler(async (_req, res) => {
  await ensureFleetSeed();
  const rows = await RentalListing.aggregate([
    { $match: { status: "active", city: { $ne: "" } } },
    { $group: { _id: { city: "$city", state: "$state" }, count: { $sum: 1 } } },
    { $sort: { "_id.city": 1 } },
  ]);
  res.json({
    ok: true,
    locations: rows.map((r) => ({ city: r._id.city, state: r._id.state, count: r.count })),
    vehicleTypes: VEHICLE_TYPES,
  });
});

/**
 * GET /api/rentals/listings/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Booked days (paid bookings + live holds) for the calendar; default window today → +90 days.
 */
export const listingAvailability = asyncHandler(async (req, res) => {
  const listing = await RentalListing.findById(req.params.id);
  if (!listing || listing.status !== "active") throw httpError(404, "Listing not available");
  const from = toUtcDay(req.query.from || new Date()) || toUtcDay(new Date());
  let to = toUtcDay(req.query.to || new Date(from.getTime() + 90 * 86400000));
  if (!to || !(from < to)) throw httpError(400, "`to` must be after `from`");
  if ((to - from) / 86400000 > 366) to = new Date(from.getTime() + 366 * 86400000);
  const booked = await bookedDaysForListing(listing._id, from, to, { blockedDays: listing.blockedDays || [] });
  res.json({
    ok: true,
    listingId: listing._id.toString(),
    from: dayKey(from),
    to: dayKey(to),
    availableFrom: listing.availableFrom ? dayKey(toUtcDay(listing.availableFrom)) : null,
    availableTo: listing.availableTo ? dayKey(toUtcDay(listing.availableTo)) : null,
    /** Unavailable days: booked, held, or blocked by the owner */
    bookedDays: booked.days,
    bookedRanges: booked.ranges,
  });
});

/** GET /api/rentals/listings/mine */
export const listMine = asyncHandler(async (req, res) => {
  const rows = await RentalListing.find({ ownerId: req.user._id }).sort({ createdAt: -1 });
  res.json({ ok: true, listings: rows.map((r) => r.toSafeJSON()) });
});

/** POST /api/rentals/listings */
export const createListing = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const dailyRateCents = Number(body.dailyRateCents);
  if (!Number.isFinite(dailyRateCents) || dailyRateCents < 1000) {
    throw httpError(400, "dailyRateCents must be at least 1000 ($10)");
  }
  const availableFrom = body.availableFrom ? toUtcDay(body.availableFrom) : null;
  const availableTo = body.availableTo ? toUtcDay(body.availableTo) : null;
  if (availableFrom && availableTo && !(availableFrom < availableTo)) {
    throw httpError(400, "availableTo must be after availableFrom");
  }
  const row = await RentalListing.create({
    ownerId: req.user._id,
    source: body.source === "fleet" && req.user.role === "admin" ? "fleet" : "peer",
    title: String(body.title || `${body.year || ""} ${body.make || ""} ${body.model || ""}`).trim(),
    description: cleanDescription(body.description),
    vehicleType: VEHICLE_TYPES.includes(body.vehicleType) ? body.vehicleType : "sedan",
    make: String(body.make || "").trim(),
    model: String(body.model || "").trim(),
    year: Number(body.year) || new Date().getFullYear(),
    plate: String(body.plate || "").trim().toUpperCase(),
    color: String(body.color || "").trim(),
    city: String(body.city || "").trim(),
    state: String(body.state || "FL").trim().toUpperCase(),
    lat: body.lat != null ? Number(body.lat) : null,
    lng: body.lng != null ? Number(body.lng) : null,
    dailyRateCents,
    photos: cleanPhotos(body.photos),
    status: "pending",
    reviewReason: "new",
    availableFrom,
    availableTo,
  });
  res.status(201).json({ ok: true, listing: row.toSafeJSON() });
});

const MAX_PHOTOS = 8;
const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;

/** Listing photos: http(s) URLs from POST /api/uploads/photos, at most 8. */
function cleanPhotos(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw httpError(400, "photos must be a list of URLs");
  const urls = [...new Set(raw.map((u) => String(u || "").trim()).filter(Boolean))];
  if (urls.some((u) => !/^https?:\/\//i.test(u) || u.length > 2000)) {
    throw httpError(400, "Each photo must be an uploaded image URL");
  }
  if (urls.length > MAX_PHOTOS) throw httpError(400, `Up to ${MAX_PHOTOS} photos per listing`);
  return urls;
}

function cleanDescription(raw) {
  const d = String(raw ?? "").trim();
  if (d.length > 2000) throw httpError(400, "Description is limited to 2000 characters");
  return d;
}

/** Owner calendar blocks: unique YYYY-MM-DD days from today on (past days are dropped). */
function cleanBlockedDays(raw) {
  if (!Array.isArray(raw)) throw httpError(400, "blockedDays must be a list of YYYY-MM-DD days");
  const today = dayKey(toUtcDay(new Date()));
  const days = [...new Set(raw.map((d) => String(d).trim()))];
  for (const d of days) {
    const parsed = DAY_RX.test(d) ? toUtcDay(`${d}T00:00:00Z`) : null;
    if (!parsed || dayKey(parsed) !== d) throw httpError(400, `Invalid day: ${d}`);
  }
  const future = days.filter((d) => d >= today).sort();
  if (future.length > 366) throw httpError(400, "You can block up to 366 days");
  return future;
}

const IDENTITY_FIELDS = ["vehicleType", "make", "model", "year", "plate"];
const OWNER_FIELDS = ["title", "description", "color", "city", "state", "lat", "lng", "availableFrom", "availableTo"];

/**
 * PATCH /api/rentals/listings/:id — owner edits (TRD 5.8): title, description, photos, price,
 * availability window, blocked calendar days, pause / resume.
 *
 * Review rule (kept simple on purpose): an approved (active or paused) listing goes back to
 * admin review ("pending") only when
 *   - the daily price moves more than RENTAL_PRICE_REVIEW_CHANGE_PERCENT (50%) away from the
 *     last admin-approved price (reason price_change). Smaller changes apply immediately; since
 *     they are measured from the approved price, small steps can't add up past the limit;
 *   - or the vehicle itself changes (type, make, model, year, plate — reason details_changed).
 * Owners can pause an active listing and resume a paused one, but never self-approve.
 * Blocked days stay bookable for existing bookings; they only stop new ones.
 */
export const updateListing = asyncHandler(async (req, res) => {
  const row = await RentalListing.findById(req.params.id);
  if (!row) throw httpError(404, "Listing not found");
  const isAdmin = req.user.role === "admin";
  if (row.ownerId.toString() !== req.user._id.toString() && !isAdmin) {
    throw httpError(403, "Not your listing");
  }
  const body = req.body || {};
  const wasApproved = ["active", "paused"].includes(row.status);
  let review = null;

  for (const f of OWNER_FIELDS) {
    if (body[f] === undefined) continue;
    if (f === "description") row.description = cleanDescription(body.description);
    else if (f === "availableFrom" || f === "availableTo") row[f] = body[f] ? toUtcDay(body[f]) : null;
    else row[f] = body[f];
  }
  if (row.availableFrom && row.availableTo && !(row.availableFrom < row.availableTo)) {
    throw httpError(400, "availableTo must be after availableFrom");
  }
  if (body.photos !== undefined) row.photos = cleanPhotos(body.photos);
  if (body.blockedDays !== undefined) row.blockedDays = cleanBlockedDays(body.blockedDays);

  for (const f of IDENTITY_FIELDS) {
    if (body[f] === undefined) continue;
    const next =
      f === "plate" ? String(body.plate || "").trim().toUpperCase() : f === "year" ? Number(body.year) : body[f];
    if (f === "vehicleType" && !VEHICLE_TYPES.includes(next)) throw httpError(400, "Invalid vehicle type");
    if (String(next) !== String(row[f])) {
      row[f] = next;
      if (wasApproved && !isAdmin) review = "details_changed";
    }
  }

  if (body.dailyRateCents !== undefined) {
    const cents = Math.round(Number(body.dailyRateCents));
    if (!Number.isFinite(cents) || cents < 1000) throw httpError(400, "dailyRateCents must be at least 1000 ($10)");
    const baseline = row.approvedDailyRateCents || row.dailyRateCents;
    const changePct = baseline ? (Math.abs(cents - baseline) / baseline) * 100 : 0;
    row.dailyRateCents = cents;
    if (wasApproved && !isAdmin && changePct > env.rentalPriceReviewPercent) review = review || "price_change";
  }

  if (body.status !== undefined && body.status !== row.status) {
    if (isAdmin) {
      row.status = body.status;
      if (body.status === "active") {
        row.approvedDailyRateCents = row.dailyRateCents;
        row.reviewReason = null;
      }
    } else if (body.status === "paused" && row.status === "active") {
      row.status = "paused";
    } else if (body.status === "active" && row.status === "paused" && !row.reviewReason) {
      row.status = "active";
    } else {
      throw httpError(403, "Only admin can approve or reject listings — you can pause and resume an approved listing");
    }
  }
  if (review) {
    row.status = "pending";
    row.reviewReason = review;
  }
  // Listings approved before the baseline existed
  if (row.status === "active" && row.approvedDailyRateCents == null) row.approvedDailyRateCents = row.dailyRateCents;
  await row.save();
  res.json({
    ok: true,
    listing: row.toSafeJSON(),
    reReview: review,
    message:
      review === "price_change"
        ? `Price changed by more than ${env.rentalPriceReviewPercent}% — the listing is back in review until an admin approves it.`
        : review === "details_changed"
          ? "Vehicle details changed — the listing is back in review until an admin approves it."
          : undefined,
  });
});

/**
 * GET /api/rentals/listings/mine/bookings — the owner's paid bookings across their listings:
 * renter name (no contact details), dates, payout and status; `canDecline` while inside the
 * RENTAL_OWNER_DECLINE_HOURS window.
 */
export const listOwnerBookings = asyncHandler(async (req, res) => {
  const rows = await RentalBooking.find({
    ownerId: req.user._id,
    source: "peer",
    $or: [{ paid: true }, { status: { $in: ["confirmed", "active", "completed"] } }],
  })
    .sort({ startDate: -1 })
    .limit(200);
  const { User } = await import("../models/User.js");
  const [listings, renters] = await Promise.all([
    RentalListing.find({ _id: { $in: rows.map((r) => r.listingId) } }).select("title photos").lean(),
    User.find({ _id: { $in: rows.map((r) => r.renterId) } }).select("fullName").lean(),
  ]);
  const listingById = new Map(listings.map((l) => [String(l._id), l]));
  const renterById = new Map(renters.map((u) => [String(u._id), u]));
  const now = new Date();
  res.json({
    ok: true,
    declineWindowHours: env.rentalOwnerDeclineHours,
    bookings: rows.map((b) => {
      const deadline = ownerDeclineDeadline(b);
      const canDecline = Boolean(b.paid && b.status === "confirmed" && deadline && now < deadline);
      const l = listingById.get(String(b.listingId));
      return {
        id: b._id.toString(),
        listingId: b.listingId.toString(),
        listingTitle: l?.title ?? null,
        listingPhoto: l?.photos?.[0] ?? null,
        renterName: renterById.get(String(b.renterId))?.fullName ?? "Renter",
        startDate: b.startDate,
        endDate: b.endDate,
        days: b.days,
        dailyRateCents: b.dailyRateCents,
        subtotalCents: b.subtotalCents,
        commissionCents: b.commissionCents,
        payoutCents: ownerPayoutCents(b),
        status: b.status,
        paymentStatus: b.paymentStatus,
        paidAt: b.paidAt,
        cancelledAt: b.cancelledAt,
        cancelledBy: b.cancelledBy,
        refundCents: b.refundCents,
        canDecline,
        declineDeadline: canDecline ? deadline : null,
        createdAt: b.createdAt,
      };
    }),
  });
});

/** POST /api/rentals/bookings/:id/decline — owner declines a paid booking (full refund to the renter) */
export const declineBooking = asyncHandler(async (req, res) => {
  const booking = await RentalBooking.findById(req.params.id);
  if (!booking) throw httpError(404, "Booking not found");
  if (String(booking.ownerId) !== String(req.user._id)) throw httpError(403, "Not your listing's booking");
  const done = await declineRentalByOwner(booking, { reason: req.body?.reason });
  res.json({
    ok: true,
    booking: done.toSafeJSON(),
    message: `Booking declined — the renter is refunded $${(done.refundCents / 100).toFixed(2)} in full.`,
  });
});

/** GET /api/rentals/quote?listingId=&startDate=&endDate= — exactly what a booking would charge */
export const quote = asyncHandler(async (req, res) => {
  const listing = await RentalListing.findById(req.query.listingId);
  if (!listing || listing.status !== "active") throw httpError(404, "Listing not available");
  const q = quoteRental(listing, req.query.startDate, req.query.endDate);
  res.json({ ok: true, quote: q, holdMinutes: Math.ceil(env.bookingHoldSeconds / 60) });
});

/**
 * POST /api/rentals/bookings — body: { listingId, startDate, endDate }
 * Holds the dates (atomically) as `pending_payment` and returns a PaymentIntent. The booking
 * is confirmed only after payment succeeds; an unpaid hold is released after BOOKING_HOLD_SECONDS.
 */
export const createBooking = asyncHandler(async (req, res) => {
  const listing = await RentalListing.findById(req.body?.listingId);
  if (!listing || listing.status !== "active") throw httpError(404, "Listing not available");
  if (String(listing.ownerId) === String(req.user._id)) {
    throw httpError(400, "You can't rent your own vehicle");
  }
  const q = quoteRental(listing, req.body?.startDate, req.body?.endDate);

  // Bookings made before day slots existed have no slot rows — check them directly too
  const legacyClash = await RentalBooking.exists({
    listingId: listing._id,
    status: { $in: ["confirmed", "active"] },
    startDate: { $lt: q.endDate },
    endDate: { $gt: q.startDate },
  });
  if (legacyClash) throw httpError(409, "Dates not available", { code: "DATES_TAKEN" });

  const booking = new RentalBooking({
    listingId: listing._id,
    renterId: req.user._id,
    ownerId: listing.ownerId,
    source: listing.source,
    startDate: q.startDate,
    endDate: q.endDate,
    days: q.days,
    dailyRateCents: q.dailyRateCents,
    subtotalCents: q.subtotalCents,
    commissionCents: q.commissionCents,
    totalCents: q.totalCents,
    status: "pending_payment",
    paid: false,
    paymentStatus: "pending",
    holdExpiresAt: new Date(Date.now() + env.bookingHoldSeconds * 1000),
  });
  if (!(await reserveRentalDays(booking))) {
    throw httpError(409, "Dates not available", { code: "DATES_TAKEN" });
  }
  try {
    await booking.save();
    const payment = await createCheckoutIntent({
      user: req.user,
      purpose: "rental",
      refId: booking._id,
      amountCents: booking.totalCents,
      description: `RideRite rental · ${listing.title} · ${q.days} day(s)`,
    });
    booking.stripePaymentIntentId = payment.paymentIntentId;
    await booking.save();
    res.status(201).json({ ok: true, booking: booking.toSafeJSON(), payment });
  } catch (err) {
    await releaseRentalDays(booking._id);
    await RentalBooking.deleteOne({ _id: booking._id });
    throw err;
  }
});

async function loadRenterBooking(req) {
  const booking = await RentalBooking.findById(req.params.id);
  if (!booking) throw httpError(404, "Booking not found");
  if (String(booking.renterId) !== String(req.user._id)) throw httpError(403, "Not your booking");
  return booking;
}

/** POST /api/rentals/bookings/:id/intent — resume checkout for a held booking */
export const bookingIntent = asyncHandler(async (req, res) => {
  const booking = await loadRenterBooking(req);
  if (booking.paid) return res.json({ ok: true, alreadyPaid: true, booking: booking.toSafeJSON() });
  if (booking.status !== "pending_payment") {
    throw httpError(409, "This hold expired — book the dates again", { code: "HOLD_EXPIRED" });
  }
  const payment = await createCheckoutIntent({
    user: req.user,
    purpose: "rental",
    refId: booking._id,
    amountCents: booking.totalCents,
    description: `RideRite rental · ${booking.days} day(s)`,
    existingIntentId: booking.stripePaymentIntentId,
  });
  if (payment.alreadySucceeded) {
    const done = await confirmRentalPaid(booking._id, { paymentIntentId: payment.paymentIntentId, provider: "stripe" });
    return res.json({ ok: true, alreadyPaid: true, booking: done.toSafeJSON() });
  }
  booking.stripePaymentIntentId = payment.paymentIntentId;
  await booking.save();
  res.json({ ok: true, booking: booking.toSafeJSON(), payment });
});

/** POST /api/rentals/bookings/:id/confirm-mock — mock mode: simulate a successful card payment */
export const confirmMock = asyncHandler(async (req, res) => {
  if (!isStripeMock()) throw httpError(403, "Mock confirm only available in mock mode");
  const booking = await loadRenterBooking(req);
  const done = await confirmRentalPaid(booking._id, {
    paymentIntentId: booking.stripePaymentIntentId,
    provider: "mock",
  });
  if (!done.paid) throw httpError(409, "This booking can no longer be paid", { code: "HOLD_EXPIRED" });
  res.json({ ok: true, booking: done.toSafeJSON() });
});

/** POST /api/rentals/bookings/:id/sync — after stripe.confirmPayment on the client */
export const syncPayment = asyncHandler(async (req, res) => {
  const booking = await loadRenterBooking(req);
  if (booking.paid) return res.json({ ok: true, booking: booking.toSafeJSON() });
  if (isStripeMock()) throw httpError(400, "Use confirm-mock in mock mode");
  const status = await retrieveIntentStatus(booking.stripePaymentIntentId);
  if (status === "succeeded") {
    const done = await confirmRentalPaid(booking._id, {
      paymentIntentId: booking.stripePaymentIntentId,
      provider: "stripe",
    });
    return res.json({ ok: true, booking: done.toSafeJSON() });
  }
  res.json({ ok: true, paymentIntentStatus: status, booking: booking.toSafeJSON() });
});

/**
 * POST /api/rentals/bookings/:id/cancel — renter releases an unpaid hold, or cancels a paid
 * rental before pickup (refund per the cancellation policy; see cancelPaidRental).
 */
export const cancelBooking = asyncHandler(async (req, res) => {
  const booking = await loadRenterBooking(req);
  if (booking.paid) {
    const { booking: done, policy } = await cancelPaidRental(booking);
    return res.json({
      ok: true,
      booking: done.toSafeJSON(),
      refundCents: policy.refundCents,
      refundPercent: policy.percent,
      message:
        policy.refundCents > 0
          ? `Rental cancelled. $${(policy.refundCents / 100).toFixed(2)} (${policy.percent}%) is being refunded.`
          : "Rental cancelled. No refund applies.",
    });
  }
  if (booking.status !== "pending_payment") {
    throw httpError(400, "This booking can't be cancelled");
  }
  await expireRentalHold(booking._id);
  await RentalBooking.updateOne({ _id: booking._id, status: "expired" }, { $set: { status: "cancelled" } });
  res.json({ ok: true, booking: (await RentalBooking.findById(booking._id)).toSafeJSON() });
});

/** GET /api/rentals/bookings/mine */
export const listMyBookings = asyncHandler(async (req, res) => {
  const rows = await RentalBooking.find({
    $or: [{ renterId: req.user._id }, { ownerId: req.user._id }],
  })
    .sort({ createdAt: -1 })
    .limit(100);
  const listings = await RentalListing.find({ _id: { $in: rows.map((r) => r.listingId) } })
    .select("title city state photos vehicleType")
    .lean();
  const byId = new Map(listings.map((l) => [String(l._id), l]));
  const now = new Date();
  res.json({
    ok: true,
    cancelPolicy: { fullRefundHours: env.rentalFullRefundHours, lateRefundPercent: env.rentalLateRefundPercent },
    bookings: rows.map((r) => {
      const l = byId.get(String(r.listingId));
      const role = String(r.renterId) === String(req.user._id) ? "renter" : "owner";
      const cancellable = role === "renter" && r.paid && r.status === "confirmed" && now < r.startDate;
      return {
        ...r.toSafeJSON(),
        listingTitle: l?.title ?? null,
        listingCity: l ? [l.city, l.state].filter(Boolean).join(", ") : null,
        listingPhoto: l?.photos?.[0] ?? null,
        vehicleType: l?.vehicleType ?? null,
        role,
        // What cancelling right now would refund (renter, paid, before pickup)
        cancelQuote: cancellable ? rentalCancelQuote(r, now) : null,
      };
    }),
  });
});
