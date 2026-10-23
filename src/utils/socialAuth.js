import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";

/**
 * Verifies identity tokens from Google Identity Services and Sign in with Apple and
 * returns a normalized profile: { provider, subject, email, emailVerified, name }.
 *
 * GOOGLE_CLIENT_ID / APPLE_CLIENT_ID unset → that provider is "not configured" (503).
 * Under NODE_ENV=test, GOOGLE_CERTS_URL / APPLE_JWKS_URL point the key fetch at a local
 * server so tests can sign tokens with their own keys; the verification code is the same.
 */
export function socialProviders() {
  return {
    google: env.googleClientIds.length > 0,
    apple: env.appleClientIds.length > 0,
  };
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

let appleJwks = null;
function getAppleJwks() {
  if (!appleJwks) appleJwks = createRemoteJWKSet(new URL(env.appleJwksUrl));
  return appleJwks;
}

function notConfigured(provider) {
  return httpError(503, `${provider === "google" ? "Google" : "Apple"} sign-in is not configured on this server`, {
    code: "SOCIAL_NOT_CONFIGURED",
  });
}

const invalidToken = () => httpError(401, "Sign-in token is invalid or expired", { code: "SOCIAL_TOKEN_INVALID" });

export async function verifyGoogleIdToken(idToken) {
  if (!socialProviders().google) throw notConfigured("google");
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

export async function verifyAppleIdToken(idToken) {
  if (!socialProviders().apple) throw notConfigured("apple");
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getAppleJwks(), {
      issuer: "https://appleid.apple.com",
      audience: env.appleClientIds,
    }));
  } catch {
    throw invalidToken();
  }
  if (!payload?.sub) throw invalidToken();
  return {
    provider: "apple",
    subject: String(payload.sub),
    email: payload.email ? String(payload.email).toLowerCase() : null,
    // Apple only issues verified (or private-relay) addresses; the claim may be a string
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: null, // Apple sends the name to the client once, not in the token
  };
}
