import { Trip } from "../models/Trip.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import {
  buildEstimate,
  CANCEL_FEE_CENTS_AFTER_MATCH,
  CANCEL_GRACE_SECONDS,
} from "../utils/fares.js";
import {
  estimateSchema,
  bookRideSchema,
  cancelRideSchema,
  updateStatusSchema,
  rateRideSchema,
  promoValidateSchema,
} from "../validators/rides.schemas.js";
import { resolvePromo, redeemPromo, discountFor } from "../utils/promos.js";
import { broadcastTrip, broadcastRideClosed } from "../realtime/index.js";
import {
  canDriverHandleRides,
  driverReadinessPayload,
} from "../utils/driverReadiness.js";
import {
  DISPATCH_RADIUS_MILES,
  declineOffer,
  pickupMilesFrom,
  startDispatch,
  stopDispatch,
} from "../utils/dispatch.js";
import { tripWithDriver, tripsWithDrivers } from "../utils/tripDrivers.js";
import { settleTripRefund } from "../utils/refunds.js";
import { recordCancellationFeeEarning, recordTripEarning } from "../utils/earnings.js";
import { rideReceiptEmail } from "../utils/mailer.js";
import { User } from "../models/User.js";

const OFFLINE_PAY = new Set(["cash", "venmo", "zelle"]);
/** Rider has a ride in flight — can't book another until it ends. */
const ACTIVE_RIDER_STATUSES = ["requested", "accepted", "en_route", "arrived", "in_progress"];

/** Resolve an optional promo; a bad code is a 400 so the rider sees why. */
async function promoForRequest(promoCode) {
  if (!promoCode) return null;
  const result = await resolvePromo(promoCode);
  if (!result.ok) throw httpError(400, result.error, { code: "PROMO_INVALID" });
  return result;
}

export const estimate = asyncHandler(async (req, res) => {
  const data = estimateSchema.parse(req.body);
  const promo = await promoForRequest(data.promoCode);
  const est = buildEstimate({
    ...data,
    discountFor: promo ? (subtotal) => discountFor(promo.promo, subtotal) : undefined,
  });
  res.json({
    ok: true,
    estimate: est,
    promo: promo ? { code: promo.code, label: promo.label } : null,
  });
});

/** POST /api/rides/promo/validate — body: { code, subtotalCents? } */
export const validatePromo = asyncHandler(async (req, res) => {
  const { code, subtotalCents } = promoValidateSchema.parse(req.body);
  const result = await resolvePromo(code);
  if (!result.ok) {
    return res.json({ ok: false, code: result.code, label: "", discountCents: 0, error: result.error });
  }
  res.json({
    ok: true,
    code: result.code,
    label: result.label,
    discountCents: subtotalCents ? discountFor(result.promo, subtotalCents) : 0,
  });
});

