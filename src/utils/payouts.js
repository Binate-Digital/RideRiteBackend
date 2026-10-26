import mongoose from "mongoose";
import { DriverEarning } from "../models/DriverEarning.js";
import { DriverPayout } from "../models/DriverPayout.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { getStripe, isStripeMock } from "../lib/stripe.js";
import { SEEDED_CONNECT_ACCOUNT_PREFIX, isStripeConnectReady } from "./driverReadiness.js";

/**
 * Pay one driver everything pending in their ledger as a single Stripe Connect transfer.
 *
 * The entries are claimed first (pending → processing, stamped with the payout id) so two
 * overlapping runs can't pay the same entry twice. Mock mode and seeded QA accounts
 * (acct_seedtest_*) never call Stripe: the transfer is simulated and recorded as such.
 * A balance of zero or less (deductions exceed earnings) is carried over, not paid.
 */
export async function payoutDriver(driverId, { initiatedBy = null, minCents = 0 } = {}) {
  const driverObjectId = new mongoose.Types.ObjectId(String(driverId));
  const profile = await DriverProfile.findOne({ userId: driverObjectId });
  const accountId = profile?.stripeConnectAccountId || null;
  const simulated = isStripeMock() || Boolean(accountId?.startsWith(SEEDED_CONNECT_ACCOUNT_PREFIX));

  const pending = await DriverEarning.find({ driverId: driverObjectId, status: "pending" }).select("_id netCents");
  const amountCents = pending.reduce((a, e) => a + e.netCents, 0);
  if (!pending.length) return { driverId: String(driverId), skipped: "nothing pending" };
  if (amountCents <= 0) return { driverId: String(driverId), skipped: "balance not positive", amountCents };
  // Weekly run: small balances roll over (PAYOUT_MIN_CENTS)
  if (amountCents < minCents) return { driverId: String(driverId), skipped: "below minimum", amountCents };
  if (!accountId || (!simulated && !isStripeConnectReady(profile))) {
    return { driverId: String(driverId), skipped: "Stripe Connect not ready", amountCents };
  }

  const payout = await DriverPayout.create({
    driverId: driverObjectId,
    amountCents: 0,
    connectAccountId: accountId,
    simulated,
    initiatedBy,
  });
  // Claim exactly the entries we summed; anything claimed by a concurrent run is excluded
  await DriverEarning.updateMany(
    { _id: { $in: pending.map((e) => e._id) }, status: "pending" },
    { $set: { status: "processing", payoutId: payout._id } },
  );
  const claimed = await DriverEarning.find({ payoutId: payout._id, status: "processing" }).select("netCents");
  const claimedCents = claimed.reduce((a, e) => a + e.netCents, 0);
  if (!claimed.length || claimedCents <= 0) {
    await DriverEarning.updateMany({ payoutId: payout._id }, { $set: { status: "pending", payoutId: null } });
    await DriverPayout.deleteOne({ _id: payout._id });
    return { driverId: String(driverId), skipped: "claimed by another run" };
  }
  payout.amountCents = claimedCents;
  payout.entryCount = claimed.length;

  try {
    if (simulated) {
      payout.stripeTransferId = `tr_sim_${payout._id}`;
    } else {
      const transfer = await getStripe().transfers.create(
        {
          amount: claimedCents,
          currency: "usd",
          destination: accountId,
          transfer_group: `payout_${payout._id}`,
          description: `RideRite driver earnings · ${claimed.length} item(s)`,
          metadata: { app: "riderite", purpose: "driver_payout", payoutId: payout._id.toString(), driverId: String(driverId) },
        },
        { idempotencyKey: `payout_${payout._id}` },
      );
      payout.stripeTransferId = transfer.id;
    }
  } catch (err) {
    payout.status = "failed";
    payout.failureReason = err.message;
    await payout.save();
    // Back to the queue for the next run
    await DriverEarning.updateMany({ payoutId: payout._id }, { $set: { status: "pending", payoutId: null } });
    return { driverId: String(driverId), payout: payout.toSafeJSON(), error: err.message };
  }

  const now = new Date();
  payout.status = "paid";
  payout.paidAt = now;
  await payout.save();
  await DriverEarning.updateMany(
    { payoutId: payout._id, status: "processing" },
    { $set: { status: "paid", paidAt: now } },
  );
  try {
    const { notifyUser } = await import("../controllers/notifications.controller.js");
    await notifyUser(driverObjectId, {
      category: "payout",
      title: "Payout sent",
      body: `$${(claimedCents / 100).toFixed(2)} is on its way to your bank account.`,
      data: { payoutId: payout._id.toString(), href: "/driver" },
    });
  } catch {
    /* non-fatal */
  }
  return { driverId: String(driverId), payout: payout.toSafeJSON() };
}

/** Run payouts for one driver, or every driver with pending entries. */
export async function runPayouts({ driverId = null, initiatedBy = null, minCents = 0 } = {}) {
  const driverIds = driverId
    ? [driverId]
    : await DriverEarning.distinct("driverId", { status: "pending" });
  const results = [];
  for (const id of driverIds) results.push(await payoutDriver(id, { initiatedBy, minCents }));
  return results;
}
