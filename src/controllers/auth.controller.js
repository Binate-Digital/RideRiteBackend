import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import {
  signupSchema,
  loginSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  refreshSchema,
  changePasswordSchema,
  updateProfileSchema,
} from "../validators/auth.schemas.js";
import {
  createOpaqueToken,
  hashToken,
  hoursFromNow,
  refreshExpiryDate,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../utils/tokens.js";
import {
  sendMail,
  verificationEmail,
  resetPasswordEmail,
} from "../utils/mailer.js";

function clientMeta(req) {
  return {
    userAgent: req.get("user-agent") || undefined,
    ip: req.ip,
  };
}

async function issueSession(user, req) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const tokenHash = hashToken(refreshToken);

  user.refreshTokens = (user.refreshTokens || []).filter(
    (t) => t.expiresAt > new Date(),
  );
  // keep last 10 sessions
  if (user.refreshTokens.length >= 10) {
    user.refreshTokens = user.refreshTokens.slice(-9);
  }
  user.refreshTokens.push({
    tokenHash,
    expiresAt: refreshExpiryDate(),
    ...clientMeta(req),
  });
  user.lastLoginAt = new Date();
  await user.save();

  return { accessToken, refreshToken };
}

function maybeDevToken(raw) {
  return env.isDev && env.exposeDevTokens ? raw : undefined;
}

export const signup = asyncHandler(async (req, res) => {
  const data = signupSchema.parse(req.body);
  const email = data.email.toLowerCase();

  const existing = await User.findOne({ email });
  if (existing) throw httpError(409, "Email already registered");

  const passwordHash = await User.hashPassword(data.password);
  const verifyRaw = createOpaqueToken();

  const user = await User.create({
    fullName: data.fullName,
    email,
    phone: data.phone || null,
    passwordHash,
    role: data.role || "rider",
    isEmailVerified: false,
    emailVerifyTokenHash: hashToken(verifyRaw),
    emailVerifyExpiresAt: hoursFromNow(env.emailVerifyExpiresHours),
  });

  const mail = verificationEmail({ fullName: user.fullName, token: verifyRaw });
  await sendMail({ to: user.email, ...mail });

  res.status(201).json({
    ok: true,
    message: "Account created. Please verify your email.",
    user: user.toSafeJSON(),
    ...(maybeDevToken(verifyRaw)
      ? { dev: { emailVerificationToken: verifyRaw } }
      : {}),
  });
});

export const login = asyncHandler(async (req, res) => {
  const data = loginSchema.parse(req.body);
  const email = data.email.toLowerCase();

  const user = await User.findOne({ email }).select(
    "+passwordHash +refreshTokens",
  );
  if (!user) throw httpError(401, "Invalid email or password");
  if (!user.isActive) throw httpError(403, "Account is suspended");

  const valid = await user.comparePassword(data.password);
  if (!valid) throw httpError(401, "Invalid email or password");

  if (!user.isEmailVerified) {
    return res.status(403).json({
      ok: false,
      error: "Email not verified",
      code: "EMAIL_NOT_VERIFIED",
      hint: "Call POST /api/auth/resend-verification then /api/auth/verify-email",
    });
  }

  const tokens = await issueSession(user, req);

  res.json({
    ok: true,
    message: "Logged in",
    user: user.toSafeJSON(),
    ...tokens,
  });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  const raw =
    req.body?.token ||
    req.query?.token ||
    req.params?.token;
  const { token } = verifyEmailSchema.parse({ token: raw });
  const tokenHash = hashToken(token);

  const user = await User.findOne({
    emailVerifyTokenHash: tokenHash,
    emailVerifyExpiresAt: { $gt: new Date() },
  }).select("+emailVerifyTokenHash +emailVerifyExpiresAt +refreshTokens");

  if (!user) throw httpError(400, "Invalid or expired verification token");

  user.isEmailVerified = true;
  user.emailVerifyTokenHash = null;
  user.emailVerifyExpiresAt = null;
  await user.save();

  const tokens = await issueSession(user, req);

  res.json({
    ok: true,
    message: "Email verified. You are now logged in.",
    user: user.toSafeJSON(),
    ...tokens,
  });
});