export const book = asyncHandler(async (req, res) => {
  const data = bookRideSchema.parse(req.body);
  const isOffline = OFFLINE_PAY.has(data.paymentMethod);

  // Resume unpaid card checkout instead of blocking the rider
  const pendingPay = await Trip.findOne({
    riderId: req.user._id,
    status: "pending_payment",
    paid: false,
  }).sort({ createdAt: -1 });
  if (pendingPay && !isOffline) {
    return res.json({
      ok: true,
      message: "Resume payment for your ride.",
      trip: pendingPay.toSafeJSON(),
      resumed: true,
    });
  }

  // Block only real in-flight trips (already dispatched / matched)
  const active = await Trip.findOne({
    riderId: req.user._id,
    status: { $in: ACTIVE_RIDER_STATUSES },
  });
  if (active) {
    throw httpError(409, "You already have an active ride", {
      tripId: active._id.toString(),
    });
  }

  const pickupLat = data.pickupCoords?.lat;
  const pickupLng = data.pickupCoords?.lng;
  if (pickupLat == null || pickupLng == null) {
    throw httpError(
      400,
      "Set a map pickup pin (or choose an address with coordinates) so we can find nearby drivers.",
    );
  }

  const { findNearbyOnlineDrivers } = await import("../utils/nearbyDrivers.js");
  const nearby = await findNearbyOnlineDrivers({
    lat: pickupLat,
    lng: pickupLng,
    radiusMiles: DISPATCH_RADIUS_MILES,
    vehicleType: data.vehicle,
    limit: 20,
  });
  if (nearby.length === 0) {
    throw httpError(
      409,
      `No online ${data.vehicle} drivers within ${DISPATCH_RADIUS_MILES} miles of your pickup. Try another vehicle or wait until a driver comes online.`,
      { code: "NO_NEARBY_DRIVERS" },
    );
  }

  const promo = await promoForRequest(data.promoCode);
  const est = buildEstimate({
    ...data,
    discountFor: promo ? (subtotal) => discountFor(promo.promo, subtotal) : undefined,
  });
  if (promo && !(await redeemPromo(promo.promo))) {
    throw httpError(400, "Promo limit reached", { code: "PROMO_INVALID" });
  }
  // Card-like: hold as pending_payment until Stripe succeeds, then flip to requested for drivers.
  // Offline: go straight to requested (pay on pickup).
  const trip = await Trip.create({
    riderId: req.user._id,
    status: isOffline ? "requested" : "pending_payment",
    vehicleType: data.vehicle,
    pickupAddress: data.pickup,
    destinationAddress: data.destination,
    pickupCoords: data.pickupCoords || null,
    destinationCoords: data.destinationCoords || null,
    distanceMiles: est.distanceMiles,
    durationMinutes: est.durationMinutes,
    baseRateCents: est.baseRateCents,
    distanceCents: est.distanceCents,
    timeCents: est.timeCents,
    bookingFeeCents: est.bookingFeeCents,
    baseFareCents: est.baseFareCents,
    serviceFeeCents: est.serviceFeeCents,
    taxCents: est.taxCents,
    discountCents: est.discountCents,
    promoCode: promo ? promo.code : null,
    fareCents: est.totalCents,
    paymentMethod: data.paymentMethod,
    paid: false,
    paymentStatus: isOffline ? "unpaid" : "pending",
    requestedAt: isOffline ? new Date() : null,
  });

  // Pay on pickup: offer to the nearest driver now. Card rides start after payment succeeds.
  const dispatched = isOffline ? await startDispatch(trip) : null;

  res.status(201).json({
    ok: true,
    message: isOffline
      ? "Ride requested. Waiting for a driver."
      : "Complete payment to dispatch your ride to nearby drivers.",
    trip: (dispatched || trip).toSafeJSON(),
    note: isOffline
      ? "Pay on pickup selected — no upfront charge."
      : "Drivers are notified only after payment succeeds.",
  });
});

export const listMine = asyncHandler(async (req, res) => {
  const asDriver = req.query.as === "driver";
  const filter = asDriver
    ? { driverId: req.user._id }
    : { riderId: req.user._id };

  const trips = await Trip.find(filter).sort({ createdAt: -1 }).limit(50);
  res.json({
    ok: true,
    trips: await tripsWithDrivers(trips),
  });
});

export const getOne = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");

  const uid = req.user._id.toString();
  const isParty =
    trip.riderId.toString() === uid ||
    (trip.driverId && trip.driverId.toString() === uid) ||
    req.user.role === "admin";
  if (!isParty) throw httpError(403, "Not authorized to view this trip");

  res.json({ ok: true, trip: await tripWithDriver(trip) });
});

