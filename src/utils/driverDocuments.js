/**
 * Driver documents (TRD 5.1 / 5.2): driver license (front + back), vehicle registration and
 * insurance. Each has uploaded file(s), an expiry date and a review status.
 *
 * Expiry dates are real Dates (`dlExpiresAt`, `registrationExpiresAt`, `insuranceExpiresAt`).
 * Profiles from before Phase 4 only have the free-text `dlExpiresOn` / `insuranceExpiresOn`
 * strings — those are still read as a fallback, and the driver sweeper copies them into the
 * Date fields (see migrateLegacyExpiryDates in driverCompliance.js).
 *
 * A document whose expiry day has passed blocks going online and accepting rides until a new
 * file + a future expiry date are uploaded (see driverReadiness.js). Pure helpers only — no
 * model imports, so the DriverProfile model can use them.
 */

const DAY_MS = 86400000;

export const DOCUMENT_TYPES = ["license", "registration", "insurance"];

export const DOCUMENT_LABELS = {
  license: "driver's license",
  registration: "vehicle registration",
  insurance: "insurance",
};

/** Profile fields per document: uploaded files, the Date expiry, and the legacy string expiry. */
export const DOCUMENT_FIELDS = {
  license: { files: ["licenseFrontUrl", "licenseBackUrl"], expiresAt: "dlExpiresAt", legacy: "dlExpiresOn" },
  registration: { files: ["registrationDocUrl"], expiresAt: "registrationExpiresAt", legacy: null },
  insurance: { files: ["insuranceDocUrl"], expiresAt: "insuranceExpiresAt", legacy: "insuranceExpiresOn" },
};

/**
 * Free-text date → UTC midnight of that calendar day, or null. Accepts YYYY-MM-DD, ISO strings
 * and the US MM/DD/YYYY form older profiles may hold.
 */
export function parseExpiryDay(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return utcDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return utcDay(Number(m[3]), Number(m[1]), Number(m[2]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDay(y, mo, d) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

const dayKey = (d) => (d ? d.toISOString().slice(0, 10) : null);

/** YYYY-MM-DD for API output: the Date field, else the legacy string (normalised when parseable). */
export function legacyDayString(date, legacy) {
  if (date) return dayKey(parseExpiryDay(date));
  if (!legacy) return null;
  return dayKey(parseExpiryDay(legacy)) || legacy;
}

/** A document's expiry day (Date), reading the legacy string when the Date field is unset. */
export function documentExpiry(profile, doc) {
  const f = DOCUMENT_FIELDS[doc];
  const at = profile?.[f.expiresAt];
  if (at) return parseExpiryDay(at);
  return f.legacy ? parseExpiryDay(profile?.[f.legacy]) : null;
}

function startOfUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Whole days until expiry (0 = expires today, negative = past). A document is valid through
 * its expiry day and expired from the next day on.
 */
export function daysUntil(expiry, now = new Date()) {
  if (!expiry) return null;
  return Math.round((expiry.getTime() - startOfUtcDay(now).getTime()) / DAY_MS);
}

export function isDocumentExpired(profile, doc, now = new Date()) {
  const left = daysUntil(documentExpiry(profile, doc), now);
  return left != null && left < 0;
}

/** Expired documents, oldest expiry first: [{ doc, label, expiresOn }]. */
export function expiredDocuments(profile, now = new Date()) {
  return DOCUMENT_TYPES.filter((doc) => isDocumentExpired(profile, doc, now))
    .map((doc) => ({ doc, label: DOCUMENT_LABELS[doc], expiresOn: dayKey(documentExpiry(profile, doc)) }))
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
}

/** Readiness copy for the first expired document (null when nothing is expired). */
export function expiredDocumentReason(profile, now = new Date()) {
  const [first] = expiredDocuments(profile, now);
  if (!first) return null;
  return `Your ${first.label} expired on ${first.expiresOn} — upload a new ${first.label} with its expiry date to go online`;
}

function hasFiles(profile, doc) {
  return DOCUMENT_FIELDS[doc].files.some((f) => Boolean(profile?.[f]));
}

/** Per-document summary for the driver app and admin: files, expiry, review status, days left. */
export function documentsPayload(profile, now = new Date()) {
  const out = {};
  for (const doc of DOCUMENT_TYPES) {
    const f = DOCUMENT_FIELDS[doc];
    const expiry = documentExpiry(profile, doc);
    const review = profile?.documentReview?.[doc] || {};
    let status = review.status || "missing";
    // Pre Phase 4 approved drivers: their files were reviewed with the account
    if (status === "missing" && hasFiles(profile, doc)) status = profile?.isApproved ? "approved" : "pending";
    out[doc] = {
      label: DOCUMENT_LABELS[doc],
      files: Object.fromEntries(f.files.map((k) => [k, profile?.[k] || null])),
      expiresOn: dayKey(expiry),
      daysLeft: daysUntil(expiry, now),
      expired: isDocumentExpired(profile, doc, now),
      status,
      submittedAt: review.submittedAt || null,
      reviewedAt: review.reviewedAt || null,
      note: review.note || "",
    };
  }
  return out;
}

/** Mongo filter: profiles none of whose (Date) document expiries is before today. */
export function notExpiredFilter(now = new Date()) {
  const today = startOfUtcDay(now);
  return {
    $and: DOCUMENT_TYPES.map((doc) => {
      const field = DOCUMENT_FIELDS[doc].expiresAt;
      return { $or: [{ [field]: null }, { [field]: { $gte: today } }] };
    }),
  };
}
