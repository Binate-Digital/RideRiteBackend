import os from "node:os";
import { PayoutRun } from "../models/PayoutRun.js";
import { env } from "../config/env.js";
import { runPayouts } from "./payouts.js";

/**
 * Automatic weekly driver payouts (TRD 5.7). Disabled unless AUTO_PAYOUTS_ENABLED=true.
 *
 * Every PAYOUT_SWEEP_MINUTES each instance checks whether this week's slot
 * (PAYOUT_SCHEDULE_DAY at PAYOUT_SCHEDULE_HOUR_UTC) has passed; the first to insert that
 * slot's PayoutRun row runs the same logic as the admin "Run payouts" button (claims each
 * driver's pending entries, one Stripe Connect transfer per driver — idempotent per entry).
 * A slot missed by more than CATCH_UP_HOURS (all instances down) is skipped, not paid late
 * at a surprising time; the following week picks the balance up.
 */

const DAY_MS = 86400000;
const CATCH_UP_HOURS = 48;
let timer = null;

/** This week's slot at or before `now` (UTC). */
export function lastScheduledPayout(now = new Date(), { day = env.autoPayouts.day, hourUtc = env.autoPayouts.hourUtc } = {}) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  const back = (now.getUTCDay() - day + 7) % 7;
  let slot = new Date(today.getTime() - back * DAY_MS);
  if (slot > now) slot = new Date(slot.getTime() - 7 * DAY_MS);
  return slot;
}

/** When the next automatic payout happens (null while automatic payouts are off). */
export async function nextScheduledPayout(now = new Date()) {
  if (!env.autoPayouts.enabled) return null;
  const last = lastScheduledPayout(now);
  const ranLast = await PayoutRun.exists({ key: slotKey(last) });
  // Due but not run yet (next sweep picks it up) → that slot; otherwise next week
  if (!ranLast && now.getTime() - last.getTime() <= CATCH_UP_HOURS * 3600000) return last;
  return new Date(last.getTime() + 7 * DAY_MS);
}

export const slotKey = (slot) => slot.toISOString().slice(0, 10);

/** Public schedule info for the driver earnings page. */
export async function payoutScheduleInfo(now = new Date()) {
  return {
    automatic: env.autoPayouts.enabled,
    nextPayoutAt: await nextScheduledPayout(now),
    weekday: env.autoPayouts.day,
    hourUtc: env.autoPayouts.hourUtc,
    minCents: env.autoPayouts.minCents,
  };
}

/** One sweep: run this week's payouts once (across all instances). */
export async function runScheduledPayouts(now = new Date(), { instance = `${os.hostname()}:${process.pid}` } = {}) {
  if (!env.autoPayouts.enabled) return { skipped: "disabled" };
  const slot = lastScheduledPayout(now);
  if (now.getTime() - slot.getTime() > CATCH_UP_HOURS * 3600000) return { skipped: "outside window", slot };
  const key = slotKey(slot);
  let run;
  try {
    run = await PayoutRun.create({ key, scheduledFor: slot, instance, startedAt: now });
  } catch (err) {
    if (err?.code === 11000) return { skipped: "already ran", key };
    throw err;
  }
  try {
    const results = await runPayouts({ minCents: env.autoPayouts.minCents });
    const paid = results.filter((r) => r.payout?.status === "paid");
    run.driversPaid = paid.length;
    run.driversFailed = results.filter((r) => r.error).length;
    run.driversSkipped = results.filter((r) => r.skipped).length;
    run.amountCents = paid.reduce((a, r) => a + (r.payout.amountCents || 0), 0);
    run.status = "done";
    run.finishedAt = new Date();
    await run.save();
    console.log(
      `[payouts] weekly run ${key}: ${run.driversPaid} paid ($${(run.amountCents / 100).toFixed(2)}), ${run.driversSkipped} skipped, ${run.driversFailed} failed`,
    );
    return { ran: true, key, run: run.toSafeJSON(), results };
  } catch (err) {
    run.status = "failed";
    run.error = err.message;
    run.finishedAt = new Date();
    await run.save();
    console.error(`[payouts] weekly run ${key} failed:`, err.message);
    return { ran: true, key, error: err.message };
  }
}

export function startPayoutScheduler() {
  if (timer) return;
  if (!env.autoPayouts.enabled) {
    console.log("[payouts] automatic weekly payouts are off (AUTO_PAYOUTS_ENABLED=false) — run them from admin");
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledPayouts();
    } catch (err) {
      console.error("[payouts] scheduler sweep failed", err);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, env.autoPayouts.sweepMinutes * 60000);
  timer.unref?.();
  setTimeout(tick, 3000).unref?.();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  console.log(
    `[payouts] automatic weekly payouts: ${days[env.autoPayouts.day]} ${String(env.autoPayouts.hourUtc).padStart(2, "0")}:00 UTC, minimum $${(env.autoPayouts.minCents / 100).toFixed(2)}`,
  );
}
