import mongoose from "mongoose";

/**
 * Masked in-app chat (TRD 4.6). One collection for every conversation: a ride (`tripId`) or a
 * booking (`bookingKind` chauffeur | rental + `bookingId`). Phone numbers are never exchanged.
 */
const tripMessageSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "Trip", default: null, index: true },
    bookingKind: { type: String, enum: ["chauffeur", "rental", null], default: null },
    bookingId: { type: mongoose.Schema.Types.ObjectId, default: null },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** Fleet rentals: an admin answering as RideRite support */
    senderRole: { type: String, enum: ["party", "support"], default: "party" },
    body: { type: String, required: true, maxlength: 1000 },
  },
  { timestamps: true },
);

tripMessageSchema.index({ bookingKind: 1, bookingId: 1, createdAt: 1 });

tripMessageSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    tripId: this.tripId ? this.tripId.toString() : null,
    bookingKind: this.bookingKind || null,
    bookingId: this.bookingId ? this.bookingId.toString() : null,
    senderId: this.senderId.toString(),
    senderRole: this.senderRole || "party",
    body: this.body,
    createdAt: this.createdAt,
  };
};

export const TripMessage = mongoose.model("TripMessage", tripMessageSchema);
