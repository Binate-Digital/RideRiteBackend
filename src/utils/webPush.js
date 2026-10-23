import webpush from "web-push";
import { env } from "../config/env.js";
import { PushSubscription } from "../models/PushSubscription.js";

/**
 * Web Push (VAPID). Enabled when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are
 * set; otherwise every send is a no-op and the web app hides its push toggle.
 * Generate keys once with: npx web-push generate-vapid-keys
 */
export function pushConfigured() {
  return Boolean(env.vapid.publicKey && env.vapid.privateKey && env.vapid.subject);
}

let vapidSet = false;
function ensureVapid() {
  if (!vapidSet) {
    webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
    vapidSet = true;
  }
}

/**
 * Push `{ title, body, url, tag }` to every browser the user subscribed. Expired
 * subscriptions (404 / 410 from the push service) are deleted. Never throws.
 */
export async function sendPushToUser(userId, payload) {
  if (!pushConfigured()) return { sent: 0, failed: 0, skipped: true };
  const subs = await PushSubscription.find({ userId }).lean();
  if (subs.length === 0) return { sent: 0, failed: 0 };
  ensureVapid();
  console.log(`[push] user ${userId}: sending to ${subs.length} subscription(s)`);
  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 3600, timeout: 10000 });
        sent += 1;
        await PushSubscription.updateOne({ _id: sub._id }, { $set: { lastSuccessAt: new Date() } });
      } catch (err) {
        failed += 1;
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        }
      }
    }),
  );
  console.log(`[push] user ${userId}: ${sent} sent, ${failed} failed`);
  return { sent, failed };
}
