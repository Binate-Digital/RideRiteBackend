import mongoose from "mongoose";

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
      enum: ["requested", "confirmed", "in_progress", "completed", "cancelled"],
      default: "requested",
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
    hourlyRateCents: this.hourlyRateCents,
    totalCents: this.totalCents,
    notes: this.notes,
    status: this.status,
    paid: this.paid,
    paymentStatus: this.paymentStatus,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const ChauffeurBooking = mongoose.model("ChauffeurBooking", chauffeurBookingSchema);
