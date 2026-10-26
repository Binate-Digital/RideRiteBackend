import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";

/**
 * Verifies Google Identity Services ID tokens (the only social sign-in) and returns a
 * normalized profile: { provider, subject, email, emailVerified, name }.
 *
 * GOOGLE_CLIENT_ID unset → "not configured" (503). Under NODE_ENV=test, GOOGLE_CERTS_URL
 * points the key fetch at a local server so tests can sign tokens with their own keys; the
 * verification code is the same.
 */
export function socialProviders() {
  return { google: env.googleClientIds.length > 0 };
}

let googleClient = null;
function getGoogleClient() {
  if (!googleClient) {
    googleClient = new OAuth2Client({
      ...(env.googleCertsUrl ? { endpoints: { oauth2FederatedSignonPemCertsUrl: env.googleCertsUrl } } : {}),
    });
  }
  return googleClient;
}

const notConfigured = () =>
  httpError(503, "Google sign-in is not configured on this server", { code: "SOCIAL_NOT_CONFIGURED" });

const invalidToken = () => httpError(401, "Sign-in token is invalid or expired", { code: "SOCIAL_TOKEN_INVALID" });

export async function verifyGoogleIdToken(idToken) {
  if (!socialProviders().google) throw notConfigured();
  let payload;
  try {
    const ticket = await getGoogleClient().verifyIdToken({ idToken, audience: env.googleClientIds });
    payload = ticket.getPayload();
  } catch {
    throw invalidToken();
  }
  if (!payload?.sub) throw invalidToken();
  return {
    provider: "google",
    subject: payload.sub,
    email: payload.email ? String(payload.email).toLowerCase() : null,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(" ") || null,
  };
}
