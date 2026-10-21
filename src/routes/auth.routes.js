import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as auth from "../controllers/auth.controller.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many auth attempts. Try again later." },
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many attempts. Try again later." },
});

router.post("/signup", authLimiter, auth.signup);
router.post("/login", authLimiter, auth.login);
router.post("/verify-email", authLimiter, auth.verifyEmail);
router.get("/verify-email", authLimiter, auth.verifyEmail);
router.post("/resend-verification", sensitiveLimiter, auth.resendVerification);
router.post("/forgot-password", sensitiveLimiter, auth.forgotPassword);
router.post("/reset-password", sensitiveLimiter, auth.resetPassword);
router.post("/refresh", authLimiter, auth.refresh);
router.post("/social/:provider", authLimiter, auth.socialStub);
router.post("/phone/start", sensitiveLimiter, auth.phoneStartStub);
router.post("/phone/verify", sensitiveLimiter, auth.phoneVerifyStub);

router.get("/me", requireAuth, auth.me);
router.patch("/me", requireAuth, auth.updateProfile);
router.post("/change-password", requireAuth, auth.changePassword);
router.post("/logout", authLimiter, optionalAuth, auth.logout);

export default router;
