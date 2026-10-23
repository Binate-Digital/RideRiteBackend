import { Trip } from "../models/Trip.js";
import { env } from "../config/env.js";
import { findNearbyOnlineDrivers, haversineMiles } from "./nearbyDrivers.js";
import { broadcastTrip, emitToUser } from "../realtime/index.js";
import { notifyUser } from "../controllers/notifications.controller.js";
import { settleTripRefund } from "./refunds.js";

/**
 * Ride dispatch (TRD 4.3 / 5.3): a requested trip is offered to ONE driver at a
 * time — the nearest available one — for DISPATCH_OFFER_SECONDS. Decline or
 * timeout moves it to the next nearest driver not yet tried. When nobody is
 * left, or DISPATCH_MAX_MINUTES pass, the trip ends as `no_drivers`.
 *
 * Every move is one conditional update on the expected (offeree, expiry), so
 * the in-process timer, the sweeper, a reject and an accept can race safely:
 * exactly one of them wins and the others become no-ops.
 */

/** How far from the pickup a driver may be to be offered a request. */
export const DISPATCH_RADIUS_MILES = 100;

const OFFLINE_PAY = ["cash", "venmo", "zelle"];
/** In-process timers that fire the moment an offer expires (the sweeper is the safety net). */
const offerTimers = new Map();
let sweeper = null;

function clearOfferTimer(tripId) {
  const key = String(tripId);
  const t = offerTimers.get(key);
  if (t) clearTimeout(t);
  offerTimers.delete(key);
}

function scheduleOfferTimeout(trip) {
  clearOfferTimer(trip._id);
  const expectedOfferee = trip.offeredDriverId;
  const expectedExpiry = trip.offerExpiresAt;
  const ms = Math.max(0, expectedExpiry.getTime() - Date.now()) + 50;
  const timer = setTimeout(() => {
    offerTimers.delete(String(trip._id));
    void advanceDispatch(trip._id, { expectedOfferee, expectedExpiry, reason: "timeout" }).catch(
      (err) => console.error("[dispatch] timeout advance failed", err),
    );
  }, ms);
  timer.unref?.();
  offerTimers.set(String(trip._id), timer);
}

/** The trip is visible to drivers: pay-on-pickup, or card already captured. */
function readyForDrivers(trip) {
  return trip.paid || OFFLINE_PAY.includes(trip.paymentMethod);
}

/** Nearest eligible driver who hasn't been tried and isn't holding another live offer. */
async function nextCandidate(trip, declined) {
  const pickup = trip.pickupCoords;
  if (pickup?.lat == null || pickup?.lng == null) return null;
  const now = new Date();
  const [nearby, holdingOffers] = await Promise.all([
    findNearbyOnlineDrivers({
      lat: pickup.lat,
      lng: pickup.lng,
      radiusMiles: DISPATCH_RADIUS_MILES,
      vehicleType: trip.vehicleType,
      limit: 50,
    }),
    Trip.distinct("offeredDriverId", {
      _id: { $ne: trip._id },
      status: "requested",
      offerExpiresAt: { $gt: now },
    }),
  ]);
  const skip = new Set([...declined, ...holdingOffers.map(String)]);
  // A rider who is also a driver never gets their own request
  skip.add(String(trip.riderId));
  return nearby.find((d) => !skip.has(String(d.userId))) || null;
}

/**
 * Move the trip off its current offer (none, for a fresh request) to the next
 * driver, or to `no_drivers` when nobody is left. No-op unless the trip is
 * still `requested` and still offered to `expectedOfferee` with `expectedExpiry`.
 */
export async function advanceDispatch(
  tripId,
  { expectedOfferee = null, expectedExpiry = null, reason = "start" } = {},
) {
  const trip = await Trip.findById(tripId);
  if (!trip || trip.status !== "requested" || !readyForDrivers(trip)) return null;
  const current = trip.offeredDriverId ? String(trip.offeredDriverId) : null;
  if (current !== (expectedOfferee ? String(expectedOfferee) : null)) return null;
  const currentExpiry = trip.offerExpiresAt ? trip.offerExpiresAt.getTime() : null;
  if (currentExpiry !== (expectedExpiry ? new Date(expectedExpiry).getTime() : null)) return null;
  if (reason === "timeout" && currentExpiry && currentExpiry > Date.now()) return null;

  const now = new Date();
  const startedAt = trip.dispatchStartedAt || now;
  const declined = new Set((trip.dispatchDeclinedDriverIds || []).map(String));
  if (current) declined.add(current);
  const outOfTime = now - startedAt >= env.dispatchMaxMinutes * 60 * 1000;
  const next = outOfTime ? null : await nextCandidate(trip, declined);

  const guard = {
    _id: trip._id,
    status: "requested",
    offeredDriverId: trip.offeredDriverId || null,
    offerExpiresAt: trip.offerExpiresAt || null,
  };
  const update = next
    ? {
        $set: {
          offeredDriverId: next.userId,
          offeredAt: now,
          offerExpiresAt: new Date(now.getTime() + env.dispatchOfferSeconds * 1000),
          dispatchStartedAt: startedAt,
        },
        $inc: { dispatchAttempts: 1 },
      }
    : {
        $set: {
          status: "no_drivers",
          noDriversAt: now,
          offeredDriverId: null,
          offeredAt: null,
          offerExpiresAt: null,
          dispatchStartedAt: startedAt,
          // A card ride that never got a driver is owed its money back. It is
          // refunded right below (or by the payments sweeper after
          // NO_DRIVERS_REFUND_DELAY_SECONDS, during which the rider may re-request
          // and reuse the payment — see rides.controller `retry`).
          ...(trip.paid && !OFFLINE_PAY.includes(trip.paymentMethod)
            ? { paymentStatus: "refund_pending", refundCents: trip.fareCents }
            : {}),
        },
      };
  if (current) update.$addToSet = { dispatchDeclinedDriverIds: trip.offeredDriverId };

  let updated = await Trip.findOneAndUpdate(guard, update, { new: true });
  if (!updated) return null; // someone else (accept / cancel / other path) moved it first
  if (!next && updated.paymentStatus === "refund_pending" && env.noDriversRefundDelaySeconds === 0) {
    const settled = await settleTripRefund(updated, { reason: "no drivers available" });
    if (settled?.trip) updated = settled.trip;
  }

  clearOfferTimer(trip._id);
  // The previous driver's offer is gone — their radar closes now
  if (current) emitToUser(current, "ride:closed", { tripId: String(trip._id), reason });

  if (next) {
    scheduleOfferTimeout(updated);
    await sendOffer(updated, next);
  } else {
    await notifyUser(updated.riderId, {
      category: "ride",
      title: "No drivers available",
      body:
        updated.paymentStatus === "refunded"
          ? "No driver accepted your ride, so your card payment has been refunded in full. Please book again."
          : updated.paymentStatus === "refund_pending"
            ? "No driver accepted your ride. Try again, or cancel — your card payment will be refunded."
            : "No driver accepted your ride right now. Try again in a few minutes.",
      data: { tripId: String(updated._id), status: "no_drivers", href: `/book?trip_id=${updated._id}` },
    });
  }
  // Rider sees "finding your driver (attempt N)" or "no drivers available"
  broadcastTrip(updated);
  return updated;
}

