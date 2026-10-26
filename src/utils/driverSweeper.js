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
 *  - membership ending notices (cancelled auto-renew / manual memberships) and expiring lapsed
 *    manual memberships (TRD 5.9)
 */

let timer = null;
let running = false;

const day = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Notice copy for a membership that will not renew, by billing state. Auto-renewing Stripe
 * subscriptions get no notice (Stripe charges and `invoice.paid` sends "Membership renewed").
 * Every action named here is on /driver/billing (Resume / Renew / Set up auto-renew).
 */
export function membershipEndingNotice(sub) {
  const ends = day(sub.currentPeriodEnd);
  if (sub.billingState() === "ending") {
    return {
      title: "Your driver membership is set to end",
      body: `It ends on ${ends} because auto-renew is cancelled. Tap Resume in Billing to keep receiving ride requests.`,
    };
  }
  return {
    title: "Your driver membership ends soon",
    body: `It ends on ${ends} and won't renew automatically. Tap Renew in Billing to keep receiving ride requests.`,
  };
}

/**
 * Memberships that will end: Stripe ones set to cancel at period end, and manual ones (no
 * Stripe subscription — mock / seeded) that never renew. One notice per period.
 */
export async function sweepSubscriptionExpiry(now = new Date()) {
  const days = env.subscriptionExpiryNoticeDays;
  if (!(days > 0)) return 0;
  const horizon = new Date(now.getTime() + days * 86400000);
  const ending = await DriverSubscription.find({
    status: "active",
    currentPeriodEnd: { $gt: now, $lte: horizon },
    // A manual membership whose auto-renew setup is under way will renew — no notice
    $or: [{ cancelAtPeriodEnd: true, stripeSubscriptionId: { $ne: null } }, { stripeSubscriptionId: null }],
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
      ...membershipEndingNotice(sub),
      data: { href: "/driver/billing", state: sub.billingState() },
      email: true,
    });
    sent += 1;
  }
  return sent;
}

/**
 * Manual memberships past their period end: Stripe never tells us (there is no Stripe
 * subscription), so mark them expired, take the driver offline and say so. An hour's grace
 * (driving is already blocked at period end) leaves room for an admin / QA fixing the date.
 */
const LAPSE_GRACE_MS = 3600000;
export async function sweepManualLapses(now = new Date()) {
  const cutoff = new Date(now.getTime() - LAPSE_GRACE_MS);
  const lapsed = await DriverSubscription.find({
    status: "active",
    stripeSubscriptionId: null,
    currentPeriodEnd: { $lte: cutoff },
  }).select("_id userId");
  let n = 0;
  for (const sub of lapsed) {
    const claimed = await DriverSubscription.findOneAndUpdate(
      { _id: sub._id, status: "active", stripeSubscriptionId: null, currentPeriodEnd: { $lte: cutoff } },
      { $set: { status: "expired" } },
    );
    if (!claimed) continue;
    const { forceDriverOffline } = await import("./subscriptionBilling.js");
    await forceDriverOffline(sub.userId, "expired");
    n += 1;
  }
  return n;
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
    await step("manualMembershipsLapsed", () => sweepManualLapses(now));
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
