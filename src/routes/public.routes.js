import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as pub from "../controllers/public.controller.js";

const router = Router();

// Nominatim allows ~1 req/s per app — keep callers well under that
const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many lookups. Try again shortly." },
});
router.get("/trips/:id/track", pub.trackTrip);
router.get("/nearby-tiers", pub.nearbyTiers);
router.get("/nearby-drivers", pub.nearbyDrivers);

router.get("/reverse-geocode", geocodeLimiter, pub.reverseGeocodePoint);

export default router;
