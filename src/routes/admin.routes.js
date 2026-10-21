import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/auth.js";
import * as admin from "../controllers/admin.controller.js";

const router = Router();

router.use(requireAuth, requireRole("admin"));

router.get("/analytics", admin.analytics);
router.get("/users", admin.listUsers);
router.patch("/users/:id/role", admin.setUserRole);
router.get("/drivers", admin.listDrivers);
router.patch("/drivers/:userId/status", admin.setDriverStatus);
router.get("/trips", admin.listTrips);

export default router;
