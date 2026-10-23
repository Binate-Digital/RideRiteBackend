import { DriverProfile } from "../models/DriverProfile.js";
import { Trip } from "../models/Trip.js";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";
import { declineOffer } from "./dispatch.js";
import {
  DOCUMENT_FIELDS,
  DOCUMENT_LABELS,
  DOCUMENT_TYPES,
  daysUntil,
  documentExpiry,
  isDocumentExpired,
  parseExpiryDay,
} from "./driverDocuments.js";

/**
 * Driver compliance (TRD 5.1 / 5.2): document uploads + expiry, and vehicle / tier changes
 * after approval. See driverDocuments.js for the document model.
 */

const dayKey = (d) => (d ? d.toISOString().slice(0, 10) : null);

async function notify(userId, payload) {
  const { notifyUser } = await import("../controllers/notifications.controller.js");
  return notifyUser(userId, payload);
}

/** Request body keys per document: file URL fields and the expiry date field. */
const DOCUMENT_INPUT = {
  license: { files: ["licenseFrontUrl", "licenseBackUrl"], expiry: "dlExpiresOn" },
  registration: { files: ["registrationDocUrl"], expiry: "registrationExpiresOn" },
  insurance: { files: ["insuranceDocUrl"], expiry: "insuranceExpiresOn" },
};

/**
 * Apply document files / expiry dates from a verification update. For each document that
 * changed (a new file or a new expiry date):
 *  - the expiry must be a real, non-past date;
 *  - an expired document can only be replaced by a new file AND a new expiry date;
 *  - that document goes to "pending" review (the account itself stays approved — only an
 *    expired document blocks driving) and its expiry notices start over.
 * Returns the documents that changed.
 */
export function applyDocumentUpdates(profile, data, now = new Date()) {
  const today = parseExpiryDay(now);
  const changed = [];
  for (const doc of DOCUMENT_TYPES) {
    const input = DOCUMENT_INPUT[doc];
    const fields = DOCUMENT_FIELDS[doc];
    const newFiles = input.files.filter((k) => data[k] && data[k] !== profile[k]);
    let expiry = null;
    let expiryChanged = false;
    const raw = data[input.expiry];
    // A form echoing back an old free-text value it can't change is not an update
    const echoesLegacy = fields.legacy && !profile[fields.expiresAt] && raw === profile[fields.legacy];
    if (raw !== undefined && raw !== null && raw !== "" && !echoesLegacy) {
      expiry = parseExpiryDay(data[input.expiry]);
      if (!expiry) throw httpError(400, `Enter a valid ${DOCUMENT_LABELS[doc]} expiry date (YYYY-MM-DD)`);
      expiryChanged = dayKey(expiry) !== dayKey(documentExpiry(profile, doc));
    }
    if (!newFiles.length && !expiryChanged) continue;
    if (expiryChanged && expiry < today) {
      throw httpError(400, `The ${DOCUMENT_LABELS[doc]} expiry date is in the past`, { code: "DOCUMENT_EXPIRED" });
    }
    if (isDocumentExpired(profile, doc, now) && (!newFiles.length || !expiryChanged)) {
      throw httpError(
        400,
        `Your ${DOCUMENT_LABELS[doc]} has expired — upload the new document together with its new expiry date`,
        { code: "DOCUMENT_REPLACEMENT_REQUIRED", document: doc },
      );
    }
    for (const k of newFiles) profile[k] = data[k];
    if (expiryChanged) {
      profile[fields.expiresAt] = expiry;
      // Keep the legacy string in step for older readers (admin panel)
      if (fields.legacy) profile[fields.legacy] = dayKey(expiry);
    }
    profile.set(`documentReview.${doc}`, { status: "pending", submittedAt: now, reviewedAt: null, note: "" });
    const notices = { ...(profile.documentNotices || {}) };
    delete notices[doc];
    profile.documentNotices = notices;
    profile.markModified("documentNotices");
    changed.push(doc);
  }
  return changed;
}

const VEHICLE_FIELDS = [
  "vehicleType",
  "vehicleMake",
  "vehicleModel",
  "vehicleColor",
  "vehiclePlate",
  "vehicleYear",
  "vehicleVin",
];

const normPlate = (p) => String(p ?? "").trim().toUpperCase();

/**
 * Vehicle details from the driver. Before approval everything applies directly. After
 * approval, a different vehicle type (tier) or plate means a different vehicle: it is staged
 * as `pendingVehicleChange` for admin re-review and the driver keeps operating — and is
 * dispatched — on the approved vehicle meanwhile. Other edits (colour, a VIN typo) to the
 * approved vehicle apply directly. Returns { pending: boolean }.
 */
