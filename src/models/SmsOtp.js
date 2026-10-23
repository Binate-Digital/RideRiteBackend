import mongoose from "mongoose";

/**
 * SMS one-time-code state per (phone, purpose). Tracks send throttling and failed checks.
 * With Twilio Verify the code itself lives at Twilio (codeHash stays null); in the dev
 * fallback the static code's hash is stored here.
 */
const smsOtpSchema = new mongoose.Schema(
  {
    phoneE164: { type: String, required: true },
    purpose: { type: String, enum: ["signup", "login", "reset"], required: true },
    provider: { type: String, enum: ["twilio", "dev"], required: true },
    codeHash: { type: String, default: null, select: false },
    expiresAt: { type: Date, required: true },
    /** Rolling one-hour send window */
    windowStartedAt: { type: Date, default: Date.now },
    sendsInWindow: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: null },
    failedChecks: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

smsOtpSchema.index({ phoneE164: 1, purpose: 1 }, { unique: true });
// Rows are only useful for an hour or so (throttle window); let Mongo clean them up
smsOtpSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export const SmsOtp = mongoose.model("SmsOtp", smsOtpSchema);
