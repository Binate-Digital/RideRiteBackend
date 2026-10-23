import mongoose from "mongoose";

/**
 * One row per (listing, calendar day) a rental booking holds. The unique index makes
 * double booking impossible even when two requests race: the second insert of a day fails.
 * Rows are removed when an unpaid hold expires or the booking is cancelled.
 */
const rentalDaySlotSchema = new mongoose.Schema(
  {
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: "RentalListing", required: true },
    /** UTC calendar day, YYYY-MM-DD */
    day: { type: String, required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "RentalBooking", required: true, index: true },
  },
  { timestamps: true },
);

rentalDaySlotSchema.index({ listingId: 1, day: 1 }, { unique: true });

export const RentalDaySlot = mongoose.model("RentalDaySlot", rentalDaySlotSchema);