export function applyVehicleUpdate(profile, data) {
  const fields = {};
  for (const k of VEHICLE_FIELDS) if (data[k] !== undefined) fields[k] = data[k];
  if (fields.vehiclePlate !== undefined) fields.vehiclePlate = normPlate(fields.vehiclePlate);
  if (fields.vehicleVin !== undefined) fields.vehicleVin = String(fields.vehicleVin || "").trim().toUpperCase();
  if (!Object.keys(fields).length) return { pending: Boolean(profile.pendingVehicleChange) };

  if (!profile.isApproved) {
    Object.assign(profile, fields);
    profile.pendingVehicleChange = null;
    return { pending: false };
  }
  const nextType = fields.vehicleType ?? profile.vehicleType;
  const nextPlate = fields.vehiclePlate ?? normPlate(profile.vehiclePlate);
  const sameVehicle = nextType === profile.vehicleType && nextPlate === normPlate(profile.vehiclePlate);
  if (sameVehicle) {
    Object.assign(profile, fields);
    return { pending: Boolean(profile.pendingVehicleChange) };
  }
  const prev = profile.pendingVehicleChange?.toObject?.() ?? profile.pendingVehicleChange ?? null;
  const base = prev && prev.vehiclePlate === nextPlate && prev.vehicleType === nextType ? prev : {};
  const current = Object.fromEntries(VEHICLE_FIELDS.map((k) => [k, profile[k]]));
  profile.pendingVehicleChange = {
    ...current,
    ...base,
    ...fields,
    vehicleType: nextType,
    vehiclePlate: nextPlate,
    // Re-saving the same requested vehicle keeps its place in the review queue
    requestedAt: base.requestedAt || new Date(),
  };
  return { pending: true };
}

/** Admin decision on a staged vehicle change (approve → it becomes the live vehicle). */
export async function reviewVehicleChange(userId, { approve, note = "" }) {
  const profile = await DriverProfile.findOne({ userId });
  if (!profile) throw httpError(404, "Driver profile not found");
  const change = profile.pendingVehicleChange?.toObject?.() ?? profile.pendingVehicleChange;
  if (!change) throw httpError(400, "No pending vehicle change");
  if (approve) {
    for (const k of VEHICLE_FIELDS) if (change[k] !== undefined) profile[k] = change[k];
  }
  profile.pendingVehicleChange = null;
  profile.lastVehicleChangeReview = { status: approve ? "approved" : "rejected", at: new Date(), note, change };
  await profile.save();
  await notify(userId, {
    category: "system",
    title: approve ? "Vehicle change approved" : "Vehicle change not approved",
    body: approve
      ? `You now drive ${[change.vehicleMake, change.vehicleModel].filter(Boolean).join(" ")} (${String(change.vehicleType).toUpperCase()}, ${change.vehiclePlate}).`
      : `Your request to switch to ${change.vehiclePlate} was declined${note ? `: ${note}` : ""}. You stay on your approved vehicle.`,
    data: { href: "/driver/profile" },
    email: true,
  });
  return profile;
}

/** Admin decision on one document. */
export async function reviewDocument(userId, doc, { status, note = "" }) {
  if (!DOCUMENT_TYPES.includes(doc)) throw httpError(400, "Unknown document");
  if (!["approved", "rejected"].includes(status)) throw httpError(400, "status must be approved or rejected");
  const profile = await DriverProfile.findOne({ userId });
  if (!profile) throw httpError(404, "Driver profile not found");
  const prev = profile.documentReview?.[doc] || {};
  profile.set(`documentReview.${doc}`, {
    status,
    submittedAt: prev.submittedAt || null,
    reviewedAt: new Date(),
    note,
  });
  await profile.save();
  if (status === "rejected") {
    await notify(userId, {
      category: "system",
      title: `Your ${DOCUMENT_LABELS[doc]} needs attention`,
      body: `We couldn't accept the ${DOCUMENT_LABELS[doc]} you uploaded${note ? `: ${note}` : ""}. Please upload it again.`,
      data: { href: "/driver/profile" },
      email: true,
    });
  }
  return profile;
}

/** Admin approved the whole account: every uploaded document counts as reviewed. */
export function markUploadedDocumentsApproved(profile, now = new Date()) {
  for (const doc of DOCUMENT_TYPES) {
    const has = DOCUMENT_FIELDS[doc].files.some((k) => profile[k]);
    const review = profile.documentReview?.[doc];
    if (has && review?.status !== "rejected") {
      profile.set(`documentReview.${doc}`, {
        status: "approved",
        submittedAt: review?.submittedAt || null,
        reviewedAt: now,
        note: "",
      });
    }
  }
}

