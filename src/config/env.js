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
    "http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173,https://riderite-admin.deployment-uat.com"
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
  /** QA helpers (e.g. driver "Simulate drive") for every account, not only @riderite.test ones. */
  enableTestTools: String(process.env.ENABLE_TEST_TOOLS || "").toLowerCase() === "true",

  /** Ride dispatch: how long one driver has to accept before the next nearest is offered the trip. */
  dispatchOfferSeconds: Math.max(3, Number(process.env.DISPATCH_OFFER_SECONDS) || 30),
  /** Give up and tell the rider "no drivers" after this long without an acceptance. */
  dispatchMaxMinutes: Math.max(1, Number(process.env.DISPATCH_MAX_MINUTES) || 5),
  /** How often the sweeper advances expired offers (covers restarts / lost timers). */
  dispatchSweepSeconds: Math.max(1, Number(process.env.DISPATCH_SWEEP_SECONDS) || 5),
  /**
   * Card ride that found no driver: wait this long before refunding it (0 = refund the moment
   * dispatch gives up). While waiting, the rider may re-request and reuse the payment.
   */
  noDriversRefundDelaySeconds: Math.max(0, Number(process.env.NO_DRIVERS_REFUND_DELAY_SECONDS) || 0),

  /** Platform share of a ride's base fare (driver gets the rest). Service fee + tax stay with the platform. */
  platformCommissionRate: rate(process.env.PLATFORM_COMMISSION_RATE, 0.2),
  /** Platform share of a peer-to-peer rental subtotal. Fleet rentals are 100% platform revenue. */
  rentalCommissionRate: rate(process.env.RENTAL_COMMISSION_RATE, 0.15),
  /** How long an unpaid rental / chauffeur booking holds its slot before it is released. */
  bookingHoldSeconds: Math.max(1, Number(process.env.BOOKING_HOLD_SECONDS) || 15 * 60),
  /** How often the payments sweeper releases expired holds and retries pending refunds. */
  paymentSweepSeconds: Math.max(1, Number(process.env.PAYMENT_SWEEP_SECONDS) || 30),

  /** Private driver hourly rates by vehicle type (cents) and minimum notice before startAt. */
  chauffeurHourlyCents: {
    sedan: Number(process.env.CHAUFFEUR_HOURLY_SEDAN_CENTS) || 6500,
    suv: Number(process.env.CHAUFFEUR_HOURLY_SUV_CENTS) || 8500,
    truck: Number(process.env.CHAUFFEUR_HOURLY_TRUCK_CENTS) || 9500,
  },
  chauffeurMinLeadMinutes: Math.max(0, Number(process.env.CHAUFFEUR_MIN_LEAD_MINUTES ?? 60) || 0),

  /** Driver subscription Stripe Prices. Empty → looked up / created by lookup_key. */
  stripePriceMonthly: process.env.STRIPE_PRICE_DRIVER_MONTHLY || "",
  stripePriceWeekly: process.env.STRIPE_PRICE_DRIVER_WEEKLY || "",

  /** SMTP for receipts and account emails. Unset → emails are printed to the console. */
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "",
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
  },
};

function rate(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n < 1 && raw !== "" && raw != null ? n : fallback;
}
