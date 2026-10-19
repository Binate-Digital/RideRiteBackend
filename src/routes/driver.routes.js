import { Router } from "express";
import * as driver from "../controllers/driver.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";

const router = Router();

router.use(requireAuth, requireVerified);

router.get("/me", driver.getProfile);
router.post("/ensure", driver.ensureDriverRole);
router.patch("/vehicle", driver.updateVehicle);
router.post("/online", driver.goOnline);
router.post("/offline", driver.goOffline);
router.post("/location", driver.updateLocation);

export default router;
