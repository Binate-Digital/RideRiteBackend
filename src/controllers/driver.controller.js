import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import {
  driverVehicleSchema,
  driverLocationSchema,
} from "../validators/rides.schemas.js";
import { driverVerificationSchema } from "../validators/driver.schemas.js";
import {
  canDriverHandleRides,
  driverReadinessPayload,
  isDriverVerificationComplete,
  isStripeConnectReady,
} from "../utils/driverReadiness.js";
import { driverHasActiveSubscription } from "./subscriptions.controller.js";
import { relayDriverLocation } from "../realtime/index.js";
import { Trip } from "../models/Trip.js";
import { declineOffer } from "../utils/dispatch.js";
import { driverEarningsSummary } from "../utils/earnings.js";
import { DriverPayout } from "../models/DriverPayout.js";
import { DriverEarning } from "../models/DriverEarning.js";
import { driverCardsFor } from "../utils/tripDrivers.js";
import { applyDocumentUpdates, applyVehicleUpdate } from "../utils/driverCompliance.js";
import { getSettings } from "../utils/settings.js";
import {
  DOCUMENT_UPLOAD_FIELDS,
  deleteDocument,
  documentExists,
  keyBelongsTo,
  profileFieldFor,
  signedDocumentUrl,
} from "../utils/privateDocuments.js";

/**
 * Document fields may only be set to a key this driver uploaded (POST /api/uploads/driver-docs)
 * or left as they are — never to an arbitrary URL. Empty values mean "unchanged".
 */
async function checkDocumentRefs(profile, data, userId) {
  for (const field of Object.values(DOCUMENT_UPLOAD_FIELDS)) {
    const value = data[field];
    if (value === undefined || value === null || value === "") {
      delete data[field];
      continue;
    }
    if (value === profile[field]) continue;
    if (!keyBelongsTo(value, userId) || !(await documentExists(value))) {
      throw httpError(400, "Upload the document file first (POST /api/uploads/driver-docs)", {
        code: "DOCUMENT_REF_INVALID",
        field,
      });
    }
  }
}

/** Short-lived view URL for one document field (owner / admin checked by the caller). */
export async function documentUrlPayload(profile, fieldName, req) {
  const field = profileFieldFor(fieldName);
  if (!field) throw httpError(404, "Unknown document");
  const signed = await signedDocumentUrl(profile?.[field], { baseUrl: `${req.protocol}://${req.get("host")}` });
  if (!signed) throw httpError(404, "No file uploaded for this document");
  return { field, ...signed };
}

/** GET /api/driver/documents/:field/url — the signed-in driver's own document */
export const getMyDocumentUrl = asyncHandler(async (req, res) => {
  const profile = await DriverProfile.findOne({ userId: req.user._id });
  if (!profile) throw httpError(404, "Driver profile not found");
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ...(await documentUrlPayload(profile, req.params.field, req)) });
});

/** Seeded QA accounts (scripts/seed-test-accounts*) use this email domain. */
const TEST_ACCOUNT_DOMAIN = "@riderite.test";

/** Whether this driver's app should offer QA helpers such as "Simulate drive". */
function testToolsEnabled(user) {
  return env.enableTestTools || String(user.email || "").endsWith(TEST_ACCOUNT_DOMAIN);
}

async function getOrCreateProfile(user) {
  let profile = await DriverProfile.findOne({ userId: user._id });
  if (!profile) {
    if (user.role !== "driver" && user.role !== "admin") {
      user.role = "driver";
      await user.save();
    }
    profile = await DriverProfile.create({
      userId: user._id,
      isApproved: false,
      verificationStatus: "incomplete",
    });
  }
  return profile;
}

export const getProfile = asyncHandler(async (req, res) => {
  const profile = await getOrCreateProfile(req.user);
  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  // Same average riders see on the driver card (completed, rated trips)
  const card = (await driverCardsFor([req.user._id])).get(req.user._id.toString());
  res.json({
    ok: true,
    user: req.user.toSafeJSON(),
    driver: profile.toSafeJSON(),
    rating: card?.rating ?? { average: null, count: 0 },
    readiness: driverReadinessPayload(profile, { subscriptionActive }),
    testTools: testToolsEnabled(req.user),
  });
});

