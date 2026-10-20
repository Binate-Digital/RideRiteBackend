import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  isDev: (process.env.NODE_ENV || "development") !== "production",
  appName: process.env.APP_NAME || "RideRite",
  appUrl: process.env.APP_URL || "http://localhost:4000",
  /** Frontend origin for verify/reset email deep links */
  webAppUrl: (process.env.WEB_APP_URL || "http://localhost:8080").replace(
    /\/$/,
    "",
  ),
  corsOrigin: (
    process.env.CORS_ORIGIN ||
    "http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean)
    .join(","),
  mongodbUri: required("MONGODB_URI", "mongodb://127.0.0.1:27017/riderite"),
  jwtAccessSecret: required(
    "JWT_ACCESS_SECRET",
    "dev-access-secret-change-me-please-32chars",
  ),
  jwtRefreshSecret: required(
    "JWT_REFRESH_SECRET",
    "dev-refresh-secret-change-me-please-32chars",
  ),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  emailVerifyExpiresHours: Number(process.env.EMAIL_VERIFY_EXPIRES_HOURS || 24),
  passwordResetExpiresHours: Number(process.env.PASSWORD_RESET_EXPIRES_HOURS || 1),
  exposeDevTokens: String(process.env.EXPOSE_DEV_TOKENS || "true") === "true",
  /** Temporary static email OTP for local/dev verification (never send to client UI). */
  staticEmailOtp: String(process.env.STATIC_EMAIL_OTP || "123456"),

  /** Staging/production file upload service (S3 via appsstaging upload API). */
  uploadApiUrl:
    process.env.UPLOAD_API_URL || "https://client1.appsstaging.com:3019/upload",
  uploadApiToken: process.env.UPLOAD_API_TOKEN || "",
  uploadProjectName: process.env.UPLOAD_PROJECT_NAME || "RideRite",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
  /** When true (or no Stripe key in non-production), payments run in mock mode for Postman. */
  stripeMock:
    String(process.env.STRIPE_MOCK || "").toLowerCase() === "true" ||
    (!(process.env.STRIPE_SECRET_KEY || "") &&
      (process.env.NODE_ENV || "development") !== "production"),
};
