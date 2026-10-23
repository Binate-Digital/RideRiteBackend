import { Router } from "express";
import * as driver from "../controllers/driver.controller.js";
import * as bonus from "../controllers/bonus.controller.js";
import * as maintenance from "../controllers/maintenance.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";

const router = Router();

router.use(requireAuth, requireVerified);

router.get("/me", driver.getProfile);
router.post("/ensure", driver.ensureDriverRole);
router.patch("/vehicle", driver.updateVehicle);
router.delete("/vehicle/pending-change", driver.cancelVehicleChange);
router.patch("/verification", driver.updateVerification);
router.post("/online", driver.goOnline);
router.post("/offline", driver.goOffline);
router.post("/location", driver.updateLocation);
router.get("/bonus/me", bonus.getMine);
router.get("/earnings", driver.getEarnings);
router.get("/earnings/statement.csv", driver.earningsStatementCsv);
router.get("/maintenance", maintenance.listMine);
router.post("/maintenance", maintenance.requestService);
router.post("/maintenance/:id/cancel", maintenance.cancelRequest);

export default router;
