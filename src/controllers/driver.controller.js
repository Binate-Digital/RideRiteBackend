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

async function getOrCreateProfile(user) {
  let profile = await DriverProfile.findOne({ userId: user._id });
  if (!profile) {
    if (user.role !== "driver" && user.role !== "admin") {
      user.role = "driver";
      await user.save();
    }
    profile = await DriverProfile.create({ userId: user._id });
  }
  return profile;
}

export const getProfile = asyncHandler(async (req, res) => {
  const profile = await getOrCreateProfile(req.user);
  res.json({
    ok: true,
    user: req.user.toSafeJSON(),
    driver: profile.toSafeJSON(),
    readiness: driverReadinessPayload(profile),
  });
});

export const updateVehicle = asyncHandler(async (req, res) => {
  const data = driverVehicleSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);
  Object.assign(profile, data);
  await profile.save();
  res.json({
    ok: true,
    driver: profile.toSafeJSON(),
    readiness: driverReadinessPayload(profile),
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

  if (isDriverVerificationComplete(profile)) {
    profile.verificationStatus = "pending";
    profile.verificationSubmittedAt = new Date();
    // Auto-approve for alpha; replace with admin review later
    profile.isApproved = true;
    profile.verificationStatus = "approved";
  } else if (!skipForLater) {
    // Become-driver form (docs may still be pending) — mark as submitted for review
    if (profile.dlNumber && profile.insuranceCarrier && profile.dateOfBirth) {
      profile.verificationStatus = "pending";
      profile.verificationSubmittedAt = profile.verificationSubmittedAt || new Date();
    } else {
      profile.verificationStatus = "incomplete";
    }
  }

  await profile.save();

  res.json({
    ok: true,
    driver: profile.toSafeJSON(),
    readiness: driverReadinessPayload(profile),
  });
});

export const goOnline = asyncHandler(async (req, res) => {
  const profile = await getOrCreateProfile(req.user);
  if (!isStripeConnectReady(profile)) {
    throw httpError(403, "Complete Stripe Connect onboarding before going online");
  }
  if (!isDriverVerificationComplete(profile)) {
    throw httpError(
      403,
      "Upload driver license and verification documents before going online",
    );
  }
  if (!profile.isApproved) throw httpError(403, "Driver not approved");
  if (!profile.vehiclePlate) {
    throw httpError(400, "Add vehicle plate before going online");
  }
  if (!canDriverHandleRides(profile)) {
    throw httpError(403, driverReadinessPayload(profile).blockReason || "Not ready");
  }
  profile.isOnline = true;
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
  res.json({
    ok: true,
    user: req.user.toSafeJSON(),
    driver: profile.toSafeJSON(),
    readiness: driverReadinessPayload(profile),
  });
});