/**
 * PATCH /api/driver/vehicle — after approval, a new vehicle type or plate is staged as
 * `pendingVehicleChange` for admin re-review; the approved vehicle stays live meanwhile.
 */
export const updateVehicle = asyncHandler(async (req, res) => {
  const data = driverVehicleSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);
  const { pending } = applyVehicleUpdate(profile, data);
  await profile.save();
  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  res.json({
    ok: true,
    driver: profile.toSafeJSON(),
    vehicleChangePending: pending,
    readiness: driverReadinessPayload(profile, { subscriptionActive }),
    testTools: testToolsEnabled(req.user),
  });
});

/** DELETE /api/driver/vehicle/pending-change — withdraw a vehicle change awaiting review */
export const cancelVehicleChange = asyncHandler(async (req, res) => {
  const profile = await getOrCreateProfile(req.user);
  profile.pendingVehicleChange = null;
  await profile.save();
  res.json({ ok: true, driver: profile.toSafeJSON() });
});

const VEHICLE_KEYS = ["vehicleType", "vehicleMake", "vehicleModel", "vehicleColor", "vehiclePlate", "vehicleYear", "vehicleVin"];
/** Handled by applyDocumentUpdates (files + expiry dates), never assigned directly. */
const DOCUMENT_KEYS = [
  "licenseFrontUrl",
  "licenseBackUrl",
  "dlExpiresOn",
  "insuranceDocUrl",
  "insuranceExpiresOn",
  "registrationDocUrl",
  "registrationExpiresOn",
];

export const updateVerification = asyncHandler(async (req, res) => {
  const data = driverVerificationSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);
  const wasApproved = Boolean(profile.isApproved);

  const { skipForLater, addressLat, addressLng, ...fields } = data;
  await checkDocumentRefs(profile, fields, req.user._id.toString());
  const previousFiles = Object.fromEntries(Object.values(DOCUMENT_UPLOAD_FIELDS).map((f) => [f, profile[f]]));
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || VEHICLE_KEYS.includes(key) || DOCUMENT_KEYS.includes(key)) continue;
    profile[key] = value;
  }
  // Documents: new file / expiry → that document goes to pending review
  const changedDocuments = applyDocumentUpdates(profile, fields);
  // Vehicle: a new type or plate after approval waits for admin re-review
  const { pending: vehicleChangePending } = applyVehicleUpdate(profile, fields);

  // Persist map pin from address picker → homeLocation + lastLocation (so nearby search works)
  if (Number.isFinite(addressLat) && Number.isFinite(addressLng)) {
    const pin = { lat: addressLat, lng: addressLng, updatedAt: new Date() };
    profile.homeLocation = pin;
    profile.lastLocation = pin;
  } else if (
    (fields.addressLine1 || fields.city || fields.zip) &&
    !(profile.homeLocation?.lat != null && profile.homeLocation?.lng != null)
  ) {
    // Text address changed without coords — geocode once
    const { resolveDriverHomeBase } = await import("../utils/geocode.js");
    const resolved = await resolveDriverHomeBase(profile, null);
    if (resolved) {
      const pin = { lat: resolved.lat, lng: resolved.lng, updatedAt: new Date() };
      profile.homeLocation = pin;
      if (profile.lastLocation?.lat == null) profile.lastLocation = pin;
    }
  }

  if (skipForLater) {
    profile.verificationSkippedAt = new Date();
  }

  // An approved driver stays approved: updated documents are reviewed one by one
  // (documentReview) and only an expired document blocks driving.
  if (!wasApproved) {
    // Never auto-approve — admin reviews license/docs in RideRiteAdmin first.
    if (isDriverVerificationComplete(profile)) {
      profile.isApproved = false;
      profile.verificationStatus = "pending";
      profile.verificationSubmittedAt = new Date();
    } else if (!skipForLater) {
      // Become-driver form (docs may still be pending) — mark as submitted for review
      if (profile.dlNumber && profile.insuranceCarrier && profile.dateOfBirth) {
        profile.isApproved = false;
        profile.verificationStatus = "pending";
        profile.verificationSubmittedAt = profile.verificationSubmittedAt || new Date();
      } else {
        profile.isApproved = false;
        profile.verificationStatus = "incomplete";
      }
    }
  }

  await profile.save();
  // Replaced private files are removed (no orphaned copies of ID documents)
  for (const [field, old] of Object.entries(previousFiles)) {
    if (old && old !== profile[field]) void deleteDocument(old);
  }

  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  res.json({
    ok: true,
    user: req.user.toSafeJSON(),
    driver: profile.toSafeJSON(),
    changedDocuments,
    vehicleChangePending,
    readiness: driverReadinessPayload(profile, { subscriptionActive }),
    testTools: testToolsEnabled(req.user),
  });
});

