import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as chauffeur from "../controllers/chauffeur.controller.js";
import * as bookingChat from "../controllers/bookingChat.controller.js";

const router = Router();
router.get("/options", chauffeur.options);
router.use(requireAuth, requireVerified);
router.post("/estimate", chauffeur.estimate);
router.get("/available-drivers", chauffeur.availableDrivers);
router.post("/bookings", chauffeur.book);
router.post("/bookings/:id/intent", chauffeur.bookingIntent);
router.post("/bookings/:id/confirm-mock", chauffeur.confirmMock);
router.post("/bookings/:id/sync", chauffeur.syncPayment);
router.post("/bookings/:id/cancel", chauffeur.cancelBooking);
router.post("/bookings/:id/choose-driver", chauffeur.chooseDriver);
router.get("/bookings/mine", chauffeur.listMine);
router.get("/bookings/:id/receipt", chauffeur.receipt);
// Masked chat / call with the assigned driver (rider and driver)
router.get("/bookings/:id/messages", bookingChat.chauffeurMessages);
router.post("/bookings/:id/messages", bookingChat.chauffeurSend);
router.post("/bookings/:id/call", bookingChat.chauffeurCall);

// Driver hub — scheduled bookings
const driverOnly = requireRole("driver", "admin");
router.get("/driver/open", driverOnly, chauffeur.driverOpen);
router.get("/driver/mine", driverOnly, chauffeur.driverMine);
router.post("/bookings/:id/accept", driverOnly, chauffeur.driverAccept);
router.post("/bookings/:id/decline", driverOnly, chauffeur.driverDecline);
router.post("/bookings/:id/start", driverOnly, chauffeur.driverStart);
router.post("/bookings/:id/complete", driverOnly, chauffeur.driverComplete);

export default router;