/**
 * Copy pre Phase 4 free-text expiry strings into the Date fields. Unparseable strings are
 * left alone (they keep showing as-is and never block). Idempotent.
 */
export async function migrateLegacyExpiryDates() {
  let migrated = 0;
  for (const doc of DOCUMENT_TYPES) {
    const { expiresAt, legacy } = DOCUMENT_FIELDS[doc];
    if (!legacy) continue;
    const rows = await DriverProfile.find({ [expiresAt]: null, [legacy]: { $nin: [null, ""] } })
      .select(`_id ${legacy}`)
      .lean();
    for (const r of rows) {
      const d = parseExpiryDay(r[legacy]);
      if (!d) continue;
      await DriverProfile.updateOne({ _id: r._id, [expiresAt]: null }, { $set: { [expiresAt]: d } });
      migrated += 1;
    }
  }
  return migrated;
}

/**
 * Daily document-expiry sweep (TRD 5.2):
 *  - DOCUMENT_EXPIRY_NOTICE_DAYS before expiry (default 30, 7, 1 days) the driver is told once
 *    per threshold. When several thresholds are crossed at once only the closest is sent.
 *  - The day after the expiry day, the driver is told once and taken offline (a held ride
 *    offer moves on); readiness blocks going online until a replacement is uploaded.
 * Sent notices are recorded per document and expiry date, so a new date starts over.
 */
export async function sweepDocumentExpiry(now = new Date()) {
  const thresholds = env.documentExpiryNoticeDays;
  const horizon = new Date(now.getTime() + (Math.max(0, ...thresholds) + 1) * 86400000);
  const rows = await DriverProfile.find({
    $or: DOCUMENT_TYPES.map((doc) => ({ [DOCUMENT_FIELDS[doc].expiresAt]: { $ne: null, $lte: horizon } })),
  });
  let sent = 0;
  for (const profile of rows) {
    for (const doc of DOCUMENT_TYPES) {
      const expiry = documentExpiry(profile, doc);
      const left = daysUntil(expiry, now);
      if (left == null) continue;
      const forKey = dayKey(expiry);
      const prev = profile.documentNotices?.[doc];
      const record = prev?.for === forKey ? { ...prev, sent: { ...(prev.sent || {}) } } : { for: forKey, sent: {} };
      const label = DOCUMENT_LABELS[doc];
      let key = null;
      let payload = null;
      if (left < 0) {
        key = "expired";
        payload = {
          title: `Your ${label} has expired`,
          body: `It expired on ${forKey}. You can't go online or accept rides until you upload a new ${label} with its expiry date.`,
        };
      } else {
        const due = thresholds.filter((t) => left <= t);
        if (!due.length) continue;
        const target = Math.min(...due);
        key = String(target);
        for (const t of due) if (String(t) !== key && !record.sent[String(t)]) record.sent[String(t)] = "skipped";
        payload = {
          title: `Your ${label} expires ${left === 0 ? "today" : left === 1 ? "tomorrow" : `in ${left} days`}`,
          body: `It expires on ${forKey}. Upload the renewed ${label} in your driver profile to keep driving without interruption.`,
        };
      }
      if (record.sent[key]) continue;
      record.sent[key] = now;
      // Claim with a conditional update so overlapping sweeps never double-send
      const claimed = await DriverProfile.findOneAndUpdate(
        {
          _id: profile._id,
          $or: [
            { [`documentNotices.${doc}.for`]: { $ne: forKey } },
            { [`documentNotices.${doc}.sent.${key}`]: { $exists: false } },
          ],
        },
        { $set: { [`documentNotices.${doc}`]: record } },
      );
      if (!claimed) continue;
      if (key === "expired") await takeOffline(profile.userId);
      await notify(profile.userId, {
        category: "system",
        ...payload,
        data: { href: "/driver/profile", document: doc, expiresOn: forKey },
        email: true,
      });
      sent += 1;
    }
  }
  return sent;
}

async function takeOffline(userId) {
  const was = await DriverProfile.findOneAndUpdate({ userId, isOnline: true }, { $set: { isOnline: false } });
  if (!was) return;
  const holding = await Trip.find({ status: "requested", offeredDriverId: userId });
  for (const trip of holding) await declineOffer(trip, userId, "offline");
}
