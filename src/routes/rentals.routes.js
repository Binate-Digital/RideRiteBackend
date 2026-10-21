import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as rentals from "../controllers/rentals.controller.js";

const router = Router();

router.get("/listings", rentals.listListings);

router.use(requireAuth, requireVerified);
router.get("/listings/mine", rentals.listMine);
router.post("/listings", rentals.createListing);
router.patch("/listings/:id", rentals.updateListing);
router.post("/bookings", rentals.createBooking);
router.get("/bookings/mine", rentals.listMyBookings);

export default router;
