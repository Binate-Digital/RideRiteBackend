// RideRite QA accounts — paste into MongoDB Compass (">_ MONGOSH" tab) or run:
//   mongosh "<UAT MONGODB_URI>" src/scripts/seed-test-accounts.mongosh.js
// In Compass: first `use <dbName>` (the database that has the users collection),
// then copy this whole file and paste it as one block. It is wrapped in a single
// function so pasting it again doesn't hit "already declared" errors.
//
// Same accounts as seed-test-accounts.js, for when you can't run Node on the server:
// 1 rider, 4 drivers and a super admin for the admin panel (admin@riderite.test).
// The drivers are ride-ready — email verified, KYC approved,
// vehicle + plate set, active monthly subscription and Stripe Connect marked
// ready (fake "acct_seedtest_*" ids the backend never sends to Stripe).
// License images are left empty; upload them from the driver's profile page.
//
// Safe to re-run: matched by email and reset (password included).
// Drivers start OFFLINE — log in as each driver and tap "Go online".
//
// Password for every account: the TEST_PASSWORD in seed-test-accounts.js.
// PASSWORD_HASH below is bcrypt (cost 12) of that password — regenerate it if you change it:
//   node -e "import('bcryptjs').then(async b=>console.log(await b.default.hash('<new password>',12)))"

(() => {
if (!db.getCollectionNames().includes("users")) {
  print(`Database "${db.getName()}" has no users collection - run: use <your RideRite db name>  then paste again.`);
  return;
}

const PASSWORD_HASH = "$2b$12$DM8YZZlohcpX8PDfFrw.t.NWwGMrFmMrwzDNZ12e9gvCF1.2yUUwi";

// Drivers' home pins (used only if their browser blocks GPS). Default: downtown Orlando, FL.
const BASE = { lat: 28.5383, lng: -81.3792 };

const RIDER = { email: "rider1@riderite.test", fullName: "Test Rider", phone: "4075550100" };
const ADMIN = { email: "admin@riderite.test", fullName: "Test Admin", phone: "4075550199" };

const DRIVERS = [
  { email: "driver.sedan1@riderite.test", fullName: "Sam Sedan", phone: "4075550101",
    vehicle: { type: "sedan", make: "Toyota", model: "Camry", color: "White", year: 2022, plate: "RRT101" },
    offset: { north: 0.6, east: 0.4 } },
  { email: "driver.sedan2@riderite.test", fullName: "Sara Sedan", phone: "4075550102",
    vehicle: { type: "sedan", make: "Honda", model: "Accord", color: "Black", year: 2021, plate: "RRT102" },
    offset: { north: -0.8, east: 1.1 } },
  { email: "driver.suv1@riderite.test", fullName: "Steve SUV", phone: "4075550103",
    vehicle: { type: "suv", make: "Chevrolet", model: "Tahoe", color: "Silver", year: 2023, plate: "RRT201" },
    offset: { north: 1.2, east: -0.7 } },
  { email: "driver.truck1@riderite.test", fullName: "Tom Truck", phone: "4075550104",
    vehicle: { type: "truck", make: "Ford", model: "F-150", color: "Blue", year: 2020, plate: "RRT301" },
    offset: { north: -1.0, east: -1.3 } },
];

const now = new Date();

function upsertUser(u, role) {
  db.users.updateOne(
    { email: u.email },
    {
      $set: {
        fullName: u.fullName,
        phone: u.phone,
        role,
        passwordHash: PASSWORD_HASH,
        isEmailVerified: true,
        isActive: true,
        profileCompleted: true,
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        refreshTokens: [],
        updatedAt: now,
      },
      $setOnInsert: {
        email: u.email,
        avatarUrl: null,
        lastLoginAt: null,
        stripeCustomerId: null,
        defaultPaymentMethodId: null,
        notificationPrefs: {
          ride: true, payment: true, rental: true, chauffeur: true, subscription: true,
          bonus: true, maintenance: true, payout: true, promo: false,
        },
        createdAt: now,
        __v: 0,
      },
    },
    { upsert: true },
  );
  return db.users.findOne({ email: u.email })._id;
}

upsertUser(RIDER, "rider");
print(`rider   ${RIDER.email}`);
const adminId = upsertUser(ADMIN, "admin");
db.users.updateOne({ _id: adminId }, { $set: { adminRole: "super_admin", suspension: null } });
print(`admin   ${ADMIN.email} (super_admin)`);

for (const d of DRIVERS) {
  const userId = upsertUser(d, "driver");
  const home = {
    lat: BASE.lat + d.offset.north / 69,
    lng: BASE.lng + d.offset.east / (69 * Math.cos((BASE.lat * Math.PI) / 180)),
  };

  db.driverprofiles.updateOne(
    { userId },
    {
      $set: {
        isOnline: false,
        vehicleType: d.vehicle.type,
        vehicleMake: d.vehicle.make,
        vehicleModel: d.vehicle.model,
        vehicleColor: d.vehicle.color,
        vehicleYear: d.vehicle.year,
        vehiclePlate: d.vehicle.plate,
        vehicleVin: "",
        dateOfBirth: "1990-01-15",
        addressLine1: "100 Test Street",
        city: "Orlando",
        state: "FL",
        zip: "32801",
        dlNumber: `T${d.vehicle.plate}000`,
        dlState: "FL",
        dlExpiresOn: "2030-12-31",
        insuranceCarrier: "Test Mutual",
        insurancePolicyNumber: `POL-${d.vehicle.plate}`,
        insuranceExpiresOn: "2030-12-31",
        verificationStatus: "approved",
        verificationSubmittedAt: now,
        verificationSkippedAt: null,
        isApproved: true,
        stripeConnectAccountId: `acct_seedtest_${d.vehicle.plate.toLowerCase()}`,
        stripeConnectChargesEnabled: true,
        stripeConnectPayoutsEnabled: true,
        stripeConnectDetailsSubmitted: true,
        homeLocation: { lat: home.lat, lng: home.lng, updatedAt: now },
        lastLocation: { lat: home.lat, lng: home.lng, updatedAt: null },
        updatedAt: now,
      },
      $setOnInsert: {
        userId,
        licenseFrontUrl: null,
        licenseBackUrl: null,
        createdAt: now,
        __v: 0,
      },
    },
    { upsert: true },
  );

  db.driversubscriptions.updateOne(
    { userId },
    {
      $set: {
        plan: "monthly",
        status: "active",
        amountCents: 10000,
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86400000),
        cancelAtPeriodEnd: false,
        lastPaymentAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        userId,
        stripeSubscriptionId: null,
        stripeCustomerId: null,
        createdAt: now,
        __v: 0,
      },
    },
    { upsert: true },
  );

  print(`driver  ${d.email}  ${d.vehicle.type}  ${d.vehicle.color} ${d.vehicle.make} ${d.vehicle.model} (${d.vehicle.plate})`);
}

print("Done. Subscriptions are active for 30 days - re-run this script to extend them.");
})();
