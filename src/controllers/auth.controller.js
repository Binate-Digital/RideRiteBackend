import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
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
  phoneStartSchema,
  phoneSignupSchema,
  phoneLoginSchema,
  phoneResetSchema,
  socialLoginSchema,
} from "../validators/auth.schemas.js";
import { e164ToDisplay, toE164 } from "../utils/phone.js";
import { checkOtp, sendOtp, smsProvider } from "../utils/sms.js";
import { socialProviders, verifyAppleIdToken, verifyGoogleIdToken } from "../utils/socialAuth.js";
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

function issueEmailOtp() {
  // Temporary static OTP for local/dev — never include in API responses or UI.
  return env.staticEmailOtp || "123456";
}

export const signup = asyncHandler(async (req, res) => {
  const data = signupSchema.parse(req.body);
  const email = data.email.toLowerCase();

  const existing = await User.findOne({ email });
  if (existing) throw httpError(409, "Email already registered");

  const passwordHash = await User.hashPassword(data.password);
  const otp = issueEmailOtp();

  const user = await User.create({
    fullName: data.fullName,
    email,
    phone: data.phone || null,
    passwordHash,
    role: data.role || "rider",
    isEmailVerified: false,
    profileCompleted: false,
    emailVerifyTokenHash: hashToken(otp),
    emailVerifyExpiresAt: hoursFromNow(env.emailVerifyExpiresHours),
  });

  if (user.role === "driver") {
    await DriverProfile.create({
      userId: user._id,
      isApproved: false,
      verificationStatus: "incomplete",
    });
  }

  const mail = verificationEmail({ fullName: user.fullName, otp });
  await sendMail({ to: user.email, ...mail });

  res.status(201).json({
    ok: true,
    message: "Account created. Enter the verification code sent to your email.",
    user: user.toSafeJSON(),
  });
});

export const login = asyncHandler(async (req, res) => {
  const data = loginSchema.parse(req.body);
  const byPhone = !data.email;
  const phoneE164 = byPhone ? toE164(data.phone) : null;
  if (byPhone && !phoneE164) throw httpError(400, "Enter a valid 10-digit US phone number");
  const invalidMsg = byPhone ? "Invalid phone number or password" : "Invalid email or password";

  const user = await User.findOne(
    byPhone ? { phoneE164 } : { email: data.email.toLowerCase() },
  ).select("+passwordHash +refreshTokens");
  if (!user) throw httpError(401, invalidMsg);
  if (!user.isActive) throw httpError(403, "Account is suspended");

  const valid = await user.comparePassword(data.password);
  if (!valid) throw httpError(401, invalidMsg);

  // A phone account is verified by its SMS code; email accounts by the email code
  if (!user.isVerified()) {
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
  const parsed = verifyEmailSchema.parse({
    email: req.body?.email || req.query?.email,
    otp: req.body?.otp || req.query?.otp,
    token: req.body?.token || req.query?.token || req.params?.token,
  });

  const code = parsed.otp || parsed.token;
  const tokenHash = hashToken(code);

  const query = {
    emailVerifyTokenHash: tokenHash,
    emailVerifyExpiresAt: { $gt: new Date() },
  };
  if (parsed.email) query.email = parsed.email.toLowerCase();

  const user = await User.findOne(query).select(
    "+emailVerifyTokenHash +emailVerifyExpiresAt +refreshTokens",
  );

  if (!user) throw httpError(400, "Invalid or expired verification code");

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
      message: "If that email exists and is unverified, a new code was sent.",
    });
  }

  const otp = issueEmailOtp();
  user.emailVerifyTokenHash = hashToken(otp);
  user.emailVerifyExpiresAt = hoursFromNow(env.emailVerifyExpiresHours);
  await user.save();

  const mail = verificationEmail({ fullName: user.fullName, otp });
  await sendMail({ to: user.email, ...mail });

  res.json({
    ok: true,
    message: "If that email exists and is unverified, a new code was sent.",
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
  if (data.phone !== undefined) {
    const nextE164 = data.phone ? toE164(data.phone) : null;
    if (req.user.phoneE164 && nextE164 !== req.user.phoneE164) {
      // The verified number is a sign-in method — only drop it when email can still sign in
      if (!req.user.email || !req.user.isEmailVerified) {
        throw httpError(400, "This number is how you sign in — it can't be changed here", {
          code: "PHONE_IS_LOGIN",
        });
      }
      req.user.phoneE164 = undefined;
      req.user.isPhoneVerified = false;
    }
    req.user.phone = data.phone;
  }
  if (data.avatarUrl !== undefined) req.user.avatarUrl = data.avatarUrl;
  if (data.profileCompleted !== undefined) {
    req.user.profileCompleted = data.profileCompleted;
  }
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

/** GET /api/auth/providers — which sign-in methods this server can verify */
export const providers = asyncHandler(async (_req, res) => {
  res.json({ ok: true, ...socialProviders(), phone: true, smsProvider: smsProvider() });
});

/** New account for a verified social / phone identity (+ driver profile when asked). */
async function createAccount(fields, role) {
  const user = await User.create({ ...fields, role, profileCompleted: false });
  if (role === "driver") {
    await DriverProfile.create({ userId: user._id, isApproved: false, verificationStatus: "incomplete" });
  }
  return user;
}

/**
 * POST /api/auth/social/:provider (google | apple) — body: { idToken, fullName?, role? }
 * Verifies the provider's ID token, then signs in the linked account; otherwise links an
 * existing account with the same verified email, otherwise creates one (email verified).
 */
export const socialLogin = asyncHandler(async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!["google", "apple"].includes(provider)) throw httpError(404, "Unknown social provider");
  const data = socialLoginSchema.parse(req.body || {});
  const identity =
    provider === "google" ? await verifyGoogleIdToken(data.idToken) : await verifyAppleIdToken(data.idToken);
  const idField = provider === "google" ? "googleId" : "appleId";
  const select = "+refreshTokens +googleId +appleId";

  let user = await User.findOne({ [idField]: identity.subject }).select(select);
  let created = false;
  if (!user && identity.email && identity.emailVerified) {
    user = await User.findOne({ email: identity.email }).select(select);
    if (user) {
      user[idField] = identity.subject;
      // The provider vouched for this address
      user.isEmailVerified = true;
    }
  }
  if (!user) {
    if (!identity.email && provider === "google") throw httpError(400, "Your Google account has no email address");
    const name = (data.fullName || identity.name || identity.email?.split("@")[0] || "").trim().slice(0, 80);
    const created_ = await createAccount(
      {
        fullName: name.length >= 2 ? name : "RideRite rider",
        ...(identity.email ? { email: identity.email } : {}),
        isEmailVerified: Boolean(identity.email && identity.emailVerified),
        [idField]: identity.subject,
      },
      data.role,
    );
    user = await User.findById(created_._id).select(select);
    created = true;
  }
  if (!user.isActive) throw httpError(403, "Account is suspended");
  // An Apple account may have no (verified) email — the provider identity verifies it
  if (!user.isVerified()) user.isEmailVerified = true;

  const tokens = await issueSession(user, req);
  res.status(created ? 201 : 200).json({
    ok: true,
    message: created ? "Account created" : "Logged in",
    created,
    user: user.toSafeJSON(),
    ...tokens,
  });
});

