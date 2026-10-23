import { env } from "./env.js";

// Always allow WEB_APP_URL + CORS_ORIGIN list + known UAT frontends.
const knownUatOrigins = [
  "https://riderite-admin.deployment-uat.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];
const allowedOriginSet = new Set(
  [env.webAppUrl, ...String(env.corsOrigin || "").split(","), ...knownUatOrigins]
    .map((s) => String(s || "").trim().replace(/\/$/, ""))
    .filter(Boolean),
);
const allowAllOrigins = env.corsOrigin === "*";

/**
 * `origin` callback shared by Express CORS and Socket.IO so both accept the same sites.
 * Never errors — a cors Error becomes HTTP 500 and browsers report "CORS failed".
 */
export function corsOrigin(origin, cb) {
  // Non-browser / same-origin tools send no Origin
  if (!origin) return cb(null, true);
  if (allowAllOrigins) return cb(null, true);
  const normalized = origin.replace(/\/$/, "");
  if (allowedOriginSet.has(normalized)) return cb(null, true);
  console.warn(
    `[cors] blocked origin: ${origin} (allowed: ${[...allowedOriginSet].join(", ")})`,
  );
  return cb(null, false);
}
