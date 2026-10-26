import { Router } from "express";
import * as legal from "../controllers/legal.controller.js";
import { requireAdmin, requireAuth, requirePermission as can } from "../middleware/auth.js";
import * as admin from "../controllers/admin.controller.js";
import * as ops from "../controllers/adminOps.controller.js";
import * as finance from "../controllers/adminFinance.controller.js";
import * as system from "../controllers/adminSystem.controller.js";

/**
 * Admin API (TRD 6). Every route needs an admin account plus the permission(s) listed —
 * see utils/permissions.js for which admin role has which permission.
 */
const router = Router();

router.use(requireAuth, requireAdmin);

router.get("/me", system.me);
router.get("/analytics", can("dashboard:read"), system.analytics);
router.get("/health", can("health:read"), system.health);
router.get("/audit", can("audit:read"), system.listAudit);
router.get("/settings", can("settings:read"), system.getSettingsHandler);
router.patch("/settings", can("settings:write"), system.patchSettings);

router.get("/admins", can("admins:manage"), system.listAdmins);
router.post("/admins", can("admins:manage"), system.createAdmin);
router.patch("/admins/:id", can("admins:manage"), system.updateAdmin);

// Users & drivers (6.3)
router.get("/users", can("users:read"), admin.listUsers);
router.get("/users/:id", can("users:read"), admin.getUser);
router.patch("/users/:id/role", can("users:manage"), admin.setUserRole);
router.patch("/users/:id/status", can("users:manage"), admin.setUserStatus);
router.patch("/users/:id/active", can("users:manage"), admin.setUserActive);
router.get("/users/:id/gdpr-export", can("users:gdpr"), admin.gdprExport);
router.delete("/users/:id", can("users:gdpr"), admin.gdprDelete);
router.get("/export/users.:format", can("users:export"), admin.exportUsers);

router.get("/drivers", can("drivers:read"), admin.listDrivers);
router.get("/drivers/:userId", can("drivers:read"), admin.getDriver);
router.patch("/drivers/:userId/status", can("drivers:approve"), admin.setDriverStatus);
router.patch("/drivers/:userId/documents/:doc", can("drivers:approve"), admin.reviewDriverDocument);
router.get("/drivers/:userId/documents/:field/url", can("drivers:documents"), admin.getDriverDocumentUrl);
router.patch("/drivers/:userId/vehicle-change", can("drivers:approve"), admin.reviewDriverVehicleChange);
router.get("/export/drivers.:format", can("users:export"), admin.exportDrivers);

// Trips & disputes (6.4)
router.get("/trips", can("trips:read"), ops.listTrips);
router.get("/trips/:id", can("trips:read"), ops.getTrip);
router.get("/trips/:id/chat", can("trips:chat"), ops.getTripChat);
router.patch("/trips/:id/refund", can("trips:refund"), ops.refundTrip);
router.get("/disputes", can("disputes:manage"), ops.listDisputes);
router.patch("/disputes/:id", can("disputes:manage"), ops.updateDispute);

// Rentals & chauffeur (6.5)
router.get("/rentals/listings", can("rentals:read"), ops.listRentalListings);
router.patch("/rentals/listings/:id", can("rentals:manage"), ops.updateRentalListing);
router.post("/rentals/fleet", can("rentals:manage"), ops.createFleetListing);
router.patch("/rentals/fleet/:id", can("rentals:manage"), ops.updateFleetListing);
router.delete("/rentals/fleet/:id", can("rentals:manage"), ops.deleteFleetListing);
router.get("/rentals/bookings", can("rentals:read"), ops.listRentalBookings);
router.get("/chauffeur", can("chauffeur:read"), ops.listChauffeur);

// Finance (6.6) and cancellations / refunds (6.8)
router.get("/revenue", can("finance:read"), finance.revenue);
router.get("/payouts", can("finance:read"), finance.listPayouts);
router.get("/payouts/balances", can("finance:read"), finance.payoutBalances);
router.post("/payouts/run", can("finance:payouts"), finance.runDriverPayouts);
router.get("/payments", can("finance:read"), finance.listPayments);
router.get("/refunds", can("finance:read"), finance.listRefunds);
router.post("/refunds", can("finance:refunds"), finance.manualRefund);
router.post("/refunds/retry", can("finance:refunds"), finance.retryRefund);
router.get("/subscriptions", can("finance:read"), finance.listSubscriptions);
router.get("/subscriptions/transactions", can("finance:read"), finance.listSubscriptionTransactions);
router.get("/cancellations", can("trips:read"), ops.listCancellations);

// Driver programs (6.7)
router.get("/bonuses", can("bonuses:manage"), ops.listBonuses);
router.patch("/bonuses/:id", can("bonuses:manage"), ops.updateBonus);
router.get("/maintenance", can("maintenance:manage"), ops.listMaintenance);
router.patch("/maintenance/:id", can("maintenance:manage"), ops.updateMaintenance);

router.get("/legal", can("legal:write"), legal.adminList);
router.post("/legal", can("legal:write"), legal.adminCreate);
router.put("/legal/:slug", can("legal:write"), legal.adminUpdate);
router.delete("/legal/:slug", can("legal:write"), legal.adminDelete);

router.get("/promos", can("promos:manage"), ops.listPromos);
router.post("/promos", can("promos:manage"), ops.createPromo);
router.patch("/promos/:id", can("promos:manage"), ops.updatePromo);

export default router;
