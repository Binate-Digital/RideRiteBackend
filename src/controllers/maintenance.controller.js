import { MaintenanceRecord } from "../models/MaintenanceRecord.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { driverHasActiveSubscription } from "./subscriptions.controller.js";

/** GET /api/driver/maintenance */
export const listMine = asyncHandler(async (req, res) => {
  const rows = await MaintenanceRecord.find({ userId: req.user._id }).sort({ dueAt: 1 });
  const active = await driverHasActiveSubscription(req.user._id);
  res.json({
    ok: true,
    coverageActive: active,
    coverage: {
      oilChangeEveryMonths: 3,
      annualInspection: true,
      note: active
        ? "Platform covers oil changes every 3 months and one annual inspection."
        : "Maintenance coverage requires an active driver subscription.",
    },
    records: rows.map((r) => r.toSafeJSON()),
  });
});

/** POST /api/driver/maintenance — schedule a covered service request */
export const requestService = asyncHandler(async (req, res) => {
  if (!(await driverHasActiveSubscription(req.user._id))) {
    throw httpError(403, "Active subscription required for maintenance coverage");
  }
  const type = ["oil_change", "annual_inspection", "other"].includes(req.body?.type)
    ? req.body.type
    : "oil_change";
  const titles = {
    oil_change: "Oil change (platform covered)",
    annual_inspection: "Annual vehicle inspection (platform covered)",
    other: "Maintenance request",
  };
  const dueAt = req.body?.dueAt ? new Date(req.body.dueAt) : new Date(Date.now() + 14 * 86400000);
  const row = await MaintenanceRecord.create({
    userId: req.user._id,
    type,
    title: titles[type],
    notes: String(req.body?.notes || "").trim(),
    coveredByPlatform: true,
    dueAt,
    status: "scheduled",
  });
  res.status(201).json({ ok: true, record: row.toSafeJSON() });
});
