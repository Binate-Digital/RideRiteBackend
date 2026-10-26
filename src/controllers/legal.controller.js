import { z } from "zod";
import { LegalPage } from "../models/LegalPage.js";
import { Dispute } from "../models/Dispute.js";
import { Trip } from "../models/Trip.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { audit } from "../utils/audit.js";
import { isObjectId } from "../utils/adminQuery.js";
import { CORE_SLUGS, ensureLegalPages, sanitizeMarkdown } from "../utils/legal.js";

// ----------------------------------------------------------------------------- public

/** GET /api/public/legal — every page's slug, title, version (no bodies) */
export const listPublic = asyncHandler(async (_req, res) => {
  await ensureLegalPages();
  const rows = await LegalPage.find().select("slug title version placeholder updatedAt").sort({ slug: 1 });
  res.set("Cache-Control", "public, max-age=60");
  res.json({ ok: true, pages: rows.map((r) => ({ slug: r.slug, title: r.title, version: r.version, placeholder: r.placeholder, updatedAt: r.updatedAt })) });
});

/** GET /api/public/legal/:slug — one page (Markdown body) */
export const getPublic = asyncHandler(async (req, res) => {
  await ensureLegalPages();
  const page = await LegalPage.findOne({ slug: String(req.params.slug || "").toLowerCase() });
  if (!page) throw httpError(404, "Page not found");
  const { updatedBy: _u, ...json } = page.toSafeJSON();
  res.set("Cache-Control", "public, max-age=60");
  res.json({ ok: true, page: json });
});

// ----------------------------------------------------------------------------- admin (legal:write)

const pageSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/, "Use 2–60 lowercase letters, digits or dashes").optional(),
  title: z.string().trim().min(2).max(120),
  body: z.string().max(200000),
});

/** GET /api/admin/legal — all pages with bodies */
export const adminList = asyncHandler(async (_req, res) => {
  await ensureLegalPages();
  const rows = await LegalPage.find().sort({ slug: 1 });
  res.json({ ok: true, corePages: CORE_SLUGS, pages: rows.map((r) => r.toSafeJSON()) });
});

/** POST /api/admin/legal — body: { slug, title, body } (a new, non-core page) */
export const adminCreate = asyncHandler(async (req, res) => {
  const data = pageSchema.parse(req.body || {});
  if (!data.slug) throw httpError(400, "slug is required");
  if (await LegalPage.exists({ slug: data.slug })) throw httpError(409, "A page with this slug already exists");
  const page = await LegalPage.create({
    slug: data.slug,
    title: data.title,
    body: sanitizeMarkdown(data.body),
    version: 1,
    placeholder: false,
    updatedBy: req.user._id,
  });
  await audit(req, "legal.create", "LegalPage", page.slug, { title: page.title, version: 1 });
  res.status(201).json({ ok: true, page: page.toSafeJSON() });
});

/** PUT /api/admin/legal/:slug — body: { title, body } → version + 1 when anything changed */
export const adminUpdate = asyncHandler(async (req, res) => {
  const data = pageSchema.parse(req.body || {});
  await ensureLegalPages();
  const page = await LegalPage.findOne({ slug: String(req.params.slug || "").toLowerCase() });
  if (!page) throw httpError(404, "Page not found");
  const body = sanitizeMarkdown(data.body);
  const changed = body !== page.body || data.title !== page.title;
  if (changed) {
    const from = page.version;
    page.title = data.title;
    page.body = body;
    page.version = from + 1;
    page.placeholder = false;
    page.updatedBy = req.user._id;
    await page.save();
    await audit(req, "legal.update", "LegalPage", page.slug, { title: page.title, fromVersion: from, toVersion: page.version, length: body.length });
  }
  res.json({ ok: true, changed, page: page.toSafeJSON() });
});

/** DELETE /api/admin/legal/:slug — custom pages only (the core four can't be removed) */
export const adminDelete = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (CORE_SLUGS.includes(slug)) throw httpError(400, "Core legal pages can be edited but not deleted");
  const page = await LegalPage.findOneAndDelete({ slug });
  if (!page) throw httpError(404, "Page not found");
  await audit(req, "legal.delete", "LegalPage", slug, { title: page.title, version: page.version });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------- complaints

/** Florida TNC complaint form categories → dispute queue categories */
const COMPLAINT_CATEGORIES = {
  zero_tolerance_drugs_alcohol: "safety",
  driver_conduct: "driver_behavior",
  vehicle_safety: "safety",
  discrimination: "driver_behavior",
  accessibility: "driver_behavior",
  billing: "payment",
  other: "other",
};

const complaintSchema = z.object({
  reporter_name: z.string().trim().min(2).max(80),
  reporter_email: z.string().trim().email().max(254),
  reporter_phone: z.string().trim().max(30).nullish(),
  category: z.enum(Object.keys(COMPLAINT_CATEGORIES)),
  description: z.string().trim().min(10).max(2000),
  trip_id: z.string().trim().max(64).nullish(),
  incident_at: z.string().trim().max(40).nullish(),
});

/**
 * POST /api/public/complaints — the Florida compliance page's complaint form (no sign-in
 * needed; rate-limited in the route). Creates a Dispute (source "complaint") in the admin
 * Disputes queue, linked to the trip when a valid trip id is given.
 */
export const createComplaint = asyncHandler(async (req, res) => {
  const data = complaintSchema.parse(req.body || {});
  const trip = data.trip_id && isObjectId(data.trip_id) ? await Trip.findById(data.trip_id).select("riderId driverId") : null;
  const incidentAt = data.incident_at ? new Date(data.incident_at) : null;
  const dispute = await Dispute.create({
    source: "complaint",
    tripId: trip?._id || null,
    tripRef: trip ? null : data.trip_id || null,
    // A signed-in reporter is linked; otherwise the contact details are the way back
    riderId: req.user?._id || null,
    driverId: trip?.driverId || null,
    category: COMPLAINT_CATEGORIES[data.category],
    complaintCategory: data.category,
    priority: data.category === "zero_tolerance_drugs_alcohol" ? "urgent" : "normal",
    description: data.description,
    contact: { name: data.reporter_name, email: data.reporter_email.toLowerCase(), phone: data.reporter_phone || null },
    incidentAt: incidentAt && !Number.isNaN(incidentAt.getTime()) ? incidentAt : null,
  });
  res.status(201).json({ ok: true, id: dispute._id.toString(), message: "Complaint received. Our safety team will follow up by email." });
});
