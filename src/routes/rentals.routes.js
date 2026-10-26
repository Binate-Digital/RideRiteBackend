import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as rentals from "../controllers/rentals.controller.js";
import * as bookingChat from "../controllers/bookingChat.controller.js";

const router = Router();

router.get("/listings", rentals.listListings);
router.get("/locations", rentals.listLocations);
router.get("/listings/:id/availability", rentals.listingAvailability);
router.get("/quote", rentals.quote);

router.use(requireAuth, requireVerified);
router.get("/listings/mine", rentals.listMine);
router.get("/listings/mine/bookings", rentals.listOwnerBookings);
router.post("/listings", rentals.createListing);
router.patch("/listings/:id", rentals.updateListing);
router.post("/bookings", rentals.createBooking);
router.post("/bookings/:id/intent", rentals.bookingIntent);
router.post("/bookings/:id/confirm-mock", rentals.confirmMock);
router.post("/bookings/:id/sync", rentals.syncPayment);
router.post("/bookings/:id/cancel", rentals.cancelBooking);
router.post("/bookings/:id/decline", rentals.declineBooking);
router.get("/bookings/mine", rentals.listMyBookings);
router.get("/bookings/:id/receipt", rentals.receipt);
// Owner records pickup / return (TRD 4.8 lifecycle)
router.post("/bookings/:id/handover", rentals.handOver);
router.post("/bookings/:id/return", rentals.markReturned);
// Masked chat / call: renter ↔ owner (fleet: renter ↔ RideRite support)
router.get("/bookings/:id/messages", bookingChat.rentalMessages);
router.post("/bookings/:id/messages", bookingChat.rentalSend);
router.post("/bookings/:id/call", bookingChat.rentalCall);

export default router;
