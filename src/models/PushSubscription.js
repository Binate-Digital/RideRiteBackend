import mongoose from "mongoose";

/** One browser's Web Push subscription (endpoint + keys from PushManager.subscribe). */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    endpoint: { type: String, required: true, unique: true, maxlength: 2048 },
    keys: {
      p256dh: { type: String, required: true, maxlength: 512 },
      auth: { type: String, required: true, maxlength: 256 },
    },
    userAgent: { type: String, default: "" },
    lastSuccessAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);
