import mongoose from "mongoose";
import bcrypt from "bcryptjs";

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
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, trim: true, maxlength: 20, default: null },
    avatarUrl: { type: String, default: null },
    profileCompleted: { type: Boolean, default: false },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ["rider", "driver", "admin"],
      default: "rider",
      index: true,
    },
    isEmailVerified: { type: Boolean, default: false },
    emailVerifyTokenHash: { type: String, default: null, select: false },
    emailVerifyExpiresAt: { type: Date, default: null, select: false },
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },
    refreshTokens: { type: [refreshTokenSchema], default: [], select: false },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    stripeCustomerId: { type: String, default: null, index: true },
    defaultPaymentMethodId: { type: String, default: null },
  },
  { timestamps: true },
);

userSchema.methods.comparePassword = async function comparePassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.hashPassword = async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    fullName: this.fullName,
    email: this.email,
    phone: this.phone,
    avatarUrl: this.avatarUrl,
    profileCompleted: this.profileCompleted,
    role: this.role,
    isEmailVerified: this.isEmailVerified,
    isActive: this.isActive,
    lastLoginAt: this.lastLoginAt,
    stripeCustomerId: this.stripeCustomerId,
    defaultPaymentMethodId: this.defaultPaymentMethodId,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const User = mongoose.model("User", userSchema);
