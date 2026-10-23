import { RentalListing } from "../models/RentalListing.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { isStripeMock } from "../lib/stripe.js";
import { createCheckoutIntent, retrieveIntentStatus } from "../utils/checkout.js";
import {
  confirmRentalPaid,
  expireRentalHold,
  quoteRental,
  releaseRentalDays,
  reserveRentalDays,
  toUtcDay,
} from "../utils/rentalBooking.js";

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

/** GET /api/rentals/listings?source=&vehicleType=&city=&q= */
export const listListings = asyncHandler(async (req, res) => {
  await ensureFleetSeed();
  const filter = { status: "active" };
  if (req.query.source === "peer" || req.query.source === "fleet") filter.source = req.query.source;
  if (["sedan", "suv", "truck"].includes(String(req.query.vehicleType || ""))) {
    filter.vehicleType = req.query.vehicleType;
  }
  if (req.query.city) filter.city = new RegExp(String(req.query.city), "i");
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: rx }, { make: rx }, { model: rx }, { city: rx }];
  }
  const rows = await RentalListing.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json({ ok: true, listings: rows.map((r) => r.toSafeJSON()) });
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
    description: String(body.description || "").trim(),
    vehicleType: body.vehicleType || "sedan",
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
    photos: Array.isArray(body.photos) ? body.photos.slice(0, 8) : [],
    status: "pending",
    availableFrom,
    availableTo,
  });
  res.status(201).json({ ok: true, listing: row.toSafeJSON() });
});

/** PATCH /api/rentals/listings/:id */
export const updateListing = asyncHandler(async (req, res) => {
  const row = await RentalListing.findById(req.params.id);
  if (!row) throw httpError(404, "Listing not found");
  if (row.ownerId.toString() !== req.user._id.toString() && req.user.role !== "admin") {
    throw httpError(403, "Not your listing");
  }
  const fields = [
    "title",
    "description",
    "vehicleType",
    "make",
    "model",
    "year",
    "plate",
    "color",
    "city",
    "state",
    "lat",
    "lng",
    "dailyRateCents",
    "photos",
    "status",
    "availableFrom",
    "availableTo",
  ];
  for (const f of fields) {
    if (req.body?.[f] !== undefined) row[f] = req.body[f];
  }
  if (req.user.role !== "admin" && row.status === "active") {
    // owner can pause; cannot self-approve
  }
  if (req.user.role !== "admin" && ["active", "rejected"].includes(req.body?.status)) {
    throw httpError(403, "Only admin can set active/rejected");
  }
  await row.save();
  res.json({ ok: true, listing: row.toSafeJSON() });
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

/** POST /api/rentals/bookings/:id/cancel — renter abandons an unpaid hold (frees the dates) */
export const cancelBooking = asyncHandler(async (req, res) => {
  const booking = await loadRenterBooking(req);
  if (booking.status !== "pending_payment") {
    throw httpError(400, "Only an unpaid booking can be released here — contact support to cancel a paid rental");
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
    .select("title")
    .lean();
  const titles = new Map(listings.map((l) => [String(l._id), l.title]));
  res.json({
    ok: true,
    bookings: rows.map((r) => ({
      ...r.toSafeJSON(),
      listingTitle: titles.get(String(r.listingId)) ?? null,
      role: String(r.renterId) === String(req.user._id) ? "renter" : "owner",
    })),
  });
});
