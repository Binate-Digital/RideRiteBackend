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
router.get("/providers", auth.providers);
router.post("/social/:provider", authLimiter, auth.socialLogin);
// Per-IP limit here; per-number send limits live in utils/sms.js
router.post("/phone/start", sensitiveLimiter, auth.phoneStart);
router.post("/phone/signup", sensitiveLimiter, auth.phoneSignup);
router.post("/phone/verify", sensitiveLimiter, auth.phoneLogin);
router.post("/phone/reset-password", sensitiveLimiter, auth.phoneResetPassword);

router.get("/me", requireAuth, auth.me);
router.patch("/me", requireAuth, auth.updateProfile);
router.post("/change-password", requireAuth, auth.changePassword);
router.post("/logout", authLimiter, optionalAuth, auth.logout);

export default router;
