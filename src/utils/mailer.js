import { env } from "../config/env.js";

/**
 * Dev mailer — logs to console. Swap for Resend/SendGrid/Nodemailer later.
 */
export async function sendMail({ to, subject, text, html }) {
  const payload = {
    from: `${env.appName} <noreply@riderite.local>`,
    to,
    subject,
    text,
    html,
  };

  console.log("\n========== EMAIL (dev) ==========");
  console.log(JSON.stringify(payload, null, 2));
  console.log("=================================\n");

  return { ok: true, provider: "console" };
}

export function verificationEmail({ fullName, token }) {
  const link = `${env.webAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const apiLink = `${env.appUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  return {
    subject: `Verify your ${env.appName} email`,
    text: `Hi ${fullName},\n\nVerify your email:\n${link}\n\nOr use this token in the app:\n${token}\n\nAPI fallback: ${apiLink}\n\nExpires in ${env.emailVerifyExpiresHours} hour(s).`,
    html: `<p>Hi ${fullName},</p><p><a href="${link}">Verify your email</a></p><p>Or paste this token in the app:</p><pre>${token}</pre>`,
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