export const goOnline = asyncHandler(async (req, res) => {
  const profile = await getOrCreateProfile(req.user);
  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  if (!profile.isApproved) throw httpError(403, "Driver not approved");
  if (!subscriptionActive) {
    throw httpError(403, "Active driver subscription required ($100/mo or $32/wk)");
  }
  if (!isStripeConnectReady(profile)) {
    throw httpError(403, "Complete Stripe Connect onboarding before going online");
  }
  if (!isDriverVerificationComplete(profile)) {
    throw httpError(
      403,
      "Upload driver license and verification documents before going online",
    );
  }
  if (!profile.vehiclePlate) {
    throw httpError(400, "Add vehicle plate before going online");
  }
  if (!canDriverHandleRides(profile, { subscriptionActive })) {
    throw httpError(
      403,
      driverReadinessPayload(profile, { subscriptionActive }).blockReason || "Not ready",
    );
  }
  profile.isOnline = true;
  // Location lives on DriverProfile.lastLocation (NOT User / NOT savedAddresses).
  // Always set a pin so riders can see this driver in nearby search.
  const bodyLat = Number(req.body?.lat);
  const bodyLng = Number(req.body?.lng);
  const { resolveDriverHomeBase } = await import("../utils/geocode.js");
  const resolved = await resolveDriverHomeBase(profile, {
    lat: bodyLat,
    lng: bodyLng,
  });
  if (resolved) {
    profile.lastLocation = {
      lat: resolved.lat,
      lng: resolved.lng,
      updatedAt: new Date(),
    };
  }
  await profile.save();
  res.json({
    ok: true,
    message: "You are online",
    driver: profile.toSafeJSON(),
    locationSource: resolved?.source || null,
  });
});

export const goOffline = asyncHandler(async (req, res) => {
  const profile = await getOrCreateProfile(req.user);
  profile.isOnline = false;
  await profile.save();
  // An offline driver can't take the ride they're being offered — pass it on now
  const holding = await Trip.find({ status: "requested", offeredDriverId: req.user._id });
  for (const trip of holding) await declineOffer(trip, req.user._id, "offline");
  res.json({ ok: true, message: "You are offline", driver: profile.toSafeJSON() });
});

export const updateLocation = asyncHandler(async (req, res) => {
  const { lat, lng } = driverLocationSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);
  profile.lastLocation = { lat, lng, updatedAt: new Date() };
  await profile.save();
  void relayDriverLocation(req.user._id, profile.lastLocation).catch(() => {});
  res.json({ ok: true, lastLocation: profile.lastLocation });
});

export const ensureDriverRole = asyncHandler(async (req, res) => {
  if (req.user.role !== "driver" && req.user.role !== "admin") {
    await User.findByIdAndUpdate(req.user._id, { role: "driver" });
    req.user.role = "driver";
  }
  const profile = await getOrCreateProfile(req.user);
  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  res.json({
    ok: true,
    user: req.user.toSafeJSON(),
    driver: profile.toSafeJSON(),
    readiness: driverReadinessPayload(profile, { subscriptionActive }),
    testTools: testToolsEnabled(req.user),
  });
});

/**
 * GET /api/driver/earnings — TRD 5.7 earnings dashboard: totals (today / 7 days / month / all time),
 * per-trip breakdown (fare, commission, net), bonuses, deductions and payout history.
 */
