import mongoose from "mongoose";
import { watchForAdmins } from "../utils/adminEvents.js";

const chauffeurBookingSchema = new mongoose.Schema(
  {
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    pickupAddress: { type: String, required: true, maxlength: 300 },
    pickupCoords: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    startAt: { type: Date, required: true },
    durationHours: { type: Number, required: true, min: 1, max: 24 },
    vehicleType: { type: String, enum: ["sedan", "suv", "truck"], default: "sedan" },
    hourlyRateCents: { type: Number, required: true },
    totalCents: { type: Number, required: true },
    notes: { type: String, default: "", maxlength: 500 },
    status: {
      type: String,
      // confirmed (paid, looking for a driver) → driver_assigned → in_progress → completed
      enum: [
        "pending_payment",
        "requested",
        "confirmed",
        "driver_assigned",
        "in_progress",
        "completed",
        "cancelled",
        "expired",
      ],
      default: "pending_payment",
      index: true,
    },
    paid: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "pending", "paid", "refunding", "refunded", "partially_refunded", "failed"],
      default: "unpaid",
    },
    /** Service tier the rider picked (see CHAUFFEUR_TIERS); vehicleType follows from it. */
    tier: { type: String, default: null },
    holdExpiresAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null },
    stripePaymentIntentId: { type: String, default: null, index: true },
    assignedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    /** rider | system (no driver accepted before the start time) */
    cancelledBy: { type: String, default: null },
    cancelReason: { type: String, default: null },
    refundCents: { type: Number, default: 0 },
    refundPercent: { type: Number, default: null },
    /** Reminder keys already sent, e.g. { rider_1440: Date, driver_60: Date } */
    remindersSent: { type: Object, default: {} },
    /**
     * How the driver is found. auto: offered to every eligible driver, first to accept wins.
     * direct: the rider picked `requestedDriverId`; only that driver is offered the booking
     * until `directOfferExpiresAt` (then: declined / timed out → rider picks again, or auto
     * when `autoFallback`).
     */
    assignmentMode: { type: String, enum: ["auto", "direct"], default: "auto" },
    requestedDriverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    directOfferExpiresAt: { type: Date, default: null, index: true },
    autoFallback: { type: Boolean, default: false },
    /** The picked driver declined / timed out and the rider hasn't chosen what to do yet */
    needsDriverChoice: { type: Boolean, default: false },
    /** Drivers who declined or let a direct request time out (not offered again) */
    directDeclines: {
      type: [
        {
          _id: false,
          driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          reason: { type: String, enum: ["declined", "timeout"] },
          at: { type: Date },
        },
      ],
      default: [],
    },
  },
  { timestamps: true, minimize: false },
);

// Driver hub: open bookings of a vehicle type, soonest first
chauffeurBookingSchema.index({ status: 1, vehicleType: 1, startAt: 1 });

// Live admin dashboard counters (realtime/index.js)
watchForAdmins(chauffeurBookingSchema, "chauffeur");

chauffeurBookingSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    riderId: this.riderId.toString(),
    driverId: this.driverId ? this.driverId.toString() : null,
    pickupAddress: this.pickupAddress,
    pickupCoords: this.pickupCoords,
    startAt: this.startAt,
    durationHours: this.durationHours,
    vehicleType: this.vehicleType,
    tier: this.tier,
    hourlyRateCents: this.hourlyRateCents,
    totalCents: this.totalCents,
    notes: this.notes,
    status: this.status,
    paid: this.paid,
    paymentStatus: this.paymentStatus,
    holdExpiresAt: this.holdExpiresAt,
    paidAt: this.paidAt,
    assignedAt: this.assignedAt,
    startedAt: this.startedAt,
    completedAt: this.completedAt,
    cancelledAt: this.cancelledAt,
    cancelledBy: this.cancelledBy,
    cancelReason: this.cancelReason,
    refundCents: this.refundCents,
    refundPercent: this.refundPercent,
    assignmentMode: this.assignmentMode || "auto",
    requestedDriverId: this.requestedDriverId ? this.requestedDriverId.toString() : null,
    directOfferExpiresAt: this.directOfferExpiresAt,
    autoFallback: Boolean(this.autoFallback),
    needsDriverChoice: Boolean(this.needsDriverChoice),
    /** Drivers who passed on it (the picker hides them) */
    declinedDriverIds: (this.directDeclines || []).map((d) => String(d.driverId)),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const ChauffeurBooking = mongoose.model("ChauffeurBooking", chauffeurBookingSchema);
