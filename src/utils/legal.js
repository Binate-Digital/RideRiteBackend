import { LegalPage } from "../models/LegalPage.js";

/**
 * Legal pages (admin-editable, utils for the controller and signup consent).
 *
 * The four core pages are seeded on first use with clearly marked lorem-ipsum placeholders
 * (neither the TRD nor the proposal contains legal text); an admin replaces them in the admin
 * panel. Core pages can be edited but not deleted. The Florida compliance page stays a web
 * page of its own.
 */

export const CORE_LEGAL_PAGES = [
  {
    slug: "terms",
    title: "Terms & Conditions",
    sections: [
      "Acceptance of these Terms",
      "Eligibility and Accounts",
      "Rides, Rentals and Private Drivers",
      "Fares, Fees and Payment",
      "Cancellations",
      "Driver Partners",
      "User Conduct",
      "Disclaimers and Limitation of Liability",
      "Dispute Resolution",
      "Changes to these Terms",
      "Contact",
    ],
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    sections: [
      "Information We Collect",
      "Location Data",
      "How We Use Information",
      "Sharing and Disclosure",
      "Driver Documents",
      "Data Retention",
      "Your Rights and Choices",
      "Security",
      "Children's Privacy",
      "Changes to this Policy",
      "Contact",
    ],
  },
  {
    slug: "refund-policy",
    title: "Refund & Cancellation Policy",
    sections: [
      "Ride Cancellations",
      "Cancellation Fees",
      "Pay on Drop-off Rides",
      "Car Rental Cancellations",
      "Private Driver Cancellations",
      "Driver Memberships",
      "How Refunds Are Issued",
      "Disputes",
      "Contact",
    ],
  },
  {
    slug: "eula",
    title: "End User License Agreement",
    sections: [
      "License Grant",
      "Restrictions",
      "Ownership",
      "Third-Party Services",
      "Updates",
      "Termination",
      "Disclaimer of Warranties",
      "Limitation of Liability",
      "Governing Law",
      "Contact",
    ],
  },
];

export const CORE_SLUGS = CORE_LEGAL_PAGES.map((p) => p.slug);
/** Pages a signup agrees to (versions recorded on the user) */
export const CONSENT_SLUGS = ["terms", "privacy"];

export const PLACEHOLDER_NOTE = "> **Placeholder — final text pending legal review.** The text below is lorem ipsum and is not a binding policy.";

const LOREM = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. Donec ullamcorper nulla non metus auctor fringilla.",
  "Cras mattis consectetur purus sit amet fermentum. Maecenas faucibus mollis interdum. Nullam quis risus eget urna mollis ornare vel eu leo. Vestibulum id ligula porta felis euismod semper.",
  "Aenean lacinia bibendum nulla sed consectetur. Curabitur blandit tempus porttitor. Etiam porta sem malesuada magna mollis euismod. Sed posuere consectetur est at lobortis.",
];
const BULLETS = ["Lorem ipsum dolor sit amet", "Consectetur adipiscing elit", "Sed do eiusmod tempor incididunt"];

export function placeholderBody(page) {
  const parts = [PLACEHOLDER_NOTE, "", `_Last updated: placeholder_`, ""];
  page.sections.forEach((heading, i) => {
    parts.push(`## ${i + 1}. ${heading}`, "", LOREM[i % LOREM.length], "");
    if (i % 3 === 1) parts.push(...BULLETS.map((b) => `- ${b}`), "");
  });
  return parts.join("\n").trim();
}

/** Seed missing core pages (idempotent; safe on every start and on every read). */
export async function ensureLegalPages() {
  for (const page of CORE_LEGAL_PAGES) {
    await LegalPage.updateOne(
      { slug: page.slug },
      { $setOnInsert: { slug: page.slug, title: page.title, body: placeholderBody(page), version: 1, placeholder: true } },
      { upsert: true },
    ).catch((err) => {
      if (err?.code !== 11000) throw err;
    });
  }
}

/**
 * Markdown as stored: raw HTML tags and `javascript:` style link targets removed, so the
 * stored text is safe even for a renderer that forgot to escape. Renderers still escape.
 */
export function sanitizeMarkdown(input) {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, "](#)")
    .slice(0, 200000);
}

/** "terms:v3,privacy:v2" — the versions a new account agrees to. */
export async function consentVersion() {
  await ensureLegalPages();
  const rows = await LegalPage.find({ slug: { $in: CONSENT_SLUGS } }).select("slug version").lean();
  const by = Object.fromEntries(rows.map((r) => [r.slug, r.version]));
  return CONSENT_SLUGS.map((s) => `${s}:v${by[s] ?? 1}`).join(",");
}

/** Fields stamped on a user who ticked "I agree to the Terms and Privacy Policy". */
export async function termsConsentFields(now = new Date()) {
  return { termsAcceptedAt: now, termsVersion: await consentVersion() };
}
