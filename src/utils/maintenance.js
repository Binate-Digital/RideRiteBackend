import mongoose from "mongoose";
import { MaintenanceRecord } from "../models/MaintenanceRecord.js";
import { DriverSubscription } from "../models/DriverSubscription.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { env } from "../config/env.js";

/**
 * Company-covered maintenance schedule (TRD 5.6), for drivers with an active membership:
 *   oil change         every MAINTENANCE_OIL_CHANGE_MONTHS (3)
 *   full inspection    every MAINTENANCE_INSPECTION_MONTHS (12)
 * Each is counted from the last completed service of that type, or — before the first one —
 * from the driver's first active membership (DriverSubscription.firstActiveAt).
 *
 * A covered service can be requested from MAINTENANCE_REQUEST_WINDOW_DAYS (14) before its due
 * date onwards, at most one open (requested / scheduled) request per type. Requests are
 * recorded as coveredByPlatform; admin fills in the cost when it is completed.
 */

export const SERVICE_TYPES = {
  oil_change: { title: "Oil change (platform covered)", label: "Oil change", months: () => env.maintenance.oilChangeMonths },
  annual_inspection: {
    title: "Annual vehicle inspection (platform covered)",
    label: "Full vehicle inspection",
    months: () => env.maintenance.inspectionMonths,
  },
};

const OPEN = ["requested", "scheduled"];
const DAY_MS = 86400000;

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp (Nov 30 + 3 months → Feb 28/29, not Mar 2)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** The driver's membership: { active, firstActiveAt } (firstActiveAt backfilled for older rows). */
async function membership(userId) {
  const sub = await DriverSubscription.findOne({ userId });
  if (!sub) return { active: false, firstActiveAt: null };
  const active = sub.isActiveNow();
  if (!sub.firstActiveAt && (active || sub.lastPaymentAt)) {
    // Memberships from before this field existed: best known start of their coverage
    sub.firstActiveAt = sub.lastPaymentAt && sub.currentPeriodStart
      ? new Date(Math.min(sub.lastPaymentAt.getTime(), sub.currentPeriodStart.getTime()))
      : sub.currentPeriodStart || sub.lastPaymentAt || sub.createdAt;
    await DriverSubscription.updateOne({ _id: sub._id, firstActiveAt: null }, { $set: { firstActiveAt: sub.firstActiveAt } });
  }
  return { active, firstActiveAt: sub.firstActiveAt };
}

/**
 * Schedule per service type: anchor, next due date, state and whether a covered request can
 * be made right now. state: not_covered | upcoming | due_soon | overdue.
 */
export async function maintenanceSchedule(userId, now = new Date()) {
  const id = new mongoose.Types.ObjectId(String(userId));
  const { active, firstActiveAt } = await membership(id);
  const records = await MaintenanceRecord.find({ userId: id }).sort({ createdAt: -1 }).limit(200);
  const windowDays = env.maintenance.requestWindowDays;
  const services = [];
  for (const [type, cfg] of Object.entries(SERVICE_TYPES)) {
    const lastDone = records
      .filter((r) => r.type === type && r.status === "completed" && r.completedAt)
      .sort((a, b) => b.completedAt - a.completedAt)[0];
    const open = records.find((r) => r.type === type && OPEN.includes(r.status)) || null;
    const anchor = lastDone?.completedAt || firstActiveAt || null;
    const dueAt = anchor ? addMonths(anchor, cfg.months()) : null;
    const opensAt = dueAt ? new Date(dueAt.getTime() - windowDays * DAY_MS) : null;
    let state = "not_covered";
    if (active && dueAt) {
      state = now >= dueAt ? "overdue" : now >= opensAt ? "due_soon" : "upcoming";
    }
    const daysUntilDue = dueAt ? Math.ceil((dueAt.getTime() - now.getTime()) / DAY_MS) : null;
    let blockReason = null;
    if (!active) blockReason = "Maintenance coverage requires an active driver membership";
    else if (open) blockReason = `You already have an open ${cfg.label.toLowerCase()} request`;
    else if (state === "upcoming") {
      blockReason = `Not due yet — you can request it from ${opensAt.toLocaleDateString("en-US", { timeZone: "UTC" })}`;
    }
    services.push({
      type,
      label: cfg.label,
      everyMonths: cfg.months(),
      anchor,
      anchorSource: lastDone ? "last_service" : firstActiveAt ? "membership_start" : null,
      lastCompletedAt: lastDone?.completedAt || null,
      dueAt,
      requestOpensAt: opensAt,
      daysUntilDue,
      state,
      openRequest: open ? open.toSafeJSON() : null,
      canRequest: !blockReason,
      blockReason,
    });
  }
  return { coverageActive: active, firstActiveAt, services, records };
}

async function notify(userId, payload) {
  const { notifyUser } = await import("../controllers/notifications.controller.js");
  return notifyUser(userId, payload);
}

/**
 * Daily: tell each covered driver once when a service enters its request window and once
 * when it becomes overdue (skipped while a request for it is open). Keyed by due date.
 */
export async function sweepMaintenance(now = new Date()) {
  const subs = await DriverSubscription.find({ status: "active", currentPeriodEnd: { $gt: now } }).select("userId").lean();
  let sent = 0;
  for (const { userId } of subs) {
    const { services } = await maintenanceSchedule(userId, now);
    for (const s of services) {
      if (!["due_soon", "overdue"].includes(s.state) || s.openRequest) continue;
      const forKey = s.dueAt.toISOString().slice(0, 10);
      const key = s.state;
      const claimed = await DriverProfile.findOneAndUpdate(
        {
          userId,
          $or: [
            { [`maintenanceNotices.${s.type}.for`]: { $ne: forKey } },
            { [`maintenanceNotices.${s.type}.${key}`]: { $exists: false } },
          ],
        },
        [
          {
            $set: {
              [`maintenanceNotices.${s.type}`]: {
                $cond: [
                  { $eq: [`$maintenanceNotices.${s.type}.for`, forKey] },
                  { $mergeObjects: [`$maintenanceNotices.${s.type}`, { [key]: now }] },
                  { for: forKey, [key]: now },
                ],
              },
            },
          },
        ],
      );
      if (!claimed) continue;
      await notify(userId, {
        category: "maintenance",
        title: s.state === "overdue" ? `${s.label} overdue` : `${s.label} due ${forKey}`,
        body:
          s.state === "overdue"
            ? `Your covered ${s.label.toLowerCase()} was due on ${forKey}. Request it in the driver hub — the platform pays.`
            : `Your covered ${s.label.toLowerCase()} is due on ${forKey}. You can request it now in the driver hub.`,
        data: { href: "/driver", serviceType: s.type, dueAt: forKey },
      });
      sent += 1;
    }
  }
  return sent;
}
