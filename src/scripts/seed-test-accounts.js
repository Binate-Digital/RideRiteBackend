/**
 * Create (or reset) ready-to-use test accounts for UAT / local QA:
 * one rider and four drivers that can go online and accept rides
 * immediately — email verified, KYC approved, vehicle + plate set,
 * active monthly subscription and Stripe Connect marked ready.
 *
 * Safe to re-run: accounts are matched by email and reset to this state
 * (password included). Drivers start OFFLINE — log in as each driver and
 * tap "Go online" so riders see a live car on the map.
 *
 * Usage:
 *   node src/scripts/seed-test-accounts.js                 # drivers based around Orlando, FL
 *   node src/scripts/seed-test-accounts.js 24.8607 67.0011 # around a given lat lng
 *
 * On UAT:  docker exec riderite-backend node src/scripts/seed-test-accounts.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { DriverSubscription, SUBSCRIPTION_PLANS } from "../models/DriverSubscription.js";
import { SEEDED_CONNECT_ACCOUNT_PREFIX } from "../utils/driverReadiness.js";

/** Shared password for every seeded test account. */
const TEST_PASSWORD = "RideRite@Test123";

const RIDER = { email: "rider1@riderite.test", fullName: "Test Rider", phone: "4075550100" };

/** Offsets (in miles, north/east of the base point) keep drivers apart on the map. */
const DRIVERS = [
  {
    email: "driver.sedan1@riderite.test",
    fullName: "Sam Sedan",
    phone: "4075550101",
    vehicle: { type: "sedan", make: "Toyota", model: "Camry", color: "White", year: 2022, plate: "RRT101" },
    offset: { north: 0.6, east: 0.4 },
  },
  {
    email: "driver.sedan2@riderite.test",
    fullName: "Sara Sedan",
    phone: "4075550102",
    vehicle: { type: "sedan", make: "Honda", model: "Accord", color: "Black", year: 2021, plate: "RRT102" },
    offset: { north: -0.8, east: 1.1 },
  },
  {
    email: "driver.suv1@riderite.test",
    fullName: "Steve SUV",
    phone: "4075550103",
    vehicle: { type: "suv", make: "Chevrolet", model: "Tahoe", color: "Silver", year: 2023, plate: "RRT201" },
    offset: { north: 1.2, east: -0.7 },
  },
  {
    email: "driver.truck1@riderite.test",
    fullName: "Tom Truck",
    phone: "4075550104",
    vehicle: { type: "truck", make: "Ford", model: "F-150", color: "Blue", year: 2020, plate: "RRT301" },
    offset: { north: -1.0, east: -1.3 },
  },
];

const ORLANDO = { lat: 28.5383, lng: -81.3792 };
const LICENSE_FRONT = "https://placehold.co/640x400/png?text=TEST+LICENSE+FRONT";
const LICENSE_BACK = "https://placehold.co/640x400/png?text=TEST+LICENSE+BACK";

function offsetPoint(base, { north, east }) {
  return {
    lat: base.lat + north / 69,
    lng: base.lng + east / (69 * Math.cos((base.lat * Math.PI) / 180)),
  };
}

async function upsertUser({ email, fullName, phone }, role, passwordHash) {
  return User.findOneAndUpdate(
    { email },
    {
      $set: {
        fullName,
        phone,
        role,
        passwordHash,
        isEmailVerified: true,
        isActive: true,
        profileCompleted: true,
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
        refreshTokens: [],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function main() {
  const [latArg, lngArg] = process.argv.slice(2).map(Number);
  const base =
    Number.isFinite(latArg) && Number.isFinite(lngArg) ? { lat: latArg, lng: lngArg } : ORLANDO;

  await mongoose.connect(env.mongodbUri);
  const passwordHash = await User.hashPassword(TEST_PASSWORD);
  const now = new Date();

  await upsertUser(RIDER, "rider", passwordHash);
  console.log(`rider   ${RIDER.email}`);

  for (const d of DRIVERS) {
    const user = await upsertUser(d, "driver", passwordHash);
    const home = offsetPoint(base, d.offset);

    await DriverProfile.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          isOnline: false,
          vehicleType: d.vehicle.type,
          vehicleMake: d.vehicle.make,
          vehicleModel: d.vehicle.model,
          vehicleColor: d.vehicle.color,
          vehicleYear: d.vehicle.year,
          vehiclePlate: d.vehicle.plate,
          dateOfBirth: "1990-01-15",
          addressLine1: "100 Test Street",
          city: "Orlando",
          state: "FL",
          zip: "32801",
          dlNumber: `T${d.vehicle.plate}000`,
          dlState: "FL",
          dlExpiresOn: "2030-12-31",
          licenseFrontUrl: LICENSE_FRONT,
          licenseBackUrl: LICENSE_BACK,
          insuranceCarrier: "Test Mutual",
          insurancePolicyNumber: `POL-${d.vehicle.plate}`,
          insuranceExpiresOn: "2030-12-31",
          verificationStatus: "approved",
          verificationSubmittedAt: now,
          isApproved: true,
          stripeConnectAccountId: `${SEEDED_CONNECT_ACCOUNT_PREFIX}${d.vehicle.plate.toLowerCase()}`,
          stripeConnectChargesEnabled: true,
          stripeConnectPayoutsEnabled: true,
          stripeConnectDetailsSubmitted: true,
          homeLocation: { ...home, updatedAt: now },
          lastLocation: { ...home, updatedAt: null },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const plan = SUBSCRIPTION_PLANS.monthly;
    await DriverSubscription.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          plan: plan.id,
          status: "active",
          amountCents: plan.amountCents,
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + plan.intervalDays * 86400000),
          cancelAtPeriodEnd: false,
          lastPaymentAt: now,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    console.log(
      `driver  ${d.email.padEnd(30)} ${d.vehicle.type.padEnd(6)} ${d.vehicle.color} ${d.vehicle.make} ${d.vehicle.model} (${d.vehicle.plate})`,
    );
  }

  console.log(`\nAll accounts use the password defined as TEST_PASSWORD in this script.`);
  console.log(`Driver home pins are around ${base.lat.toFixed(4)}, ${base.lng.toFixed(4)}.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
