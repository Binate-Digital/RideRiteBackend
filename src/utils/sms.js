import { env } from "../config/env.js";
import { SmsOtp } from "../models/SmsOtp.js";
import { httpError } from "../middleware/errorHandler.js";
import { hashToken } from "./tokens.js";
import { twilioAccountConfigured, twilioRequest } from "./twilio.js";

/**
 * SMS one-time codes. Twilio Verify when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 * TWILIO_VERIFY_SERVICE_SID are set; otherwise the dev fallback accepts STATIC_SMS_OTP and
 * prints it to the server console (it is never returned to the client).
 */
export function smsProvider() {
  return twilioAccountConfigured() && env.twilio.verifyServiceSid ? "twilio" : "dev";
}

const MAX_FAILED_CHECKS = 5;
const HOUR_MS = 3600000;

/**
 * Send a code to `phoneE164` for `purpose`. Throttled per number: at most
 * SMS_OTP_MAX_PER_HOUR sends an hour, and SMS_OTP_RESEND_SECONDS between sends.
 */
export async function sendOtp(phoneE164, purpose) {
  const now = new Date();
  const provider = smsProvider();
  let row = await SmsOtp.findOne({ phoneE164, purpose });
  if (row) {
    if (now - row.windowStartedAt >= HOUR_MS) {
      row.windowStartedAt = now;
      row.sendsInWindow = 0;
    }
    const sinceLast = row.lastSentAt ? (now - row.lastSentAt) / 1000 : Infinity;
    if (sinceLast < env.smsOtpResendSeconds) {
      const wait = Math.ceil(env.smsOtpResendSeconds - sinceLast);
      throw httpError(429, `Wait ${wait}s before requesting another code`, { code: "OTP_RESEND_WAIT", retryAfterSeconds: wait });
    }
    if (row.sendsInWindow >= env.smsOtpMaxPerHour) {
      throw httpError(429, "Too many codes requested for this number. Try again later.", { code: "OTP_RATE_LIMITED" });
    }
  } else {
    row = new SmsOtp({ phoneE164, purpose, provider, windowStartedAt: now, sendsInWindow: 0 });
  }

  if (provider === "twilio") {
    try {
      await twilioRequest(
        `https://verify.twilio.com/v2/Services/${env.twilio.verifyServiceSid}/Verifications`,
        { To: phoneE164, Channel: "sms" },
      );
    } catch (err) {
      console.error(`[sms] Twilio Verify send failed for ${maskPhone(phoneE164)}:`, err.message);
      throw httpError(502, "Could not send the SMS code. Check the number and try again.", { code: "SMS_SEND_FAILED" });
    }
    row.codeHash = null;
  } else {
    const code = env.staticSmsOtp || "123456";
    row.codeHash = hashToken(`${phoneE164}:${code}`);
    console.log(`[sms] (dev) ${purpose} code for ${phoneE164}: ${code}`);
  }
  row.provider = provider;
  row.sendsInWindow += 1;
  row.lastSentAt = now;
  row.failedChecks = 0;
  row.consumedAt = null;
  row.expiresAt = new Date(now.getTime() + env.smsOtpTtlMinutes * 60000);
  await row.save();
  return { provider, expiresAt: row.expiresAt, resendSeconds: env.smsOtpResendSeconds };
}

/**
 * Check (and consume) a code. Throws 400 on a wrong / expired code; after
 * MAX_FAILED_CHECKS wrong tries the code is burned and a new one must be requested.
 */
export async function checkOtp(phoneE164, purpose, code) {
  const row = await SmsOtp.findOne({ phoneE164, purpose }).select("+codeHash");
  const invalid = () => httpError(400, "Invalid or expired code", { code: "OTP_INVALID" });
  if (!row || row.consumedAt || row.expiresAt < new Date()) throw invalid();
  if (row.failedChecks >= MAX_FAILED_CHECKS) {
    throw httpError(429, "Too many wrong codes. Request a new one.", { code: "OTP_LOCKED" });
  }

  let approved = false;
  if (row.provider === "twilio") {
    try {
      const check = await twilioRequest(
        `https://verify.twilio.com/v2/Services/${env.twilio.verifyServiceSid}/VerificationCheck`,
        { To: phoneE164, Code: String(code) },
      );
      approved = check?.status === "approved";
    } catch (err) {
      // 404 = no pending verification (expired / already approved)
      if (err.twilioStatus !== 404) {
        console.error(`[sms] Twilio Verify check failed for ${maskPhone(phoneE164)}:`, err.message);
        throw httpError(502, "Could not check the code right now. Try again.", { code: "SMS_CHECK_FAILED" });
      }
    }
  } else {
    approved = row.codeHash === hashToken(`${phoneE164}:${String(code)}`);
  }

  if (!approved) {
    await SmsOtp.updateOne({ _id: row._id }, { $inc: { failedChecks: 1 } });
    throw invalid();
  }
  // Single use: a second request with the same code fails
  const consumed = await SmsOtp.findOneAndUpdate(
    { _id: row._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );
  if (!consumed) throw invalid();
  return true;
}

export function maskPhone(e164 = "") {
  return `${String(e164).slice(0, -4).replace(/\d/g, "•")}${String(e164).slice(-4)}`;
}
