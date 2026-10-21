import mongoose from "mongoose";

const tripMessageSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "Trip", required: true, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, maxlength: 1000 },
  },
  { timestamps: true },
);

tripMessageSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    tripId: this.tripId.toString(),
    senderId: this.senderId.toString(),
    body: this.body,
    createdAt: this.createdAt,
  };
};

export const TripMessage = mongoose.model("TripMessage", tripMessageSchema);
