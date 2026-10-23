import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as chauffeur from "../controllers/chauffeur.controller.js";

const router = Router();
router.get("/options", chauffeur.options);
router.use(requireAuth, requireVerified);
router.post("/estimate", chauffeur.estimate);
router.post("/bookings", chauffeur.book);
router.post("/bookings/:id/intent", chauffeur.bookingIntent);
router.post("/bookings/:id/confirm-mock", chauffeur.confirmMock);
router.post("/bookings/:id/sync", chauffeur.syncPayment);
router.post("/bookings/:id/cancel", chauffeur.cancelBooking);
router.get("/bookings/mine", chauffeur.listMine);

export default router;
