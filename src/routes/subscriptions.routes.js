import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as subscriptions from "../controllers/subscriptions.controller.js";

const router = Router();

router.get("/plans", subscriptions.listPlans);
router.use(requireAuth, requireVerified);
router.get("/me", subscriptions.getMine);
router.post("/subscribe", subscriptions.subscribe);
router.post("/activate", subscriptions.activate);
router.post("/sync", subscriptions.sync);
router.post("/resume", subscriptions.resume);
router.post("/cancel", subscriptions.cancel);

export default router;
