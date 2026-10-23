import { DriverSubscription } from "../models/DriverSubscription.js";
import { env } from "../config/env.js";
import { migrateLegacyExpiryDates, sweepDocumentExpiry } from "./driverCompliance.js";
import { sweepBonuses } from "./bonus.js";
import { sweepMaintenance } from "./maintenance.js";

/**
 * Daily driver housekeeping (DRIVER_SWEEP_MINUTES, default once a day, plus once shortly after
 * start). Every step is idempotent, so running it more often or on several instances is safe:
 *  - document expiry notices (30 / 7 / 1 days) and blocking expired documents (TRD 5.2)
 *  - monthly bonus: refresh the current month, freeze ended months (TRD 5.5)
 *  - maintenance due / overdue notices (TRD 5.6)
 *  - membership ending soon (no auto-renewal) notices (TRD 5.9)
 */

let timer = null;
let running = false;

/** Memberships set to end (cancel at period end, or mock memberships that never renew). */
export async function sweepSubscriptionExpiry(now = new Date()) {
  const days = env.subscriptionExpiryNoticeDays;
  if (!(days > 0)) return 0;
  const horizon = new Date(now.getTime() + days * 86400000);
  const ending = await DriverSubscription.find({
    status: "active",
    currentPeriodEnd: { $gt: now, $lte: horizon },
    $or: [{ cancelAtPeriodEnd: true }, { stripeSubscriptionId: null }],
  });
  let sent = 0;
  for (const sub of ending) {
    const claimed = await DriverSubscription.findOneAndUpdate(
      { _id: sub._id, expiryNoticeFor: { $ne: sub.currentPeriodEnd } },
      { $set: { expiryNoticeFor: sub.currentPeriodEnd } },
    );
    if (!claimed) continue;
    const { notifyUser } = await import("../controllers/notifications.controller.js");
    await notifyUser(sub.userId, {
      category: "subscription",
      title: "Your driver membership ends soon",
      body: `It ends on ${sub.currentPeriodEnd.toLocaleDateString("en-US")} and won't renew automatically. Renew in Billing to keep receiving ride requests.`,
      data: { href: "/driver/billing" },
      email: true,
    });
    sent += 1;
  }
  return sent;
}

export async function sweepDrivers(now = new Date()) {
  if (running) return null;
  running = true;
  const result = {};
  const step = async (name, fn) => {
    try {
      result[name] = await fn();
    } catch (err) {
      console.error(`[drivers] ${name} sweep failed:`, err.message);
    }
  };
  try {
    await step("legacyExpiryMigrated", () => migrateLegacyExpiryDates());
    await step("documentNotices", () => sweepDocumentExpiry(now));
    await step("bonuses", () => sweepBonuses(now));
    await step("maintenanceNotices", () => sweepMaintenance(now));
    await step("subscriptionNotices", () => sweepSubscriptionExpiry(now));
  } finally {
    running = false;
  }
  return result;
}

export function startDriverSweeper() {
  if (timer) return;
  const run = () =>
    sweepDrivers().then((r) => {
      if (r && Object.values(r).some((v) => (typeof v === "number" ? v > 0 : v?.frozen > 0))) {
        console.log("[drivers] sweep", JSON.stringify(r));
      }
    });
  setTimeout(run, 10_000).unref?.();
  timer = setInterval(run, env.driverSweepMinutes * 60 * 1000);
  timer.unref?.();
}
