import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as rentals from "../controllers/rentals.controller.js";

const router = Router();

router.get("/listings", rentals.listListings);
router.get("/locations", rentals.listLocations);
router.get("/listings/:id/availability", rentals.listingAvailability);
router.get("/quote", rentals.quote);

router.use(requireAuth, requireVerified);
router.get("/listings/mine", rentals.listMine);
router.post("/listings", rentals.createListing);
router.patch("/listings/:id", rentals.updateListing);
router.post("/bookings", rentals.createBooking);
router.post("/bookings/:id/intent", rentals.bookingIntent);
router.post("/bookings/:id/confirm-mock", rentals.confirmMock);
router.post("/bookings/:id/sync", rentals.syncPayment);
router.post("/bookings/:id/cancel", rentals.cancelBooking);
router.get("/bookings/mine", rentals.listMyBookings);

export default router;
