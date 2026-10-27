import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";

/**
 * Verifies Firebase Authentication ID tokens (Google and Apple sign-in) and returns a normalized
 * profile: { provider, firebaseUid, providerUid, email, emailVerified, name, picture }.
 *
 * Firebase only proves who the person is; our own JWT session stays the source of truth.
 * FIREBASE_PROJECT_ID unset → "not configured" (503). Under NODE_ENV=test, FIREBASE_JWKS_URL
 * points the key fetch at a local server so tests can sign tokens with their own keys; the
 * verification code is the same.
 */
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/** Firebase sign-in methods we accept, mapped to the User field holding the provider's own uid. */
export const FIREBASE_PROVIDERS = { "google.com": "google", "apple.com": "apple" };

/** Allowed clock skew (seconds) between Google's servers and ours. */
const CLOCK_SKEW_SECONDS = 60;

export function socialProviders() {
  const on = Boolean(env.firebaseProjectId);
  return { firebase: on, google: on, apple: on };
}

let jwks = null;
function getJwks() {
  // jose caches the keys and refetches on an unknown kid (Google rotates them)
  if (!jwks) jwks = createRemoteJWKSet(new URL(env.firebaseJwksUrl || FIREBASE_JWKS_URL));
  return jwks;
}

const notConfigured = () =>
  httpError(503, "Google / Apple sign-in is not configured on this server", { code: "SOCIAL_NOT_CONFIGURED" });

const invalidToken = () => httpError(401, "Sign-in token is invalid or expired", { code: "SOCIAL_TOKEN_INVALID" });

export async function verifyFirebaseIdToken(idToken) {
  const projectId = env.firebaseProjectId;
  if (!projectId) throw notConfigured();
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, getJwks(), {
      algorithms: ["RS256"],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      requiredClaims: ["exp", "iat", "auth_time", "sub"],
      clockTolerance: CLOCK_SKEW_SECONDS,
    }));
  } catch {
    throw invalidToken();
  }
  const now = Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS;
  // iat / auth_time must not be in the future; sub is the Firebase uid (non-empty, ≤ 128 chars)
  if (!(Number(payload.iat) <= now) || !(Number(payload.auth_time) <= now)) throw invalidToken();
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 128) throw invalidToken();

  const signInProvider = payload.firebase?.sign_in_provider;
  const provider = FIREBASE_PROVIDERS[signInProvider];
  if (!provider) {
    throw httpError(400, "Only Google and Apple sign-in are supported", { code: "SOCIAL_PROVIDER_UNSUPPORTED" });
  }
  const ids = payload.firebase?.identities?.[signInProvider];
  const providerUid = Array.isArray(ids) && ids[0] ? String(ids[0]) : null;
  return {
    provider,
    firebaseUid: payload.sub,
    providerUid,
    email: payload.email ? String(payload.email).toLowerCase() : null,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" ? payload.name.trim() : null,
    picture: typeof payload.picture === "string" && /^https:\/\//.test(payload.picture) ? payload.picture : null,
  };
}
