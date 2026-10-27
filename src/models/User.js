import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { ADMIN_ROLES, effectiveAdminRole, permissionsFor } from "../utils/permissions.js";

const refreshTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
    userAgent: String,
    ip: String,
  },
  { _id: true },
);

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 80 },
    // Optional: phone-only accounts have none (unique only among accounts that have one)
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    phone: { type: String, trim: true, maxlength: 20, default: null },
    /** Normalized US number (+1XXXXXXXXXX) — set once the number is verified by SMS OTP. */
    phoneE164: { type: String, default: undefined },
    isPhoneVerified: { type: Boolean, default: false },
    /** Firebase Authentication uid (Google / Apple sign-in) */
    firebaseUid: { type: String, default: undefined, select: false },
    /** Google account id (`sub`) — also set by the earlier Google Identity Services sign-in */
    googleId: { type: String, default: undefined, select: false },
    /** Apple ID user identifier (`sub`) */
    appleId: { type: String, default: undefined, select: false },
    avatarUrl: { type: String, default: null },
    profileCompleted: { type: Boolean, default: false },
    // Social-only accounts have no password until they set one (reset flow)
    passwordHash: { type: String, default: null, select: false },
    role: {
      type: String,
      enum: ["rider", "driver", "admin"],
      default: "rider",
      index: true,
    },
    /** Admin RBAC role (TRD 6.1) — only for role "admin"; unset on a legacy admin = super_admin */
    adminRole: { type: String, enum: [...ADMIN_ROLES, null], default: null },
    isEmailVerified: { type: Boolean, default: false },
    emailVerifyTokenHash: { type: String, default: null, select: false },
    emailVerifyExpiresAt: { type: Date, default: null, select: false },
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },
    refreshTokens: { type: [refreshTokenSchema], default: [], select: false },
    isActive: { type: Boolean, default: true },
    /**
     * Why an account is inactive (admin action, TRD 6.3): suspended (temporary, safety /
     * compliance), deactivated (closed) or deleted (GDPR anonymized). Cleared on reactivation.
     */
    suspension: {
      type: new mongoose.Schema(
        {
          status: { type: String, enum: ["suspended", "deactivated", "deleted"] },
          reason: { type: String, default: "" },
          at: { type: Date, default: Date.now },
          by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    /** GDPR erasure: personal data was removed; financial records keep only the id */
    anonymizedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    stripeCustomerId: { type: String, default: null, index: true },
    defaultPaymentMethodId: { type: String, default: null },
    notificationPrefs: {
      ride: { type: Boolean, default: true },
      payment: { type: Boolean, default: true },
      rental: { type: Boolean, default: true },
      chauffeur: { type: Boolean, default: true },
      subscription: { type: Boolean, default: true },
      bonus: { type: Boolean, default: true },
      maintenance: { type: Boolean, default: true },
      payout: { type: Boolean, default: true },
      promo: { type: Boolean, default: false },
    },
    /** Delivery channels on top of in-app (category toggles above apply to every channel). */
    notificationChannels: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      /** Text messages for high-value events (needs a verified phone; utils/smsNotify.js) */
      sms: { type: Boolean, default: true },
    },
    /** Signup consent: "I agree to the Terms and Privacy Policy" (versions, e.g. "terms:v2,privacy:v1") */
    termsAcceptedAt: { type: Date, default: null },
    termsVersion: { type: String, default: null },
    /** SMS per category, on top of the category switch above (only SMS_CATEGORIES ever text) */
    smsPrefs: {
      ride: { type: Boolean, default: true },
      chauffeur: { type: Boolean, default: true },
      rental: { type: Boolean, default: true },
      payment: { type: Boolean, default: true },
      subscription: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

const presentString = (field) => ({ partialFilterExpression: { [field]: { $type: "string" } } });
userSchema.index({ email: 1 }, { unique: true, ...presentString("email") });
userSchema.index({ phoneE164: 1 }, { unique: true, ...presentString("phoneE164") });
userSchema.index({ firebaseUid: 1 }, { unique: true, ...presentString("firebaseUid") });
userSchema.index({ googleId: 1 }, { unique: true, ...presentString("googleId") });
userSchema.index({ appleId: 1 }, { unique: true, ...presentString("appleId") });

/** Email or verified phone — either one activates the account. */
userSchema.methods.isVerified = function isVerified() {
  return Boolean(this.isEmailVerified || this.isPhoneVerified);
};

userSchema.methods.comparePassword = async function comparePassword(plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.hashPassword = async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    fullName: this.fullName,
    email: this.email ?? null,
    phone: this.phone,
    isPhoneVerified: Boolean(this.isPhoneVerified),
    avatarUrl: this.avatarUrl,
    profileCompleted: this.profileCompleted,
    role: this.role,
    isEmailVerified: this.isEmailVerified,
    isActive: this.isActive,
    termsAcceptedAt: this.termsAcceptedAt ?? null,
    termsVersion: this.termsVersion ?? null,
    ...(this.role === "admin"
      ? { adminRole: effectiveAdminRole(this), permissions: permissionsFor(this) }
      : {}),
    lastLoginAt: this.lastLoginAt,
    stripeCustomerId: this.stripeCustomerId,
    defaultPaymentMethodId: this.defaultPaymentMethodId,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const User = mongoose.model("User", userSchema);
