import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as rides from "../controllers/rides.controller.js";
import * as tripChat from "../controllers/tripChat.controller.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";

const router = Router();

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests. Try again later." },
});

// Public fare estimate (auth optional later; require auth for alpha consistency)
router.post("/estimate", requireAuth, requireVerified, rides.estimate);

router.post("/promo/validate", requireAuth, requireVerified, writeLimiter, rides.validatePromo);

router.post("/", requireAuth, requireVerified, writeLimiter, rides.book);
router.get("/", requireAuth, requireVerified, rides.listMine);
router.get("/open", requireAuth, requireVerified, requireRole("driver", "admin"), rides.listOpen);

router.get("/:id", requireAuth, requireVerified, rides.getOne);
router.get("/:id/messages", requireAuth, requireVerified, tripChat.listMessages);
router.post("/:id/messages", requireAuth, requireVerified, writeLimiter, tripChat.sendMessage);
router.post("/:id/cancel", requireAuth, requireVerified, writeLimiter, rides.cancel);
router.post("/:id/accept", requireAuth, requireVerified, requireRole("driver", "admin"), writeLimiter, rides.accept);
router.post("/:id/reject", requireAuth, requireVerified, requireRole("driver", "admin"), writeLimiter, rides.reject);
router.patch("/:id/status", requireAuth, requireVerified, requireRole("driver", "admin"), writeLimiter, rides.updateStatus);
router.post("/:id/rate", requireAuth, requireVerified, writeLimiter, rides.rate);

export default router;
