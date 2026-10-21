/**
 * One-shot: clear legacy auto-approvals.
 * Sets isApproved=false + verificationStatus=pending unless already admin-approved
 * (verificationStatus === "approved" AND we keep those).
 *
 * Usage: node src/scripts/reset-unapproved-drivers.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { DriverProfile } from "../models/DriverProfile.js";

async function main() {
  await mongoose.connect(env.mongodbUri);
  const result = await DriverProfile.updateMany(
    {
      $or: [
        { verificationStatus: { $ne: "approved" } },
        { verificationStatus: { $exists: false } },
      ],
    },
    {
      $set: {
        isApproved: false,
        isOnline: false,
        verificationStatus: "pending",
      },
    },
  );
  console.log(`Reset ${result.modifiedCount} driver profile(s) to pending`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
