import mongoose from "mongoose";

/**
 * Platform settings edited from the admin panel (TRD 6.8 cancellation fee rules, fares,
 * commissions, …). One document (`_id: "global"`) holding only the values an admin changed;
 * everything else falls back to env / code defaults (see utils/settings.js).
 */
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    overrides: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false },
);

export const Settings = mongoose.model("Settings", settingsSchema);
