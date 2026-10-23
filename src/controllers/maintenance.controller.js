import { MaintenanceRecord } from "../models/MaintenanceRecord.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { SERVICE_TYPES, maintenanceSchedule } from "../utils/maintenance.js";

function payload(schedule) {
  const { coverageActive, firstActiveAt, services, records } = schedule;
  return {
    coverageActive,
    coverage: {
      oilChangeEveryMonths: env.maintenance.oilChangeMonths,
      inspectionEveryMonths: env.maintenance.inspectionMonths,
      requestWindowDays: env.maintenance.requestWindowDays,
      firstActiveAt,
      note: coverageActive
        ? `The platform covers an oil change every ${env.maintenance.oilChangeMonths} months and a full inspection every ${env.maintenance.inspectionMonths} months.`
        : "Maintenance coverage requires an active driver membership.",
    },
    schedule: services,
    records: records.map((r) => r.toSafeJSON()),
  };
}

/** GET /api/driver/maintenance — schedule (next due per service), open requests, history */
export const listMine = asyncHandler(async (req, res) => {
  res.json({ ok: true, ...payload(await maintenanceSchedule(req.user._id)) });
});

/**
 * POST /api/driver/maintenance — body: { type: oil_change|annual_inspection, notes? }
 * Only when that service is due (or within MAINTENANCE_REQUEST_WINDOW_DAYS of due), with an
 * active membership and no open request of the same type. The platform covers it.
 */
export const requestService = asyncHandler(async (req, res) => {
  const type = String(req.body?.type || "");
  if (!SERVICE_TYPES[type]) throw httpError(400, "type must be oil_change or annual_inspection");
  const { services } = await maintenanceSchedule(req.user._id);
  const service = services.find((s) => s.type === type);
  if (!service.canRequest) {
    throw httpError(service.openRequest ? 409 : 403, service.blockReason, { code: "MAINTENANCE_NOT_AVAILABLE" });
  }
  const row = await MaintenanceRecord.create({
    userId: req.user._id,
    type,
    title: SERVICE_TYPES[type].title,
    notes: String(req.body?.notes || "").trim().slice(0, 1000),
    coveredByPlatform: true,
    dueAt: service.dueAt,
    status: "requested",
  });
  // Two requests racing past the check: keep the oldest, drop this one
  const open = await MaintenanceRecord.find({ userId: req.user._id, type, status: { $in: ["requested", "scheduled"] } })
    .sort({ createdAt: 1, _id: 1 })
    .select("_id");
  if (open.length > 1 && String(open[0]._id) !== String(row._id)) {
    await MaintenanceRecord.deleteOne({ _id: row._id });
    throw httpError(409, `You already have an open ${SERVICE_TYPES[type].label.toLowerCase()} request`);
  }
  const { notifyUser } = await import("./notifications.controller.js");
  await notifyUser(req.user._id, {
    category: "maintenance",
    title: `${SERVICE_TYPES[type].label} requested`,
    body: "We'll book it with a partner shop and let you know the appointment. The platform covers the cost.",
    data: { href: "/driver", maintenanceId: row._id.toString() },
  });
  res.status(201).json({ ok: true, record: row.toSafeJSON(), ...payload(await maintenanceSchedule(req.user._id)) });
});

/** POST /api/driver/maintenance/:id/cancel — withdraw a request admin hasn't booked yet */
export const cancelRequest = asyncHandler(async (req, res) => {
  const row = await MaintenanceRecord.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: "requested" },
    { $set: { status: "cancelled" } },
    { new: true },
  );
  if (!row) throw httpError(409, "Only a request that hasn't been booked yet can be cancelled");
  res.json({ ok: true, record: row.toSafeJSON(), ...payload(await maintenanceSchedule(req.user._id)) });
});
