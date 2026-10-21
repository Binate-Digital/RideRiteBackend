import { RentalListing } from "../models/RentalListing.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";

const P2P_COMMISSION_RATE = 0.15;

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
    availableFrom: body.availableFrom ? new Date(body.availableFrom) : null,
    availableTo: body.availableTo ? new Date(body.availableTo) : null,
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

/** POST /api/rentals/bookings */
export const createBooking = asyncHandler(async (req, res) => {
  const listing = await RentalListing.findById(req.body?.listingId);
  if (!listing || listing.status !== "active") throw httpError(404, "Listing not available");
  const startDate = new Date(req.body?.startDate);
  const endDate = new Date(req.body?.endDate);
  if (!(startDate < endDate)) throw httpError(400, "Invalid rental dates");
  const days = Math.max(1, Math.ceil((endDate - startDate) / 86400000));
  const subtotalCents = days * listing.dailyRateCents;
  const commissionCents =
    listing.source === "peer" ? Math.round(subtotalCents * P2P_COMMISSION_RATE) : 0;
  const totalCents = subtotalCents;

  // prevent overlap
  const clash = await RentalBooking.findOne({
    listingId: listing._id,
    status: { $in: ["pending_payment", "confirmed", "active"] },
    startDate: { $lt: endDate },
    endDate: { $gt: startDate },
  });
  if (clash) throw httpError(409, "Dates not available");

  const booking = await RentalBooking.create({
    listingId: listing._id,
    renterId: req.user._id,
    ownerId: listing.ownerId,
    startDate,
    endDate,
    days,
    dailyRateCents: listing.dailyRateCents,
    subtotalCents,
    commissionCents,
    totalCents,
    status: "confirmed",
    paid: true,
    paymentStatus: "paid",
  });

  res.status(201).json({ ok: true, booking: booking.toSafeJSON() });
});

/** GET /api/rentals/bookings/mine */
export const listMyBookings = asyncHandler(async (req, res) => {
  const rows = await RentalBooking.find({
    $or: [{ renterId: req.user._id }, { ownerId: req.user._id }],
  })
    .sort({ createdAt: -1 })
    .limit(100);
  res.json({ ok: true, bookings: rows.map((r) => r.toSafeJSON()) });
});