export const cancel = asyncHandler(async (req, res) => {
  const { reason } = cancelRideSchema.parse(req.body || {});
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  if (trip.riderId.toString() !== req.user._id.toString()) {
    throw httpError(403, "Only the rider can cancel this trip");
  }
  if (trip.status === "cancelled") throw httpError(400, "Trip already cancelled");
  if (trip.status === "no_drivers" && trip.paymentStatus === "refunded") {
    throw httpError(400, "Trip already ended and was refunded");
  }
  if (["in_progress", "completed"].includes(trip.status)) {
    throw httpError(400, "Cannot cancel a ride that is already in progress or completed");
  }

  // TRD: cancellation fee only after driver is en route (not merely assigned)
  const driverEnRoute = ["en_route", "arrived"].includes(trip.status);

  let refundCents = 0;
  let feeCents = 0;
  let cancelStatus = "no_charge";
  let message = "";

  // Pay-on-pickup trips are never charged up front, so there is nothing to refund or keep
  const chargedOnline = trip.paid && !OFFLINE_PAY.has(trip.paymentMethod);

  if (trip.status === "pending_payment" || !chargedOnline) {
    cancelStatus = "no_charge";
    message = "Ride canceled. No payment was taken.";
  } else if (!driverEnRoute) {
    refundCents = trip.fareCents;
    cancelStatus = "refunded_full";
    message = "Canceled before driver was en route. Full refund issued.";
  } else {
    feeCents = Math.min(CANCEL_FEE_CENTS_AFTER_MATCH, trip.fareCents);
    refundCents = Math.max(0, trip.fareCents - feeCents);
    cancelStatus = refundCents > 0 ? "refunded_partial" : "no_refund";
    message = `Driver was already en route. $${(feeCents / 100).toFixed(2)} cancellation fee applied.`;
  }

  // Conditional on the state we priced the cancel for: an accept or a dispatch
  // move landing in between makes this a 409 instead of silently overwriting it.
  const cancelled = await Trip.findOneAndUpdate(
    { _id: trip._id, status: trip.status, driverId: trip.driverId ?? null },
    {
      $set: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: reason || null,
        cancelFeeCents: feeCents,
        refundCents,
        offeredDriverId: null,
        offerExpiresAt: null,
        // The Stripe refund below settles this; the payments sweeper retries a failure
        ...(refundCents > 0 ? { paymentStatus: "refund_pending" } : {}),
      },
    },
    { new: true },
  );
  if (!cancelled) throw httpError(409, "The ride just changed — refresh and try again");
  let finalTrip = cancelled;
  if (refundCents > 0) {
    const settled = await settleTripRefund(cancelled, { reason: "rider cancelled" });
    if (settled?.trip) finalTrip = settled.trip;
  }
  // TRD 4.7: the late-cancel fee compensates the driver for time and travel
  if (feeCents > 0) await recordCancellationFeeEarning(cancelled, feeCents);
  stopDispatch(trip._id);
  broadcastTrip(finalTrip);
  // Also closes the radar of a driver holding the offer right now
  broadcastRideClosed(trip._id);

  if (trip.driverId) {
    try {
      const { notifyUser } = await import("./notifications.controller.js");
      await notifyUser(trip.driverId, {
        category: "ride",
        title: "Rider cancelled the trip",
        body: trip.cancelReason
          ? `Reason: ${trip.cancelReason}`
          : `${trip.pickupAddress} → ${trip.destinationAddress}`,
        data: { tripId: trip._id.toString(), status: "cancelled", href: "/driver" },
      });
    } catch {
      /* non-fatal */
    }
  }

  res.json({
    ok: true,
    cancelStatus,
    feeCents,
    refundCents,
    message,
    trip: finalTrip.toSafeJSON(),
  });
});

/**
 * POST /api/rides/:id/retry — the rider searches again after "no drivers".
 * A card payment that hasn't been refunded yet is reused.
 */
export const retry = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  if (trip.riderId.toString() !== req.user._id.toString()) {
    throw httpError(403, "Only the rider can re-request this trip");
  }
  if (trip.status !== "no_drivers") {
    throw httpError(400, "Only a ride that found no driver can be re-requested");
  }
  const isOffline = OFFLINE_PAY.has(trip.paymentMethod);
  if (!isOffline && trip.paymentStatus !== "refund_pending") {
    throw httpError(409, "This payment was already refunded — book a new ride", {
      code: "REBOOK_REQUIRED",
    });
  }
  const active = await Trip.findOne({
    riderId: req.user._id,
    status: { $in: ACTIVE_RIDER_STATUSES },
  });
  if (active) {
    throw httpError(409, "You already have an active ride", { tripId: active._id.toString() });
  }

  const reset = await Trip.findOneAndUpdate(
    { _id: trip._id, status: "no_drivers", paymentStatus: trip.paymentStatus },
    {
      $set: {
        status: "requested",
        requestedAt: new Date(),
        paymentStatus: isOffline ? trip.paymentStatus : "paid",
        refundCents: 0,
        offeredDriverId: null,
        offeredAt: null,
        offerExpiresAt: null,
        dispatchDeclinedDriverIds: [],
        dispatchAttempts: 0,
        dispatchStartedAt: null,
        noDriversAt: null,
      },
    },
    { new: true },
  );
  if (!reset) throw httpError(409, "The ride just changed — refresh and try again");
  broadcastTrip(reset);
  const dispatched = await startDispatch(reset);
  const latest = dispatched || (await Trip.findById(trip._id));

  res.json({
    ok: true,
    message:
      latest.status === "no_drivers"
        ? "Still no drivers available nearby."
        : "Searching for a driver again.",
    trip: latest.toSafeJSON(),
  });
});

