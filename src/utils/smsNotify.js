import mongoose from "mongoose";
import { env } from "../config/env.js";
import { twilioAccountConfigured, twilioRequest } from "./twilio.js";

/**
 * SMS notification channel (Twilio Programmable Messaging) — separate from the Verify OTPs in
 * sms.js. Only high-value events pass `sms: true` to notifyUser (driver assigned / arrived,
 * trip cancelled, chauffeur reminder 1 h, booking confirmed, payment failed, membership past
 * due), and a text is sent only when:
 *   - the user has a verified phone (isPhoneVerified + phoneE164),
 *   - the SMS channel is on and that category's SMS toggle is on (User.notificationChannels.sms,
 *     User.smsPrefs — on by default for the SMS-eligible categories),
 *   - they got fewer than SMS_NOTIFY_MAX_PER_HOUR texts in the last hour.
 * TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_SMS_FROM + the account credentials send
 * real texts; without them the text is printed to the server console. Every attempt is logged
 * in SmsMessage (30 days) — also what the hourly limit counts.
 */

/** Categories that can text at all (the rest stay in-app / email / push). */
export const SMS_CATEGORIES = ["ride", "chauffeur", "rental", "payment", "subscription"];

const smsMessageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    category: { type: String, default: "" },
    /** Last 4 digits only */
    toLast4: { type: String, default: "" },
    body: { type: String, default: "" },
    status: { type: String, enum: ["sent", "console", "failed", "rate_limited"], required: true },
    providerId: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);
smsMessageSchema.index({ userId: 1, createdAt: -1 });
smsMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });

export const SmsMessage = mongoose.models.SmsMessage || mongoose.model("SmsMessage", smsMessageSchema);

export function smsNotifyProvider() {
  return twilioAccountConfigured() && (env.twilio.messagingServiceSid || env.twilio.smsFrom) ? "twilio" : "console";
}

/** Whether this user would get a text for `category` (prefs + verified phone). */
export function smsAllowed(user, category) {
  if (!SMS_CATEGORIES.includes(category)) return false;
  if (!user?.isPhoneVerified || !user.phoneE164) return false;
  if (user.notificationChannels?.sms === false) return false;
  return user.smsPrefs?.[category] !== false;
}

const clip = (s) => (s.length > 320 ? `${s.slice(0, 317)}…` : s);

/** Send one notification text (caller checked smsAllowed). Never throws. */
export async function sendSmsNotification(user, { category, title, body, href }) {
  try {
    const since = new Date(Date.now() - 3600000);
    const recent = await SmsMessage.countDocuments({ userId: user._id, status: { $in: ["sent", "console"] }, createdAt: { $gte: since } });
    const link = href ? ` ${env.webAppUrl}${href.startsWith("/") ? href : `/${href}`}` : "";
    const text = clip(`${env.appName}: ${title}. ${body}${link}`);
    const base = { userId: user._id, category, toLast4: String(user.phoneE164).slice(-4), body: text };
    if (recent >= env.smsNotifyMaxPerHour) {
      await SmsMessage.create({ ...base, status: "rate_limited" });
      return null;
    }
    if (smsNotifyProvider() === "console") {
      console.log(`[sms] (dev) notification to ***${base.toLast4}: ${text}`);
      return SmsMessage.create({ ...base, status: "console" });
    }
    try {
      const msg = await twilioRequest(`https://api.twilio.com/2010-04-01/Accounts/${env.twilio.accountSid}/Messages.json`, {
        To: user.phoneE164,
        Body: text,
        ...(env.twilio.messagingServiceSid ? { MessagingServiceSid: env.twilio.messagingServiceSid } : { From: env.twilio.smsFrom }),
      });
      return SmsMessage.create({ ...base, status: "sent", providerId: msg.sid || null });
    } catch (err) {
      console.error(`[sms] notification to ***${base.toLast4} failed:`, err.message);
      return SmsMessage.create({ ...base, status: "failed", error: String(err.message).slice(0, 300) });
    }
  } catch {
    return null;
  }
}
