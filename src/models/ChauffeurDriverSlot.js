import mongoose from "mongoose";

/**
 * A private driver's (chauffeur's) calendar, in CHAUFFEUR_SLOT_MINUTES blocks. One row per
 * (driver, block) a chauffeur booking holds; the unique index makes double-booking a driver
 * for overlapping time windows impossible even when two requests race (the second insert of
 * any shared block fails), across API instances. Held from the moment a rider picks the driver
 * (or the driver accepts) until the booking is cancelled, declined or times out.
 */
export const CHAUFFEUR_SLOT_MINUTES = 15;

const chauffeurDriverSlotSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** floor(epoch minutes / CHAUFFEUR_SLOT_MINUTES) */
    slot: { type: Number, required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "ChauffeurBooking", required: true, index: true },
  },
  { timestamps: true },
);

chauffeurDriverSlotSchema.index({ driverId: 1, slot: 1 }, { unique: true });

export const ChauffeurDriverSlot = mongoose.model("ChauffeurDriverSlot", chauffeurDriverSlotSchema);
