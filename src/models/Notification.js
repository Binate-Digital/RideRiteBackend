import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    category: {
      type: String,
      enum: [
        "ride",
        "payment",
        "rental",
        "chauffeur",
        "subscription",
        "bonus",
        "maintenance",
        "payout",
        "system",
        "promo",
      ],
      default: "system",
      index: true,
    },
    title: { type: String, required: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 500 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Inbox / bell: a user's newest notifications
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId.toString(),
    category: this.category,
    title: this.title,
    body: this.body,
    data: this.data,
    readAt: this.readAt,
    createdAt: this.createdAt,
  };
};

export const Notification = mongoose.model("Notification", notificationSchema);
