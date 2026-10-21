import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as chauffeur from "../controllers/chauffeur.controller.js";

const router = Router();
router.use(requireAuth, requireVerified);
router.post("/estimate", chauffeur.estimate);
router.post("/bookings", chauffeur.book);
router.get("/bookings/mine", chauffeur.listMine);

export default router;