/**
 * POST /api/auth/phone/start — body: { phone, purpose: signup | login | reset }
 * Texts a one-time code. Signup refuses a number that already has an account; login /
 * reset answer the same whether or not the number exists (no account enumeration).
 */
export const phoneStart = asyncHandler(async (req, res) => {
  const { phone, purpose } = phoneStartSchema.parse(req.body || {});
  const phoneE164 = toE164(phone);
  const existing = await User.exists({ phoneE164 });
  if (purpose === "signup" && existing) {
    throw httpError(409, "This phone number already has an account — sign in instead", { code: "PHONE_TAKEN" });
  }
  let sent = null;
  if (purpose === "signup" || existing) sent = await sendOtp(phoneE164, purpose);
  res.json({
    ok: true,
    message: "If the number can receive codes, one is on its way.",
    resendSeconds: sent?.resendSeconds ?? env.smsOtpResendSeconds,
  });
});

/** POST /api/auth/phone/signup — body: { fullName, phone, otp, password, role? } */
export const phoneSignup = asyncHandler(async (req, res) => {
  const data = phoneSignupSchema.parse(req.body || {});
  const phoneE164 = toE164(data.phone);
  if (await User.exists({ phoneE164 })) {
    throw httpError(409, "This phone number already has an account — sign in instead", { code: "PHONE_TAKEN" });
  }
  await checkOtp(phoneE164, "signup", data.otp);
  const created = await createAccount(
    {
      fullName: data.fullName,
      phone: e164ToDisplay(phoneE164),
      phoneE164,
      isPhoneVerified: true,
      passwordHash: await User.hashPassword(data.password),
    },
    data.role,
  );
  const user = await User.findById(created._id).select("+refreshTokens");
  const tokens = await issueSession(user, req);
  res.status(201).json({ ok: true, message: "Account created", user: user.toSafeJSON(), ...tokens });
});

/** POST /api/auth/phone/verify — body: { phone, otp } — passwordless sign-in with an SMS code */
export const phoneLogin = asyncHandler(async (req, res) => {
  const data = phoneLoginSchema.parse(req.body || {});
  const phoneE164 = toE164(data.phone);
  await checkOtp(phoneE164, "login", data.otp);
  const user = await User.findOne({ phoneE164 }).select("+refreshTokens");
  if (!user) throw httpError(400, "Invalid or expired code", { code: "OTP_INVALID" });
  if (!user.isActive) throw httpError(403, "Account is suspended");
  if (!user.isPhoneVerified) user.isPhoneVerified = true;
  const tokens = await issueSession(user, req);
  res.json({ ok: true, message: "Logged in", user: user.toSafeJSON(), ...tokens });
});

/** POST /api/auth/phone/reset-password — body: { phone, otp, password } */
export const phoneResetPassword = asyncHandler(async (req, res) => {
  const data = phoneResetSchema.parse(req.body || {});
  const phoneE164 = toE164(data.phone);
  await checkOtp(phoneE164, "reset", data.otp);
  const user = await User.findOne({ phoneE164 }).select("+passwordHash +refreshTokens");
  if (!user) throw httpError(400, "Invalid or expired code", { code: "OTP_INVALID" });
  user.passwordHash = await User.hashPassword(data.password);
  user.refreshTokens = []; // force re-login everywhere
  await user.save();
  res.json({ ok: true, message: "Password updated. Please log in with your new password." });
});