async function sendOffer(trip, driver) {
  const payload = {
    trip: {
      ...trip.toSafeJSON(),
      pickupDistanceMiles: Math.round(driver.distanceMiles * 10) / 10,
    },
    offerExpiresAt: trip.offerExpiresAt,
    offerSeconds: env.dispatchOfferSeconds,
    // Lets the client correct for clock skew when counting down
    serverNow: new Date(),
  };
  emitToUser(String(driver.userId), "ride:offer", payload);
  const fare = `$${((trip.fareCents || 0) / 100).toFixed(2)}`;
  await notifyUser(driver.userId, {
    category: "ride",
    title: "New ride request",
    body: `${trip.vehicleType.toUpperCase()} · ${fare} · ${trip.pickupAddress}`,
    data: {
      tripId: String(trip._id),
      href: "/driver",
      dispatch: true,
      offerExpiresAt: trip.offerExpiresAt,
    },
  });
}

/** Begin dispatch for a trip that just became `requested`. Never throws. */
export async function startDispatch(tripOrId) {
  try {
    return await advanceDispatch(tripOrId._id ?? tripOrId, { reason: "start" });
  } catch (err) {
    console.error("[dispatch] start failed", err);
    return null;
  }
}

/** The current offeree declined (or went offline) — offer the next driver right away. */
export async function declineOffer(trip, driverUserId, reason = "rejected") {
  if (!trip.offeredDriverId || String(trip.offeredDriverId) !== String(driverUserId)) return null;
  return advanceDispatch(trip._id, {
    expectedOfferee: trip.offeredDriverId,
    expectedExpiry: trip.offerExpiresAt,
    reason,
  });
}

/** Dispatch is over for this trip (accepted / cancelled) — drop its timer. */
export function stopDispatch(tripId) {
  clearOfferTimer(tripId);
}

/** Offer distance shown to the driver on `GET /api/rides/open`. */
export function pickupMilesFrom(location, trip) {
  if (location?.lat == null || location?.lng == null || trip.pickupCoords?.lat == null) return null;
  return Math.round(haversineMiles(location, trip.pickupCoords) * 10) / 10;
}

/**
 * Safety net for timers lost to a restart or a crash: advance every offer whose
 * window has passed, and start dispatch for requested trips that never got one.
 */
export async function sweepDispatch() {
  const now = new Date();
  const expired = await Trip.find({ status: "requested", offerExpiresAt: { $lte: now } })
    .select("_id offeredDriverId offerExpiresAt")
    .limit(200)
    .lean();
  for (const t of expired) {
    await advanceDispatch(t._id, {
      expectedOfferee: t.offeredDriverId,
      expectedExpiry: t.offerExpiresAt,
      reason: "timeout",
    }).catch((err) => console.error("[dispatch] sweep advance failed", err));
  }

  // Requested but never offered (crashed between payment and first offer, or older trips).
  // The grace period keeps the sweeper from racing a request that is starting right now.
  const unstarted = await Trip.find({
    status: "requested",
    offeredDriverId: null,
    offerExpiresAt: null,
    updatedAt: { $lte: new Date(now.getTime() - 5000) },
    $or: [{ paid: true }, { paymentMethod: { $in: OFFLINE_PAY } }],
  })
    .select("_id")
    .limit(200)
    .lean();
  for (const t of unstarted) await startDispatch(t._id);
}

export function startDispatchSweeper() {
  if (sweeper) return;
  let running = false;
  sweeper = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepDispatch();
    } catch (err) {
      console.error("[dispatch] sweep failed", err);
    } finally {
      running = false;
    }
  }, env.dispatchSweepSeconds * 1000);
  sweeper.unref?.();
  console.log(
    `[dispatch] offers ${env.dispatchOfferSeconds}s each, give up after ${env.dispatchMaxMinutes} min, sweep every ${env.dispatchSweepSeconds}s`,
  );
}
