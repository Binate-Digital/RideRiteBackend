import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as payments from "../controllers/payments.controller.js";
import * as connect from "../controllers/connect.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";

const router = Router();

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many payment requests. Try again later." },
});

router.get("/config", payments.getConfig);

router.use(requireAuth, requireVerified);

router.get("/mine", payments.listMyPayments);

router.post("/rides/:tripId/intent", writeLimiter, payments.createRidePaymentIntent);
router.post("/rides/:tripId/confirm-mock", writeLimiter, payments.confirmMockPayment);
router.post("/rides/:tripId/sync", writeLimiter, payments.syncRidePayment);

router.post("/methods/setup", writeLimiter, payments.createSetupIntent);
router.get("/methods", payments.listPaymentMethods);
router.post("/methods/mock-attach", writeLimiter, payments.mockAttachCard);
router.post("/methods/:id/default", writeLimiter, payments.setDefaultPaymentMethod);
router.delete("/methods/:id", writeLimiter, payments.detachPaymentMethod);

router.post("/connect/account", writeLimiter, connect.createConnectAccount);
router.get("/connect/status", connect.getConnectStatus);
router.post("/connect/onboarding-link", writeLimiter, connect.refreshOnboardingLink);

export default router;
