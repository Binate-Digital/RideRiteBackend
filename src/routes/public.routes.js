import { Router } from "express";
import * as pub from "../controllers/public.controller.js";

const router = Router();
router.get("/trips/:id/track", pub.trackTrip);
router.get("/nearby-tiers", pub.nearbyTiers);

export default router;