/** The request currently offered to this driver (dispatch offers one driver at a time). */
export const listOpen = asyncHandler(async (req, res) => {
  const profile = await DriverProfile.findOne({ userId: req.user._id });
  if (!profile) throw httpError(400, "Complete driver profile first");
  if (!profile.isOnline) throw httpError(400, "Go online to see ride requests");
  if (!profile.isApproved) throw httpError(403, "Driver not approved yet");
  const { driverHasActiveSubscription } = await import("./subscriptions.controller.js");
  if (!(await driverHasActiveSubscription(req.user._id))) {
    throw httpError(403, "Active driver subscription required");
  }

  // Requests are offered exclusively, nearest driver first — a driver only sees
  // the trip currently offered to them, until its offer window ends.
  const offered = await Trip.find({
    status: "requested",
    driverId: null,
    offeredDriverId: req.user._id,
    offerExpiresAt: { $gt: new Date() },
  }).limit(5);

  res.json({
    ok: true,
    // Lets the client count down from the server's clock
    serverNow: new Date(),
    trips: offered.map((t) => ({
      ...t.toSafeJSON(),
      pickupDistanceMiles: pickupMilesFrom(profile.lastLocation, t),
    })),
  });
});

export const accept = asyncHandler(async (req, res) => {
  const profile = await DriverProfile.findOne({ userId: req.user._id });
  const { driverHasActiveSubscription } = await import("./subscriptions.controller.js");
  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  if (!profile?.isOnline || !profile.isApproved) {
    throw httpError(403, "Driver must be online and approved");
  }
  if (!canDriverHandleRides(profile, { subscriptionActive })) {
    throw httpError(
      403,
      driverReadinessPayload(profile, { subscriptionActive }).blockReason ||
        "Complete Stripe Connect, subscription, and verification to accept rides",
    );
  }

  // One active trip at a time for driver
  const busy = await Trip.findOne({
    driverId: req.user._id,
    status: { $in: ["accepted", "en_route", "arrived", "in_progress"] },
  });
  if (busy) throw httpError(409, "You already have an active trip");

  // Only the driver holding the offer, and only inside the offer window
  const trip = await Trip.findOneAndUpdate(
    {
      _id: req.params.id,
      status: "requested",
      driverId: null,
      vehicleType: profile.vehicleType,
      offeredDriverId: req.user._id,
      offerExpiresAt: { $gt: new Date() },
    },
    {
      $set: {
        driverId: req.user._id,
        status: "accepted",
        acceptedAt: new Date(),
        offeredDriverId: null,
        offerExpiresAt: null,
      },
    },
    { new: true },
  );

  if (!trip) {
    throw httpError(409, "This ride is no longer offered to you (expired, taken or cancelled)", {
      code: "OFFER_UNAVAILABLE",
    });
  }
  stopDispatch(trip._id);
  broadcastTrip(trip);
  broadcastRideClosed(trip._id);

  try {
    const { notifyUser } = await import("./notifications.controller.js");
    await notifyUser(trip.riderId, {
      category: "ride",
      title: "Driver assigned",
      body: "Your driver accepted the ride and is heading your way.",
      data: { tripId: trip._id.toString(), status: "accepted", href: `/book?trip_id=${trip._id}` },
    });
  } catch {
    /* non-fatal */
  }

  res.json({
    ok: true,
    message: "Ride accepted",
    trip: await tripWithDriver(trip),
  });
});

