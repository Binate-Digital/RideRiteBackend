import mongoose from "mongoose";
import { documentsPayload, legacyDayString } from "../utils/driverDocuments.js";

/** Review state of one uploaded document (TRD 5.1 / 5.2). */
const documentReviewSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["missing", "pending", "approved", "rejected"],
      default: "missing",
    },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    note: { type: String, default: "" },
  },
  { _id: false },
);

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
    /** Legacy free-text expiry (pre Phase 4). Read as a fallback when dlExpiresAt is unset. */
    dlExpiresOn: { type: String, default: null },
    dlExpiresAt: { type: Date, default: null },
    licenseFrontUrl: { type: String, default: null },
    licenseBackUrl: { type: String, default: null },

    // Insurance
    insuranceCarrier: { type: String, trim: true, default: "" },
    insurancePolicyNumber: { type: String, trim: true, default: "" },
    /** Legacy free-text expiry — fallback for insuranceExpiresAt */
    insuranceExpiresOn: { type: String, default: null },
    insuranceExpiresAt: { type: Date, default: null },
    insuranceDocUrl: { type: String, default: null },

    // Vehicle registration
    registrationDocUrl: { type: String, default: null },
    registrationExpiresAt: { type: Date, default: null },

    /** Per-document review; re-uploading after approval puts just that document back to pending. */
    documentReview: {
      license: { type: documentReviewSchema, default: () => ({}) },
      registration: { type: documentReviewSchema, default: () => ({}) },
      insurance: { type: documentReviewSchema, default: () => ({}) },
    },
    /**
     * Expiry notices already sent, per document: { license: { for: "2026-11-30", sent: { "30": Date } } }.
     * `for` is the expiry day they were sent about — a new expiry date starts a fresh set.
     */
    documentNotices: { type: Object, default: {} },
    /** Maintenance due / overdue notices sent, per service type and due date (utils/maintenance.js) */
    maintenanceNotices: { type: Object, default: {} },

    /**
     * Vehicle type / plate change requested after approval (TRD 5.2). The driver keeps driving
     * the approved vehicle above until an admin approves this (Phase 5 admin).
     */
    pendingVehicleChange: {
      type: new mongoose.Schema(
        {
          vehicleType: { type: String, enum: ["sedan", "suv", "truck"] },
          vehicleMake: String,
          vehicleModel: String,
          vehicleColor: String,
          vehiclePlate: String,
          vehicleYear: Number,
          vehicleVin: String,
          requestedAt: { type: Date, default: Date.now },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Last admin decision on a vehicle change: { status: approved|rejected, at, note, change } */
    lastVehicleChangeReview: { type: Object, default: null },

    verificationStatus: {
      type: String,
      enum: ["incomplete", "pending", "approved", "rejected"],
      default: "incomplete",
    },
    verificationSubmittedAt: { type: Date, default: null },
    /** Last admin account decision: { status: approved|rejected|pending, reason, at, by } (TRD 6.3) */
    reviewDecision: { type: Object, default: null },
    verificationSkippedAt: { type: Date, default: null },

    // Admin must approve after reviewing license / docs
    isApproved: { type: Boolean, default: false },
    stripeConnectAccountId: { type: String, default: null, index: true },
    stripeConnectChargesEnabled: { type: Boolean, default: false },
    stripeConnectPayoutsEnabled: { type: Boolean, default: false },
    stripeConnectDetailsSubmitted: { type: Boolean, default: false },
    /** Home / signup address pin (from location picker) */
    homeLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      updatedAt: { type: Date, default: null },
    },
    /** Live GPS while online / dispatch */
    lastLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      updatedAt: { type: Date, default: null },
    },
  },
  { timestamps: true, minimize: false },
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
    // YYYY-MM-DD (from the Date, or the legacy string) — what the web forms show
    dlExpiresOn: legacyDayString(this.dlExpiresAt, this.dlExpiresOn),
    licenseFrontUrl: this.licenseFrontUrl,
    licenseBackUrl: this.licenseBackUrl,
    insuranceCarrier: this.insuranceCarrier,
    insurancePolicyNumber: this.insurancePolicyNumber,
    insuranceExpiresOn: legacyDayString(this.insuranceExpiresAt, this.insuranceExpiresOn),
    insuranceDocUrl: this.insuranceDocUrl,
    registrationDocUrl: this.registrationDocUrl,
    registrationExpiresOn: legacyDayString(this.registrationExpiresAt, null),
    /** License / registration / insurance: files, expiry, review status, days left */
    documents: documentsPayload(this),
    pendingVehicleChange: this.pendingVehicleChange
      ? { ...(this.pendingVehicleChange.toObject?.() ?? this.pendingVehicleChange) }
      : null,
    lastVehicleChangeReview: this.lastVehicleChangeReview,
    verificationStatus: this.verificationStatus,
    verificationSubmittedAt: this.verificationSubmittedAt,
    reviewDecision: this.reviewDecision
      ? { status: this.reviewDecision.status, reason: this.reviewDecision.reason || "", at: this.reviewDecision.at }
      : null,
    verificationSkippedAt: this.verificationSkippedAt,
    isApproved: this.isApproved,
    stripeConnectAccountId: this.stripeConnectAccountId,
    stripeConnectChargesEnabled: this.stripeConnectChargesEnabled,
    stripeConnectPayoutsEnabled: this.stripeConnectPayoutsEnabled,
    stripeConnectDetailsSubmitted: this.stripeConnectDetailsSubmitted,
    homeLocation: this.homeLocation,
    lastLocation: this.lastLocation,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const DriverProfile = mongoose.model("DriverProfile", driverProfileSchema);