export const resendVerification = asyncHandler(async (req, res) => {
  const { email } = resendVerificationSchema.parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase() }).select(
    "+emailVerifyTokenHash +emailVerifyExpiresAt",
  );

  // Always 200 to avoid email enumeration
  if (!user || user.isEmailVerified) {
    return res.json({
      ok: true,
      message: "If that email exists and is unverified, a new link was sent.",
    });
  }

  const verifyRaw = createOpaqueToken();
  user.emailVerifyTokenHash = hashToken(verifyRaw);
  user.emailVerifyExpiresAt = hoursFromNow(env.emailVerifyExpiresHours);
  await user.save();

  const mail = verificationEmail({ fullName: user.fullName, token: verifyRaw });
  await sendMail({ to: user.email, ...mail });

  res.json({
    ok: true,
    message: "If that email exists and is unverified, a new link was sent.",
    ...(maybeDevToken(verifyRaw)
      ? { dev: { emailVerificationToken: verifyRaw } }
      : {}),
  });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  const user = await User.findOne({ email: email.toLowerCase() }).select(
    "+passwordResetTokenHash +passwordResetExpiresAt",
  );

  if (user) {
    const resetRaw = createOpaqueToken();
    user.passwordResetTokenHash = hashToken(resetRaw);
    user.passwordResetExpiresAt = hoursFromNow(env.passwordResetExpiresHours);
    await user.save();

    const mail = resetPasswordEmail({ fullName: user.fullName, token: resetRaw });
    await sendMail({ to: user.email, ...mail });

    return res.json({
      ok: true,
      message: "If that email exists, a reset token was sent.",
      ...(maybeDevToken(resetRaw) ? { dev: { passwordResetToken: resetRaw } } : {}),
    });
  }

  res.json({
    ok: true,
    message: "If that email exists, a reset token was sent.",
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const data = resetPasswordSchema.parse(req.body);
  const tokenHash = hashToken(data.token);

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpiresAt: { $gt: new Date() },
  }).select(
    "+passwordHash +passwordResetTokenHash +passwordResetExpiresAt +refreshTokens",
  );

  if (!user) throw httpError(400, "Invalid or expired reset token");

  user.passwordHash = await User.hashPassword(data.password);
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  user.refreshTokens = []; // force re-login everywhere
  await user.save();

  res.json({
    ok: true,
    message: "Password updated. Please log in with your new password.",
  });
});

export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw httpError(401, "Invalid or expired refresh token");
  }
  if (payload.typ !== "refresh") throw httpError(401, "Invalid refresh token type");

  const tokenHash = hashToken(refreshToken);
  const user = await User.findById(payload.sub).select("+refreshTokens");
  if (!user || !user.isActive) throw httpError(401, "User not found or inactive");

  const stored = (user.refreshTokens || []).find(
    (t) => t.tokenHash === tokenHash && t.expiresAt > new Date(),
  );
  if (!stored) throw httpError(401, "Refresh token revoked or expired");

  // rotate: remove old, issue new
  user.refreshTokens = user.refreshTokens.filter((t) => t.tokenHash !== tokenHash);
  const tokens = await issueSession(user, req);

  res.json({
    ok: true,
    message: "Token refreshed",
    user: user.toSafeJSON(),
    ...tokens,
  });
});

export const logout = asyncHandler(async (req, res) => {
  const refreshToken = req.body?.refreshToken;

  // Prefer authenticated logout; allow refresh-token-only logout when access JWT expired
  if (req.user?._id) {
    const user = await User.findById(req.user._id).select("+refreshTokens");
    if (!user) throw httpError(401, "Unauthorized");

    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      user.refreshTokens = (user.refreshTokens || []).filter(
        (t) => t.tokenHash !== tokenHash,
      );
    } else {
      user.refreshTokens = [];
    }
    await user.save();
    return res.json({ ok: true, message: "Logged out" });
  }

  if (!refreshToken) {
    throw httpError(400, "refreshToken is required when not authenticated");
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    // Idempotent: already invalid/expired is still a successful logout from the client POV
    return res.json({ ok: true, message: "Logged out" });
  }

  const tokenHash = hashToken(refreshToken);
  const user = await User.findById(payload.sub).select("+refreshTokens");
  if (user) {
    user.refreshTokens = (user.refreshTokens || []).filter(
      (t) => t.tokenHash !== tokenHash,
    );
    await user.save();
  }

  res.json({ ok: true, message: "Logged out" });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ ok: true, user: req.user.toSafeJSON() });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const data = updateProfileSchema.parse(req.body);
  if (data.fullName !== undefined) req.user.fullName = data.fullName;
  if (data.phone !== undefined) req.user.phone = data.phone;
  await req.user.save();
  res.json({ ok: true, user: req.user.toSafeJSON() });
});

export const changePassword = asyncHandler(async (req, res) => {
  const data = changePasswordSchema.parse(req.body);
  const user = await User.findById(req.user._id).select("+passwordHash +refreshTokens");
  const ok = await user.comparePassword(data.currentPassword);
  if (!ok) throw httpError(400, "Current password is incorrect");

  user.passwordHash = await User.hashPassword(data.newPassword);
  user.refreshTokens = [];
  await user.save();

  res.json({
    ok: true,
    message: "Password changed. Please log in again.",
  });
});