export const getEarnings = asyncHandler(async (req, res) => {
  const [{ totals, entries }, payouts] = await Promise.all([
    driverEarningsSummary(req.user._id),
    DriverPayout.find({ driverId: req.user._id }).sort({ createdAt: -1 }).limit(50),
  ]);
  const tripIds = entries.filter((e) => e.tripId).map((e) => e.tripId);
  const trips = await Trip.find({ _id: { $in: tripIds } })
    .select("pickupAddress destinationAddress fareCents paymentMethod completedAt cancelledAt status")
    .lean();
  const tripById = new Map(trips.map((t) => [String(t._id), t]));
  const row = (e) => {
    const t = e.tripId ? tripById.get(String(e.tripId)) : null;
    return {
      ...e.toSafeJSON(),
      trip: t
        ? {
            pickupAddress: t.pickupAddress,
            destinationAddress: t.destinationAddress,
            riderPaidCents: t.fareCents,
            paymentMethod: t.paymentMethod,
            status: t.status,
          }
        : null,
    };
  };
  res.json({
    ok: true,
    commissionRate: getSettings().commission.platformRate,
    totals,
    trips: entries.filter((e) => e.type === "trip").map(row),
    cancellationFees: entries.filter((e) => e.type === "cancellation_fee").map(row),
    rentals: entries.filter((e) => e.type === "rental").map(row),
    chauffeur: entries.filter((e) => e.type === "chauffeur").map(row),
    bonuses: entries.filter((e) => e.type === "bonus").map(row),
    adjustments: entries.filter((e) => e.type === "adjustment").map(row),
    deductions: entries.filter((e) => e.type === "deduction").map(row),
    payouts: payouts.map((p) => p.toSafeJSON()),
  });
});

const EARNING_TYPE_LABELS = {
  trip: "Trip",
  cancellation_fee: "Cancellation fee (legacy)",
  rental: "Rental host",
  chauffeur: "Private driver",
  bonus: "Bonus",
  adjustment: "Adjustment",
  deduction: "Deduction",
};

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  // Quote, and neutralise spreadsheet formulas in free text (addresses, descriptions)
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const dollars = (cents) => ((cents || 0) / 100).toFixed(2);

/**
 * GET /api/driver/earnings/statement.csv?from=YYYY-MM-DD&to=YYYY-MM-DD — the signed-in
 * driver's own ledger as CSV (one row per entry, newest first), then a payouts section.
 */
export const earningsStatementCsv = asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00Z`) : null;
  const to = req.query.to ? new Date(`${req.query.to}T00:00:00Z`) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    throw httpError(400, "from / to must be YYYY-MM-DD");
  }
  const filter = { driverId: req.user._id, status: { $ne: "void" } };
  if (from || to) {
    filter.earnedAt = {};
    if (from) filter.earnedAt.$gte = from;
    if (to) filter.earnedAt.$lt = new Date(to.getTime() + 86400000);
  }
  const [entries, payouts] = await Promise.all([
    DriverEarning.find(filter).sort({ earnedAt: -1 }).limit(10000).lean(),
    DriverPayout.find({ driverId: req.user._id }).sort({ createdAt: -1 }).limit(500).lean(),
  ]);
  const lines = [
    ["date", "type", "description", "gross_usd", "commission_usd", "net_usd", "status", "payout_id", "paid_at"].join(","),
  ];
  let net = 0;
  for (const e of entries) {
    net += e.netCents;
    lines.push(
      [
        new Date(e.earnedAt).toISOString(),
        EARNING_TYPE_LABELS[e.type] || e.type,
        e.description,
        dollars(e.grossCents),
        dollars(e.commissionCents),
        dollars(e.netCents),
        e.status,
        e.payoutId ? String(e.payoutId) : "",
        e.paidAt ? new Date(e.paidAt).toISOString() : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  lines.push(["", "Total", "", "", "", dollars(net), "", "", ""].map(csvCell).join(","));
  lines.push("");
  lines.push(["payout_date", "payout_id", "amount_usd", "items", "status", "test_payout"].join(","));
  for (const p of payouts) {
    lines.push(
      [
        new Date(p.paidAt || p.createdAt).toISOString(),
        String(p._id),
        dollars(p.amountCents),
        p.entryCount,
        p.status,
        p.simulated ? "yes" : "no",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const name = `riderite-earnings-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(`${lines.join("\n")}\n`);
});
