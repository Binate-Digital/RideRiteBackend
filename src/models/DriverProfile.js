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
    vehicleYear: { type: Number, default: null },
    vehicleVin: { type: String, trim: true, uppercase: true, default: "" },

    // Identity / KYC
    dateOfBirth: { type: String, default: null },
    addressLine1: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, uppercase: true, default: "FL" },
    zip: { type: String, trim: true, default: "" },
    dlNumber: { type: String, trim: true, default: "" },
    dlState: { type: String, trim: true, uppercase: true, default: "FL" },
    dlExpiresOn: { type: String, default: null },
    licenseFrontUrl: { type: String, default: null },
    licenseBackUrl: { type: String, default: null },

    // Insurance
    insuranceCarrier: { type: String, trim: true, default: "" },
    insurancePolicyNumber: { type: String, trim: true, default: "" },
    insuranceExpiresOn: { type: String, default: null },

    verificationStatus: {
      type: String,
      enum: ["incomplete", "pending", "approved", "rejected"],
      default: "incomplete",
    },
    verificationSubmittedAt: { type: Date, default: null },
    verificationSkippedAt: { type: Date, default: null },

    // Admin must approve after reviewing license / docs
    isApproved: { type: Boolean, default: false },
    stripeConnectAccountId: { type: String, default: null, index: true },
    stripeConnectChargesEnabled: { type: Boolean, default: false },
    stripeConnectPayoutsEnabled: { type: Boolean, default: false },
    stripeConnectDetailsSubmitted: { type: Boolean, default: false },
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
    vehicleYear: this.vehicleYear,
    vehicleVin: this.vehicleVin,
    dateOfBirth: this.dateOfBirth,
    addressLine1: this.addressLine1,
    city: this.city,
    state: this.state,
    zip: this.zip,
    dlNumber: this.dlNumber,
    dlState: this.dlState,
    dlExpiresOn: this.dlExpiresOn,
    licenseFrontUrl: this.licenseFrontUrl,
    licenseBackUrl: this.licenseBackUrl,
    insuranceCarrier: this.insuranceCarrier,
    insurancePolicyNumber: this.insurancePolicyNumber,
    insuranceExpiresOn: this.insuranceExpiresOn,
    verificationStatus: this.verificationStatus,
    verificationSubmittedAt: this.verificationSubmittedAt,
    verificationSkippedAt: this.verificationSkippedAt,
    isApproved: this.isApproved,
    stripeConnectAccountId: this.stripeConnectAccountId,
    stripeConnectChargesEnabled: this.stripeConnectChargesEnabled,
    stripeConnectPayoutsEnabled: this.stripeConnectPayoutsEnabled,
    stripeConnectDetailsSubmitted: this.stripeConnectDetailsSubmitted,
    lastLocation: this.lastLocation,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const DriverProfile = mongoose.model("DriverProfile", driverProfileSchema);
