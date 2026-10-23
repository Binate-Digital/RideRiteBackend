/** US phone helpers — storage/display format: 555-201-0123 */

export function digitsOnly(value = "") {
  let d = String(value).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.slice(0, 10);
}

export function formatUsPhone(value = "") {
  const d = digitsOnly(value);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

export function isCompleteUsPhone(value = "") {
  return digitsOnly(value).length === 10;
}

/** Zod refine helper — empty/null allowed; otherwise must be 10 digits. */
export function normalizeOptionalUsPhone(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (!isCompleteUsPhone(trimmed)) {
    throw new Error("Enter a valid 10-digit US phone (e.g. 555-201-0123)");
  }
  return formatUsPhone(trimmed);
}

/** US number → E.164 (+15552010123), or null when it isn't a complete 10-digit number. */
export function toE164(value = "") {
  const d = digitsOnly(value);
  return d.length === 10 ? `+1${d}` : null;
}

/** "+15552010123" → "555-201-0123" (display / legacy `phone` field format). */
export function e164ToDisplay(e164 = "") {
  return formatUsPhone(String(e164).replace(/^\+1/, ""));
}
