import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import * as admin from "../controllers/admin.controller.js";

const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/analytics", admin.analytics);
router.get("/revenue", admin.revenue);
router.get("/health", admin.health);
router.get("/audit", admin.listAudit);

router.get("/users", admin.listUsers);
router.patch("/users/:id/role", admin.setUserRole);
router.patch("/users/:id/active", admin.setUserActive);
router.get("/export/users.csv", admin.exportUsersCsv);

router.get("/drivers", admin.listDrivers);
router.patch("/drivers/:userId/status", admin.setDriverStatus);
router.get("/export/drivers.csv", admin.exportDriversCsv);

router.get("/trips", admin.listTrips);
router.patch("/trips/:id/refund", admin.refundTrip);
router.get("/cancellations", admin.listCancellations);

router.get("/subscriptions", admin.listSubscriptions);

router.get("/rentals/listings", admin.listRentalListings);
router.patch("/rentals/listings/:id", admin.updateRentalListing);
router.get("/rentals/bookings", admin.listRentalBookings);

router.get("/chauffeur", admin.listChauffeur);

router.get("/bonuses", admin.listBonuses);
router.patch("/bonuses/:id", admin.updateBonus);

router.get("/maintenance", admin.listMaintenance);
router.patch("/maintenance/:id", admin.updateMaintenance);

export default router;