export const reject = asyncHandler(async (req, res) => {
  const profile = await DriverProfile.findOne({ userId: req.user._id });
  if (!profile?.isApproved) {
    throw httpError(403, "Driver not approved yet");
  }
  const { driverHasActiveSubscription } = await import("./subscriptions.controller.js");
  const subscriptionActive = await driverHasActiveSubscription(req.user._id);
  if (!canDriverHandleRides(profile, { subscriptionActive })) {
    throw httpError(
      403,
      driverReadinessPayload(profile, { subscriptionActive }).blockReason ||
        "Complete Stripe Connect and driver verification before handling rides",
    );
  }
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  if (trip.status !== "requested") {
    throw httpError(400, "Trip is no longer open");
  }
  // Declining moves the offer to the next nearest driver right away. If the
  // offer already timed out, the decline is simply acknowledged.
  await declineOffer(trip, req.user._id, "rejected");
  res.json({
    ok: true,
    message: "Request declined. It will be offered to another driver.",
    tripId: trip._id.toString(),
  });
});

const STATUS_TRANSITIONS = {
  accepted: ["en_route"],
  en_route: ["arrived"],
  arrived: ["in_progress"],
  in_progress: ["completed"],
};

const STATUS_TIME_FIELD = {
  en_route: "enRouteAt",
  arrived: "arrivedAt",
  in_progress: "startedAt",
  completed: "completedAt",
};

export const updateStatus = asyncHandler(async (req, res) => {
  const { status } = updateStatusSchema.parse(req.body);
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  if (!trip.driverId || trip.driverId.toString() !== req.user._id.toString()) {
    throw httpError(403, "Only the assigned driver can update status");
  }

  const allowed = STATUS_TRANSITIONS[trip.status] || [];
  if (!allowed.includes(status)) {
    throw httpError(
      400,
      `Cannot move from "${trip.status}" to "${status}". Allowed: ${allowed.join(", ") || "none"}`,
    );
  }

  trip.status = status;
  const field = STATUS_TIME_FIELD[status];
  if (field) trip[field] = new Date();

  // Alpha: mark offline methods as "collected" on complete
  if (status === "completed" && OFFLINE_PAY.has(trip.paymentMethod)) {
    trip.paid = true;
  }

  await trip.save();
  broadcastTrip(trip);

  if (status === "completed") {
    try {
      await recordTripEarning(trip);
    } catch (err) {
      console.error(`[earnings] trip ${trip._id} not recorded:`, err.message);
    }
    void sendRideReceipt(trip);
  }

  try {
    const { notifyUser } = await import("./notifications.controller.js");
    const STATUS_COPY = {
      en_route: {
        title: "Driver en route",
        body: "Your driver is on the way to the pickup location.",
      },
      arrived: {
        title: "Driver arrived",
        body: "Your driver has arrived at the pickup location.",
      },
      in_progress: {
        title: "Trip started",
        body: "Your ride is in progress. Enjoy the trip!",
      },
      completed: {
        title: "Trip completed",
        body: "You've arrived. Thanks for riding with RideRite!",
      },
    };
    const copy = STATUS_COPY[status];
    if (copy) {
      await notifyUser(trip.riderId, {
        category: "ride",
        title: copy.title,
        body: copy.body,
        data: { tripId: trip._id.toString(), status, href: `/book?trip_id=${trip._id}` },
      });
    }
  } catch {
    /* non-fatal */
  }

  res.json({
    ok: true,
    message: `Status updated to ${status}`,
    trip: trip.toSafeJSON(),
  });
});

/** Emailed digital receipt (TRD 4.7); the on-screen receipt is unchanged. Never throws. */
async function sendRideReceipt(trip) {
  try {
    const rider = await User.findById(trip.riderId).select("fullName email");
    if (!rider?.email) return;
    // "Payments & receipts" category + email channel decide whether it goes out
    const { emailUser } = await import("./notifications.controller.js");
    await emailUser(trip.riderId, "payment", rideReceiptEmail({ fullName: rider.fullName, trip }));
  } catch (err) {
    console.error(`[receipt] trip ${trip._id}:`, err.message);
  }
}

export const rate = asyncHandler(async (req, res) => {
  const data = rateRideSchema.parse(req.body);
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  if (trip.riderId.toString() !== req.user._id.toString()) {
    throw httpError(403, "Only the rider can rate this trip");
  }
  if (trip.status !== "completed") {
    throw httpError(400, "Can only rate completed trips");
  }
  if (trip.riderRating) throw httpError(400, "Trip already rated");

  trip.riderRating = data.rating;
  trip.riderReview = data.review || null;
  await trip.save();
  broadcastTrip(trip);

  res.json({ ok: true, trip: trip.toSafeJSON() });
});
