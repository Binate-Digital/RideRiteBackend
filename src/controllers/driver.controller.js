import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import {
  driverVehicleSchema,
  driverLocationSchema,
} from "../validators/rides.schemas.js";

async function getOrCreateProfile(user) {
  let profile = await DriverProfile.findOne({ userId: user._id });
  if (!profile) {
    if (user.role !== "driver" && user.role !== "admin") {
      // Promote rider → driver on first driver-hub use (alpha onboarding shortcut)
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
  });
});

export const updateVehicle = asyncHandler(async (req, res) => {
  const data = driverVehicleSchema.parse(req.body);
  const profile = await getOrCreateProfile(req.user);
  Object.assign(profile, data);
  await profile.save();
  res.json({ ok: true, driver: profile.toSafeJSON() });
});

export const goOnline = asyncHandler(async (req, res) => {
  const profile = await getOrCreateProfile(req.user);
  if (!profile.isApproved) throw httpError(403, "Driver not approved");
  if (!profile.vehiclePlate) {
    throw httpError(400, "Add vehicle plate before going online");
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

/** Dev helper: create/ensure a verified driver user quickly via auth signup role=driver */
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
  });
});
