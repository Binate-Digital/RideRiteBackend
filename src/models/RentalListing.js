import mongoose from "mongoose";

const rentalListingSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    source: { type: String, enum: ["peer", "fleet"], default: "peer", index: true },
    title: { type: String, required: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 2000 },
    vehicleType: { type: String, enum: ["sedan", "suv", "truck"], required: true },
    make: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, required: true },
    plate: { type: String, default: "" },
    color: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "FL" },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    dailyRateCents: { type: Number, required: true },
    photos: [{ type: String }],
    status: {
      type: String,
      enum: ["draft", "pending", "active", "paused", "rejected"],
      default: "pending",
      index: true,
    },
    availableFrom: { type: Date, default: null },
    availableTo: { type: Date, default: null },
    /** Owner-blocked calendar days (UTC YYYY-MM-DD) — never bookable (TRD 5.8) */
    blockedDays: { type: [String], default: [] },
    /**
     * Daily rate admin last approved. An owner price change of more than
     * RENTAL_PRICE_REVIEW_CHANGE_PERCENT from it sends an approved listing back to review.
     */
    approvedDailyRateCents: { type: Number, default: null },
    /** Why a listing is (back) in review: new | price_change | details_changed */
    reviewReason: { type: String, default: null },
  },
  { timestamps: true },
);

rentalListingSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    ownerId: this.ownerId.toString(),
    source: this.source,
    title: this.title,
    description: this.description,
    vehicleType: this.vehicleType,
    make: this.make,
    model: this.model,
    year: this.year,
    plate: this.plate,
    color: this.color,
    city: this.city,
    state: this.state,
    lat: this.lat,
    lng: this.lng,
    dailyRateCents: this.dailyRateCents,
    photos: this.photos,
    status: this.status,
    availableFrom: this.availableFrom,
    availableTo: this.availableTo,
    blockedDays: this.blockedDays || [],
    approvedDailyRateCents: this.approvedDailyRateCents,
    reviewReason: this.reviewReason,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const RentalListing = mongoose.model("RentalListing", rentalListingSchema);
