import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as pub from "../controllers/public.controller.js";
import * as legal from "../controllers/legal.controller.js";
import { optionalAuth, requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";

const router = Router();

// Nominatim allows ~1 req/s per app — keep callers well under that
const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many lookups. Try again shortly." },
});
// Driver positions: signed-in users only, limited per user (not per IP)
const nearbyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.nearbyRateLimitPerMinute,
  keyGenerator: (req) => `u:${req.user?._id || req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests. Try again shortly." },
});
// Shared trip links: token-guarded, but still throttle guessing per IP
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests. Try again shortly." },
});

router.get("/trips/:id/track", trackLimiter, pub.trackTrip);
// Counts + coarse ETA only (no coordinates or identities), so it stays public for the landing page
router.get("/nearby-tiers", pub.nearbyTiers);
router.get("/nearby-drivers", requireAuth, nearbyLimiter, pub.nearbyDrivers);

// Fare floors, commission rates and listing-review threshold (from admin settings; cacheable)
router.get("/pricing-summary", pub.pricingSummary);

router.get("/reverse-geocode", geocodeLimiter, pub.reverseGeocodePoint);

// Legal pages (admin-editable Markdown)
router.get("/legal", legal.listPublic);
router.get("/legal/:slug", legal.getPublic);

// Florida complaint form → admin Disputes queue (no sign-in needed; a signed-in reporter is linked)
const complaintLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many complaints from this network. Try again later or call us." },
});
router.post("/complaints", complaintLimiter, optionalAuth, legal.createComplaint);

export default router;
