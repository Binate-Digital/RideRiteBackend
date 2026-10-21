import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as notifications from "../controllers/notifications.controller.js";

const router = Router();
router.use(requireAuth, requireVerified);
router.get("/", notifications.list);
router.get("/prefs", notifications.getPrefs);
router.patch("/prefs", notifications.updatePrefs);
router.post("/read-all", notifications.markAllRead);
router.post("/:id/read", notifications.markRead);

export default router;
