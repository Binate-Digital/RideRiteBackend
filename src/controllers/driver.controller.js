import { User } from "../models/User.js";
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
  res.json({
    ok: true,
    user: req.user.toSafeJSON(),
    driver: profile.toSafeJSON(),
    readiness: driverReadinessPayload(profile, { subscriptionActive }),
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
  });
});

export const updateVerification = asyncHandler(async (req, res) => {
  const data = driverVerificationSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);

  const { skipForLater, ...fields } = data;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) profile[key] = value;
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
    driver: profile.toSafeJSON(),
    readiness: driverReadinessPayload(profile, { subscriptionActive }),
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
  // Persist GPS on go-online (location lives on DriverProfile, not User)
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    profile.lastLocation = { lat, lng, updatedAt: new Date() };
  }
  await profile.save();
  res.json({ ok: true, message: "You are online", driver: profile.toSafeJSON() });
});

export const goOffline = asyncHandler(async (req, res) => {
  const profile = await getOrCreateProfile(req.user);
  profile.isOnline = false;
  await profile.save();
  res.json({ ok: true, message: "You are offline", driver: profile.toSafeJSON() });
});

export const updateLocation = asyncHandler(async (req, res) => {
  const { lat, lng } = driverLocationSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);
  profile.lastLocation = { lat, lng, updatedAt: new Date() };
  await profile.save();
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
  });
});
