import mongoose from "mongoose";
import { tripEarningBreakdown } from "../utils/earnings.js";

export const TRIP_STATUSES = [
  "pending_payment",
  "requested",
  "accepted",
  "en_route",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
  // Dispatch ran out of drivers (everyone declined / timed out, or DISPATCH_MAX_MINUTES passed)
  "no_drivers",
];

const coordsSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { _id: false },
);

const tripSchema = new mongoose.Schema(
  {
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: TRIP_STATUSES,
      default: "requested",
      index: true,
    },
    vehicleType: {
      type: String,
      enum: ["sedan", "suv", "truck"],
      required: true,
    },
    pickupAddress: { type: String, required: true, maxlength: 300 },
    destinationAddress: { type: String, required: true, maxlength: 300 },
    pickupCoords: { type: coordsSchema, default: null },
    destinationCoords: { type: coordsSchema, default: null },
    distanceMiles: { type: Number, required: true },
    durationMinutes: { type: Number, required: true },
    // Fare breakdown (cents)
    baseRateCents: { type: Number, required: true },
    distanceCents: { type: Number, required: true },
    timeCents: { type: Number, required: true },
    bookingFeeCents: { type: Number, required: true },
    baseFareCents: { type: Number, required: true },
    serviceFeeCents: { type: Number, required: true },
    taxCents: { type: Number, required: true },
    discountCents: { type: Number, default: 0 },
    promoCode: { type: String, default: null },
    fareCents: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ["card", "cashapp", "paypal", "cash", "venmo", "zelle"],
      default: "card",
    },
    paid: { type: Boolean, default: false },
    paidAt: { type: Date, default: null },
    stripePaymentIntentId: { type: String, default: null, index: true },
    stripeClientSecret: { type: String, default: null, select: false },
    paymentStatus: {
      type: String,
      enum: [
        "unpaid",
        "pending",
        "paid",
        // Card was charged but no driver took the ride; the refund job issues the Stripe refund
        "refund_pending",
        // A refund is being sent to Stripe right now (see utils/refunds settleTripRefund)
        "refunding",
        "refunded",
        "partial_refund",
        "failed",
      ],
      default: "unpaid",
      index: true,
    },
    // Cancel metadata
    cancelFeeCents: { type: Number, default: 0 },
    refundCents: { type: Number, default: 0 },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
    // Dispatch: the trip is offered to one driver at a time, nearest first
    offeredDriverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    offeredAt: { type: Date, default: null },
    offerExpiresAt: { type: Date, default: null },
    /** Drivers who declined or let the offer time out — never offered this trip again */
    dispatchDeclinedDriverIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    dispatchAttempts: { type: Number, default: 0 },
    dispatchStartedAt: { type: Date, default: null },
    noDriversAt: { type: Date, default: null },
    // Lifecycle timestamps
    requestedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date, default: null },
    enRouteAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Simple rating placeholder for later
    riderRating: { type: Number, min: 1, max: 5, default: null },
    riderReview: { type: String, maxlength: 500, default: null },
  },
  { timestamps: true },
);

tripSchema.index({ status: 1, vehicleType: 1, createdAt: -1 });
// Sweeper: find offers whose window has passed
tripSchema.index({ status: 1, offerExpiresAt: 1 });
// Driver cards: rating average over completed trips
tripSchema.index({ driverId: 1, status: 1, riderRating: 1 });

tripSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    riderId: this.riderId?.toString?.() || this.riderId,
    driverId: this.driverId ? this.driverId.toString() : null,
    status: this.status,
    vehicleType: this.vehicleType,
    pickupAddress: this.pickupAddress,
    destinationAddress: this.destinationAddress,
    pickupCoords: this.pickupCoords,
    destinationCoords: this.destinationCoords,
    distanceMiles: this.distanceMiles,
    durationMinutes: this.durationMinutes,
    fare: {
      baseRateCents: this.baseRateCents,
      distanceCents: this.distanceCents,
      timeCents: this.timeCents,
      bookingFeeCents: this.bookingFeeCents,
      baseFareCents: this.baseFareCents,
      serviceFeeCents: this.serviceFeeCents,
      taxCents: this.taxCents,
      discountCents: this.discountCents,
      totalCents: this.fareCents,
    },
    /** What the driver earns for this trip (base fare − platform commission) */
    driverEarningsCents: tripEarningBreakdown(this).netCents,
    promoCode: this.promoCode,
    paymentMethod: this.paymentMethod,
    paid: this.paid,
    paidAt: this.paidAt,
    paymentStatus: this.paymentStatus,
    stripePaymentIntentId: this.stripePaymentIntentId,
    cancelFeeCents: this.cancelFeeCents,
    refundCents: this.refundCents,
    cancelledAt: this.cancelledAt,
    cancelReason: this.cancelReason,
    offerExpiresAt: this.offerExpiresAt,
    dispatchAttempts: this.dispatchAttempts,
    dispatchStartedAt: this.dispatchStartedAt,
    noDriversAt: this.noDriversAt,
    requestedAt: this.requestedAt,
    acceptedAt: this.acceptedAt,
    enRouteAt: this.enRouteAt,
    arrivedAt: this.arrivedAt,
    startedAt: this.startedAt,
    completedAt: this.completedAt,
    riderRating: this.riderRating,
    riderReview: this.riderReview,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Trip = mongoose.model("Trip", tripSchema);
