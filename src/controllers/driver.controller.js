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
import { env as appEnv } from "../config/env.js";
import { driverCardsFor } from "../utils/tripDrivers.js";

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

export const updateVehicle = asyncHandler(async (req, res) => {
  const data = driverVehicleSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);
  Object.assign(profile, data);
  await profile.save();
  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  res.json({
    ok: true,
    driver: profile.toSafeJSON(),
    readiness: driverReadinessPayload(profile, { subscriptionActive }),
    testTools: testToolsEnabled(req.user),
  });
});

export const updateVerification = asyncHandler(async (req, res) => {
  const data = driverVerificationSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);

  const { skipForLater, addressLat, addressLng, ...fields } = data;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) profile[key] = value;
  }

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

  await profile.save();

  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  res.json({
    ok: true,
    user: req.user.toSafeJSON(),
    driver: profile.toSafeJSON(),
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
 * GET /api/driver/earnings — TRD 5.7 earnings dashboard: totals (today / 7 days / all time),
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
    commissionRate: appEnv.platformCommissionRate,
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
