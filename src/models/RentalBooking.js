import mongoose from "mongoose";

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
      enum: ["pending_payment", "confirmed", "active", "completed", "cancelled"],
      default: "pending_payment",
      index: true,
    },
    paid: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "refunded", "failed"],
      default: "unpaid",
    },
  },
  { timestamps: true },
);

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
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const RentalBooking = mongoose.model("RentalBooking", rentalBookingSchema);
