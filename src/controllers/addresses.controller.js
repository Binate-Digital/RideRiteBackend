import { SavedAddress } from "../models/SavedAddress.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";

/** GET /api/addresses */
export const list = asyncHandler(async (req, res) => {
  const rows = await SavedAddress.find({ userId: req.user._id }).sort({ createdAt: -1 });
  res.json({ ok: true, addresses: rows.map((r) => r.toSafeJSON()) });
});

/** POST /api/addresses */
export const create = asyncHandler(async (req, res) => {
  const label = ["home", "work", "other"].includes(req.body?.label) ? req.body.label : "other";
  const address = String(req.body?.address || "").trim();
  if (!address) throw httpError(400, "address is required");
  const name = String(req.body?.name || "").trim();
  const lat = req.body?.lat != null ? Number(req.body.lat) : null;
  const lng = req.body?.lng != null ? Number(req.body.lng) : null;

  const count = await SavedAddress.countDocuments({ userId: req.user._id });
  if (count >= 20) throw httpError(400, "Maximum 20 saved addresses");

  const row = await SavedAddress.create({
    userId: req.user._id,
    label,
    name: name || (label === "home" ? "Home" : label === "work" ? "Work" : "Saved Place"),
    address,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  });

  res.status(201).json({ ok: true, address: row.toSafeJSON() });
});

/** DELETE /api/addresses/:id */
export const remove = asyncHandler(async (req, res) => {
  const row = await SavedAddress.findOneAndDelete({
    _id: req.params.id,
    userId: req.user._id,
  });
  if (!row) throw httpError(404, "Address not found");
  res.json({ ok: true });
});
