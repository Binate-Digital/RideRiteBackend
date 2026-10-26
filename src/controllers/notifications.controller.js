import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { emitToUser } from "../realtime/index.js";
import { env } from "../config/env.js";
import { PushSubscription } from "../models/PushSubscription.js";
import { notificationEmail, sendMail } from "../utils/mailer.js";
import { pushConfigured, sendPushToUser } from "../utils/webPush.js";
import { SMS_CATEGORIES, sendSmsNotification, smsAllowed, smsNotifyProvider } from "../utils/smsNotify.js";

/** GET /api/notifications */
export const list = asyncHandler(async (req, res) => {
  const rows = await Notification.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(100);
  res.json({ ok: true, notifications: rows.map((r) => r.toSafeJSON()) });
});

/** POST /api/notifications/:id/read */
export const markRead = asyncHandler(async (req, res) => {
  const row = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { $set: { readAt: new Date() } },
    { new: true },
  );
  if (!row) throw httpError(404, "Notification not found");
  res.json({ ok: true, notification: row.toSafeJSON() });
});

/** POST /api/notifications/read-all */
export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany(
    { userId: req.user._id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  res.json({ ok: true });
});

const CATEGORY_KEYS = ["ride", "payment", "rental", "chauffeur", "subscription", "bonus", "maintenance", "payout", "promo"];
const DEFAULT_PREFS = {
  ride: true,
  payment: true,
  rental: true,
  chauffeur: true,
  subscription: true,
  bonus: true,
  maintenance: true,
  payout: true,
  promo: false,
};

function prefsPayload(user) {
  const prefs = { ...DEFAULT_PREFS };
  for (const key of CATEGORY_KEYS) {
    if (typeof user?.notificationPrefs?.[key] === "boolean") prefs[key] = user.notificationPrefs[key];
  }
  return {
    ...prefs,
    channels: {
      email: user?.notificationChannels?.email !== false,
      push: user?.notificationChannels?.push !== false,
      sms: user?.notificationChannels?.sms !== false,
    },
    /** SMS per category (only these categories can text) */
    sms: Object.fromEntries(SMS_CATEGORIES.map((c) => [c, user?.smsPrefs?.[c] !== false])),
  };
}

const PREFS_SELECT = "notificationPrefs notificationChannels smsPrefs phoneE164 isPhoneVerified";
const smsInfo = (user) => ({
  provider: smsNotifyProvider(),
  /** Texts need a verified phone number on the account */
  phoneVerified: Boolean(user?.isPhoneVerified && user?.phoneE164),
});

/**
 * GET/PATCH /api/notifications/prefs — categories, delivery channels
 * ({ channels: { email, push, sms } }) and per-category SMS ({ sms: { ride, … } }).
 */
export const getPrefs = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(PREFS_SELECT);
  res.json({
    ok: true,
    prefs: prefsPayload(user),
    push: { enabled: pushConfigured(), publicKey: env.vapid.publicKey || null },
    sms: smsInfo(user),
  });
});

export const updatePrefs = asyncHandler(async (req, res) => {
  const next = {};
  for (const key of CATEGORY_KEYS) {
    if (typeof req.body?.[key] === "boolean") next[`notificationPrefs.${key}`] = req.body[key];
  }
  for (const ch of ["email", "push", "sms"]) {
    if (typeof req.body?.channels?.[ch] === "boolean") next[`notificationChannels.${ch}`] = req.body.channels[ch];
  }
  for (const key of SMS_CATEGORIES) {
    if (typeof req.body?.sms?.[key] === "boolean") next[`smsPrefs.${key}`] = req.body.sms[key];
  }
  const user = await User.findByIdAndUpdate(req.user._id, { $set: next }, { new: true }).select(PREFS_SELECT);
  res.json({ ok: true, prefs: prefsPayload(user), sms: smsInfo(user) });
});

/** GET /api/notifications/push/config — VAPID public key for PushManager.subscribe */
export const pushConfig = asyncHandler(async (req, res) => {
  const count = await PushSubscription.countDocuments({ userId: req.user._id });
  res.json({ ok: true, enabled: pushConfigured(), publicKey: env.vapid.publicKey || null, subscriptions: count });
});

