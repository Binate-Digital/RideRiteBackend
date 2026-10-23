import nodemailer from "nodemailer";
import { env } from "../config/env.js";

let transporter = null;

function smtpConfigured() {
  return Boolean(env.smtp.host && env.smtp.user && env.smtp.pass);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      // 465 is implicit TLS; 587/25 upgrade with STARTTLS
      secure: env.smtp.secure || env.smtp.port === 465,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    });
  }
  return transporter;
}

function fromAddress() {
  return env.smtp.from || `${env.appName} <noreply@riderite.local>`;
}

/**
 * Sends through SMTP when SMTP_HOST/USER/PASS are set; otherwise logs the email to the
 * console (local dev / QA). Never throws — a failed email must not fail the request.
 */
export async function sendMail({ to, subject, text, html }) {
  const payload = { from: fromAddress(), to, subject, text, html };

  if (smtpConfigured()) {
    try {
      const info = await getTransporter().sendMail(payload);
      return { ok: true, provider: "smtp", messageId: info.messageId };
    } catch (err) {
      console.error(`[mailer] SMTP send failed (${subject} → ${to}):`, err.message);
      return { ok: false, provider: "smtp", error: err.message };
    }
  }

  console.log("\n========== EMAIL (dev) ==========");
  console.log(JSON.stringify(payload, null, 2));
  console.log("=================================\n");

  return { ok: true, provider: "console" };
}

export function verificationEmail({ fullName, otp }) {
  return {
    subject: `Your ${env.appName} verification code`,
    text: `Hi ${fullName},\n\nYour verification code is: ${otp}\n\nEnter this code in the app to verify your email.\nExpires in ${env.emailVerifyExpiresHours} hour(s).`,
    html: `<p>Hi ${fullName},</p><p>Your verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${otp}</p><p>Enter this code in the app to verify your email.</p>`,
  };
}

export function resetPasswordEmail({ fullName, token }) {
  const link = `${env.webAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: `Reset your ${env.appName} password`,
    text: `Hi ${fullName},\n\nReset your password:\n${link}\n\nOr use this token:\n${token}\n\nExpires in ${env.passwordResetExpiresHours} hour(s).`,
    html: `<p>Hi ${fullName},</p><p><a href="${link}">Reset your password</a></p><p>Or paste this token:</p><pre>${token}</pre>`,
  };
}

/** Generic notification email (booking updates, reminders, refunds, membership). */
export function notificationEmail({ fullName, title, body, href }) {
  const link = href ? `${env.webAppUrl}${href.startsWith("/") ? href : `/${href}`}` : null;
  return {
    subject: `${env.appName}: ${title}`,
    text: `Hi ${fullName || "there"},\n\n${title}\n${body}${link ? `\n\nOpen: ${link}` : ""}\n\nManage notifications in the app under Notifications.`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h2 style="margin:0 0 8px">${escapeHtml(title)}</h2>
<p>Hi ${escapeHtml(fullName || "there")},</p>
<p>${escapeHtml(body)}</p>
${link ? `<p><a href="${escapeHtml(link)}">Open in ${escapeHtml(env.appName)}</a></p>` : ""}
<p style="color:#777;font-size:12px">Manage notifications in the app under Notifications.</p>
</div>`,
  };
}

// ---------- Receipts ----------

const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** `lines`: [{ label, cents }] shown above the total. `details`: [[label, value]]. */
function receiptEmail({ fullName, title, reference, details, lines, totalCents, footer }) {
  const textLines = [
    `Hi ${fullName || "there"},`,
    "",
    `${title} — receipt ${reference}`,
    "",
    ...details.map(([k, v]) => `${k}: ${v}`),
    "",
    ...lines.map((l) => `${l.label}: ${l.cents < 0 ? "-" : ""}${money(Math.abs(l.cents))}`),
    `Total charged: ${money(totalCents)}`,
    "",
    footer || `Thanks for choosing ${env.appName}.`,
  ];
  const row = (k, v, bold = false) =>
    `<tr><td style="padding:4px 0;color:#555">${escapeHtml(k)}</td><td style="padding:4px 0;text-align:right;${bold ? "font-weight:700" : ""}">${escapeHtml(v)}</td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h2 style="margin:0 0 4px">${escapeHtml(env.appName)} receipt</h2>
<p style="margin:0 0 16px;color:#555">${escapeHtml(title)} · ${escapeHtml(reference)}</p>
<p>Hi ${escapeHtml(fullName || "there")},</p>
<table style="width:100%;border-collapse:collapse;margin:12px 0">${details.map(([k, v]) => row(k, v)).join("")}</table>
<table style="width:100%;border-collapse:collapse;border-top:1px solid #ddd;margin-top:8px">
${lines.map((l) => row(l.label, `${l.cents < 0 ? "-" : ""}${money(Math.abs(l.cents))}`)).join("")}
${row("Total charged", money(totalCents), true)}
</table>
<p style="color:#555;font-size:13px;margin-top:16px">${escapeHtml(footer || `Thanks for choosing ${env.appName}.`)}</p>
</div>`;
  return { subject: `Your ${env.appName} receipt — ${title}`, text: textLines.join("\n"), html };
}

export function rideReceiptEmail({ fullName, trip }) {
  const lines = [
    { label: "Base fare", cents: trip.baseFareCents },
    { label: "Service fee", cents: trip.serviceFeeCents },
    { label: "Tax", cents: trip.taxCents },
  ];
  if (trip.discountCents) lines.push({ label: `Promo ${trip.promoCode || ""}`.trim(), cents: -trip.discountCents });
  return receiptEmail({
    fullName,
    title: "Ride",
    reference: `#${String(trip._id).slice(-8).toUpperCase()}`,
    details: [
      ["From", trip.pickupAddress],
      ["To", trip.destinationAddress],
      ["Vehicle", String(trip.vehicleType || "").toUpperCase()],
      ["Distance", `${trip.distanceMiles} mi · ${trip.durationMinutes} min`],
      ["Completed", new Date(trip.completedAt || Date.now()).toLocaleString("en-US")],
      ["Payment", trip.paymentMethod],
    ],
    lines,
    totalCents: trip.fareCents,
  });
}

export function rentalReceiptEmail({ fullName, booking, listing }) {
  return receiptEmail({
    fullName,
    title: "Car rental",
    reference: `#${String(booking._id).slice(-8).toUpperCase()}`,
    details: [
      ["Vehicle", listing?.title || "Rental vehicle"],
      ["Pickup", new Date(booking.startDate).toDateString()],
      ["Return", new Date(booking.endDate).toDateString()],
      ["Location", [listing?.city, listing?.state].filter(Boolean).join(", ")],
    ],
    lines: [{ label: `${money(booking.dailyRateCents)} × ${booking.days} day(s)`, cents: booking.subtotalCents }],
    totalCents: booking.totalCents,
  });
}

export function chauffeurReceiptEmail({ fullName, booking }) {
  return receiptEmail({
    fullName,
    title: "Private driver",
    reference: `#${String(booking._id).slice(-8).toUpperCase()}`,
    details: [
      ["Pickup", booking.pickupAddress],
      ["Starts", new Date(booking.startAt).toLocaleString("en-US")],
      ["Duration", `${booking.durationHours} hour(s)`],
      ["Vehicle", String(booking.vehicleType || "").toUpperCase()],
    ],
    lines: [
      { label: `${money(booking.hourlyRateCents)} × ${booking.durationHours} hr`, cents: booking.totalCents },
    ],
    totalCents: booking.totalCents,
  });
}
