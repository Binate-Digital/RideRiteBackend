import mongoose from "mongoose";

const driverProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    isOnline: { type: Boolean, default: false, index: true },
    vehicleType: {
      type: String,
      enum: ["sedan", "suv", "truck"],
      default: "sedan",
    },
    vehicleMake: { type: String, trim: true, default: "" },
    vehicleModel: { type: String, trim: true, default: "" },
    vehicleColor: { type: String, trim: true, default: "" },
    vehiclePlate: { type: String, trim: true, uppercase: true, default: "" },
    // Simple approval flag for alpha (admin KYC later)
    isApproved: { type: Boolean, default: true },
    lastLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      updatedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

driverProfileSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId.toString(),
    isOnline: this.isOnline,
    vehicleType: this.vehicleType,
    vehicleMake: this.vehicleMake,
    vehicleModel: this.vehicleModel,
    vehicleColor: this.vehicleColor,
    vehiclePlate: this.vehiclePlate,
    isApproved: this.isApproved,
    lastLocation: this.lastLocation,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const DriverProfile = mongoose.model("DriverProfile", driverProfileSchema);
