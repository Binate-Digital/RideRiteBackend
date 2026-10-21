import mongoose from "mongoose";

const savedAddressSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    label: {
      type: String,
      enum: ["home", "work", "other"],
      default: "other",
    },
    name: { type: String, trim: true, maxlength: 80, default: "" },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  { timestamps: true },
);

savedAddressSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId.toString(),
    label: this.label,
    name: this.name,
    address: this.address,
    lat: this.lat,
    lng: this.lng,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const SavedAddress = mongoose.model("SavedAddress", savedAddressSchema);
