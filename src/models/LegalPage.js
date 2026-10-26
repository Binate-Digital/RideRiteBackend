import mongoose from "mongoose";

/**
 * Admin-editable legal page (Terms, Privacy, Refund & Cancellation, EULA, …). `body` is
 * Markdown with raw HTML stripped on save (utils/legal.js); clients render it with an
 * escaping Markdown renderer. `version` goes up on every content change — signups store the
 * Terms / Privacy versions they agreed to (User.termsVersion).
 */
const legalPageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]{2,60}$/ },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, default: "", maxlength: 200000 },
    version: { type: Number, default: 1 },
    /** Seeded placeholder text still in place (shown with a "pending legal review" note) */
    placeholder: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

legalPageSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    slug: this.slug,
    title: this.title,
    body: this.body,
    version: this.version,
    placeholder: this.placeholder,
    updatedAt: this.updatedAt,
    updatedBy: this.updatedBy ? this.updatedBy.toString() : null,
  };
};

export const LegalPage = mongoose.model("LegalPage", legalPageSchema);