/** POST /api/notifications/push/subscribe — body: { subscription: { endpoint, keys: { p256dh, auth } } } */
export const pushSubscribe = asyncHandler(async (req, res) => {
  if (!pushConfigured()) {
    throw httpError(503, "Push notifications are not configured on this server", { code: "PUSH_NOT_CONFIGURED" });
  }
  const sub = req.body?.subscription || req.body || {};
  const endpoint = String(sub.endpoint || "");
  const p256dh = String(sub.keys?.p256dh || "");
  const auth = String(sub.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw httpError(400, "Invalid push subscription");
  // An endpoint belongs to one browser profile: re-subscribing moves it to whoever is signed in
  const row = await PushSubscription.findOneAndUpdate(
    { endpoint },
    { $set: { userId: req.user._id, keys: { p256dh, auth }, userAgent: String(req.get("user-agent") || "").slice(0, 300) } },
    { upsert: true, new: true },
  );
  await User.updateOne({ _id: req.user._id }, { $set: { "notificationChannels.push": true } });
  res.status(201).json({ ok: true, id: row._id.toString() });
});

/** POST /api/notifications/push/unsubscribe — body: { endpoint } (omit to remove every browser) */
export const pushUnsubscribe = asyncHandler(async (req, res) => {
  const endpoint = req.body?.endpoint ? String(req.body.endpoint) : null;
  const result = await PushSubscription.deleteMany({ userId: req.user._id, ...(endpoint ? { endpoint } : {}) });
  res.json({ ok: true, removed: result.deletedCount || 0 });
});

/**
 * Email a user if the category and the email channel are on. `mail` is { subject, text, html }.
 * Used for receipts and other emails that don't need an in-app row. Never throws.
 */
export async function emailUser(userId, category, mail) {
  try {
    const user = await User.findById(userId).select("fullName email notificationPrefs notificationChannels");
    if (!user?.email) return false;
    if (user.notificationPrefs?.[category] === false) return false;
    if (user.notificationChannels?.email === false) return false;
    await sendMail({ to: user.email, ...mail });
    return true;
  } catch {
    return false;
  }
}

/**
 * Notify a user on every channel their prefs allow (TRD 4.11):
 *   in-app  — stored + pushed over Socket.IO (always, unless the category is off)
 *   email   — when `email` is set: `true` for a generic email built from title/body, or a
 *             ready { subject, text, html } (e.g. a receipt); skipped if the email channel is off
 *   push    — Web Push to the user's subscribed browsers (default on; `push: false` skips),
 *             skipped if the push channel is off or VAPID is not configured
 *   sms     — when `sms` is set (high-value events only): a text to a verified phone, if the
 *             SMS channel and that category's SMS toggle are on (utils/smsNotify.js)
 * A category switched off suppresses every channel. Never throws.
 */
export async function notifyUser(userId, { category, title, body, data = {}, email = false, push = true, sms = false }) {
  try {
    const user = await User.findById(userId).select(
      "fullName email notificationPrefs notificationChannels smsPrefs phoneE164 isPhoneVerified",
    );
    const prefs = user?.notificationPrefs || {};
    if (prefs[category] === false) return null;
    const row = await Notification.create({ userId, category, title, body, data });
    emitToUser(String(userId), "notification:new", { notification: row.toSafeJSON() });

    const channels = user?.notificationChannels || {};
    if (email && user?.email && channels.email !== false) {
      const mail =
        typeof email === "object"
          ? email
          : notificationEmail({ fullName: user.fullName, title, body, href: data?.href });
      await sendMail({ to: user.email, ...mail });
    }
    if (push && channels.push !== false && pushConfigured()) {
      void sendPushToUser(userId, {
        title,
        body,
        url: data?.href || "/notifications",
        tag: data?.tripId || data?.rentalBookingId || data?.chauffeurBookingId || row._id.toString(),
        category,
      }).catch(() => {});
    }
    if (sms && smsAllowed(user, category)) {
      await sendSmsNotification(user, { category, title, body, href: data?.href });
    }
    return row;
  } catch {
    return null;
  }
}
