import mongoose from "mongoose";
import { watchForAdmins } from "../utils/adminEvents.js";

const rentalBookingSchema = new mongoose.Schema(
  {
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: "RentalListing", required: true, index: true },
    renterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    days: { type: Number, required: true },
    dailyRateCents: { type: Number, required: true },
    subtotalCents: { type: Number, required: true },
    commissionCents: { type: Number, default: 0 },
    totalCents: { type: Number, required: true },
    status: {
      type: String,
      // expired: payment not completed before holdExpiresAt — its dates were released
      enum: ["pending_payment", "confirmed", "active", "completed", "cancelled", "expired"],
      default: "pending_payment",
      index: true,
    },
    paid: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      // refunding: a cancellation refund is being sent to Stripe (claimed so it runs once)
      enum: ["unpaid", "pending", "paid", "refunding", "refunded", "partially_refunded", "failed"],
      default: "unpaid",
    },
    source: { type: String, enum: ["peer", "fleet"], default: "peer" },
    /** Unpaid bookings release their day slots after this. */
    holdExpiresAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null },
    stripePaymentIntentId: { type: String, default: null, index: true },
    /** Renter cancelled a paid booking: refund owed per the cancellation policy */
    cancelledAt: { type: Date, default: null },
    /** renter (cancel per policy) or owner (declined within RENTAL_OWNER_DECLINE_HOURS, full refund) */
    cancelledBy: { type: String, enum: ["renter", "owner", "system", null], default: null },
    declineReason: { type: String, default: "" },
    refundCents: { type: Number, default: 0 },
    refundPercent: { type: Number, default: null },
    /** Reminder keys already sent, e.g. { renter_1440: Date } (see utils/reminders.js) */
    remindersSent: { type: Object, default: {} },
  },
  { timestamps: true, minimize: false },
);

// Live admin dashboard counters (realtime/index.js)
watchForAdmins(rentalBookingSchema, "rental");

rentalBookingSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    listingId: this.listingId.toString(),
    renterId: this.renterId.toString(),
    ownerId: this.ownerId.toString(),
    startDate: this.startDate,
    endDate: this.endDate,
    days: this.days,
    dailyRateCents: this.dailyRateCents,
    subtotalCents: this.subtotalCents,
    commissionCents: this.commissionCents,
    totalCents: this.totalCents,
    status: this.status,
    paid: this.paid,
    paymentStatus: this.paymentStatus,
    source: this.source,
    holdExpiresAt: this.holdExpiresAt,
    paidAt: this.paidAt,
    cancelledAt: this.cancelledAt,
    cancelledBy: this.cancelledBy,
    declineReason: this.declineReason,
    refundCents: this.refundCents,
    refundPercent: this.refundPercent,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const RentalBooking = mongoose.model("RentalBooking", rentalBookingSchema);
