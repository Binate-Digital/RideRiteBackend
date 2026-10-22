import mongoose from "mongoose";

const promoCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 40 },
    percentOff: { type: Number, min: 0, max: 100, default: null },
    amountOffCents: { type: Number, min: 0, default: null },
    active: { type: Boolean, default: true, index: true },
    expiresAt: { type: Date, default: null },
    maxUses: { type: Number, min: 0, default: null },
    uses: { type: Number, default: 0 },
  },
  { timestamps: true },
);

promoCodeSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    code: this.code,
    percentOff: this.percentOff,
    amountOffCents: this.amountOffCents,
    active: this.active,
    expiresAt: this.expiresAt,
    maxUses: this.maxUses,
    uses: this.uses,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const PromoCode = mongoose.model("PromoCode", promoCodeSchema);
