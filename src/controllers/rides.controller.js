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
} from "../validators/rides.schemas.js";
import {
  canDriverHandleRides,
  driverReadinessPayload,
} from "../utils/driverReadiness.js";

const OFFLINE_PAY = new Set(["cash", "venmo", "zelle"]);

export const estimate = asyncHandler(async (req, res) => {
  const data = estimateSchema.parse(req.body);
  const est = buildEstimate(data);
  res.json({ ok: true, estimate: est });
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
    status: { $in: ["requested", "accepted", "en_route", "arrived", "in_progress"] },
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
    radiusMiles: 10,
    vehicleType: data.vehicle,
    limit: 20,
  });
  if (nearby.length === 0) {
    throw httpError(
      409,
      `No online ${data.vehicle} drivers within 10 miles of your pickup. Try another vehicle or wait until a driver comes online.`,
      { code: "NO_NEARBY_DRIVERS" },
    );
  }

  const est = buildEstimate(data);
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
    fareCents: est.totalCents,
    paymentMethod: data.paymentMethod,
    paid: false,
    paymentStatus: isOffline ? "unpaid" : "pending",
    requestedAt: isOffline ? new Date() : null,
  });

  if (isOffline) {
    try {
      const { notifyEligibleDrivers } = await import("./notifications.controller.js");
      await notifyEligibleDrivers(trip);
    } catch {
      /* non-fatal */
    }
  }

  res.status(201).json({
    ok: true,
    message: isOffline
      ? "Ride requested. Waiting for a driver."
      : "Complete payment to dispatch your ride to nearby drivers.",
    trip: trip.toSafeJSON(),
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
    trips: trips.map((t) => t.toSafeJSON()),
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

  res.json({ ok: true, trip: trip.toSafeJSON() });
});

export const cancel = asyncHandler(async (req, res) => {
  const { reason } = cancelRideSchema.parse(req.body || {});
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  if (trip.riderId.toString() !== req.user._id.toString()) {
    throw httpError(403, "Only the rider can cancel this trip");
  }
  if (trip.status === "cancelled") throw httpError(400, "Trip already cancelled");
  if (["in_progress", "completed"].includes(trip.status)) {
    throw httpError(400, "Cannot cancel a ride that is already in progress or completed");
  }

  // TRD: cancellation fee only after driver is en route (not merely assigned)
  const driverEnRoute = ["en_route", "arrived"].includes(trip.status);

  let refundCents = 0;
  let feeCents = 0;
  let cancelStatus = "no_charge";
  let message = "";

  if (trip.status === "pending_payment" || !trip.paid) {
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

  trip.status = "cancelled";
  trip.cancelledAt = new Date();
  trip.cancelReason = reason || null;
  trip.cancelFeeCents = feeCents;
  trip.refundCents = refundCents;
  await trip.save();

  res.json({
    ok: true,
    cancelStatus,
    feeCents,
    refundCents,
    message,
    trip: trip.toSafeJSON(),
  });
});

/** Open requests for online drivers matching vehicle type */
export const listOpen = asyncHandler(async (req, res) => {
  const profile = await DriverProfile.findOne({ userId: req.user._id });
  if (!profile) throw httpError(400, "Complete driver profile first");
  if (!profile.isOnline) throw httpError(400, "Go online to see ride requests");
  if (!profile.isApproved) throw httpError(403, "Driver not approved yet");
  const { driverHasActiveSubscription } = await import("./subscriptions.controller.js");
  if (!(await driverHasActiveSubscription(req.user._id))) {
    throw httpError(403, "Active driver subscription required");
  }

  // Only show rides ready for drivers: offline (pay on pickup) or card already paid.
  const trips = await Trip.find({
    status: "requested",
    driverId: null,
    vehicleType: profile.vehicleType,
    $or: [
      { paid: true },
      { paymentMethod: { $in: ["cash", "venmo", "zelle"] } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(20);

  res.json({
    ok: true,
    trips: trips.map((t) => t.toSafeJSON()),
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

  const trip = await Trip.findOneAndUpdate(
    {
      _id: req.params.id,
      status: "requested",
      driverId: null,
      vehicleType: profile.vehicleType,
    },
    {
      $set: {
        driverId: req.user._id,
        status: "accepted",
        acceptedAt: new Date(),
      },
    },
    { new: true },
  );

  if (!trip) {
    throw httpError(409, "Trip not available (already taken or wrong vehicle type)");
  }

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
    trip: trip.toSafeJSON(),
  });
});

export const reject = asyncHandler(async (req, res) => {
  const profile = await DriverProfile.findOne({ userId: req.user._id });
  if (!profile?.isApproved) {
    throw httpError(403, "Driver not approved yet");
  }
  if (!canDriverHandleRides(profile)) {
    throw httpError(
      403,
      driverReadinessPayload(profile).blockReason ||
        "Complete Stripe Connect and driver verification before handling rides",
    );
  }
  // Soft reject for alpha: driver just ignores; we acknowledge so client can drop it
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  if (trip.status !== "requested") {
    throw httpError(400, "Trip is no longer open");
  }
  res.json({
    ok: true,
    message: "Request declined. It remains open for other drivers.",
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

  res.json({ ok: true, trip: trip.toSafeJSON() });
});
