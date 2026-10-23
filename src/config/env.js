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

  /** Social sign-in. Unset → that provider's endpoint answers "not configured". */
  googleClientIds: list(process.env.GOOGLE_CLIENT_ID),
  /** Apple Services ID (web) — comma-separate to also accept an app bundle id. */
  appleClientIds: list(process.env.APPLE_CLIENT_ID),
  /** Test-only overrides (NODE_ENV=test) so smoke tests can sign tokens with their own keys. */
  googleCertsUrl: testOnly(process.env.GOOGLE_CERTS_URL),
  appleJwksUrl: testOnly(process.env.APPLE_JWKS_URL) || "https://appleid.apple.com/auth/keys",

  /** Twilio (Verify for SMS OTP; Voice for masked calls). Unset → dev fallbacks. */
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID || "",
    /** Pool of Twilio numbers (E.164, comma-separated) that bridge rider ↔ driver calls. */
    proxyNumbers: list(process.env.TWILIO_PROXY_NUMBERS),
  },
  /** Dev SMS code used when Twilio Verify is not configured (logged to the console, never returned). */
  staticSmsOtp: String(process.env.STATIC_SMS_OTP || "123456"),
  /** SMS OTP limits: per phone number, on top of the per-IP route limiter. */
  smsOtpMaxPerHour: Math.max(1, Number(process.env.SMS_OTP_MAX_PER_HOUR) || 5),
  smsOtpResendSeconds: nonNeg(process.env.SMS_OTP_RESEND_SECONDS, 30),
  smsOtpTtlMinutes: Math.max(1, Number(process.env.SMS_OTP_TTL_MINUTES) || 10),

  /** Paid rental / chauffeur cancellation: full refund this many hours before start, else a partial one. */
  rentalFullRefundHours: nonNeg(process.env.RENTAL_FULL_REFUND_HOURS, 24),
  rentalLateRefundPercent: percent(process.env.RENTAL_LATE_CANCEL_REFUND_PERCENT, 50),
  chauffeurFullRefundHours: nonNeg(process.env.CHAUFFEUR_FULL_REFUND_HOURS, 24),
  chauffeurLateRefundPercent: percent(process.env.CHAUFFEUR_LATE_CANCEL_REFUND_PERCENT, 50),
  /** Platform share of a chauffeur booking; the assigned driver earns the rest on completion. */
  chauffeurCommissionRate: rate(process.env.CHAUFFEUR_COMMISSION_RATE, 0.2),
  /** How early (minutes before startAt) the assigned chauffeur may start the booking. */
  chauffeurStartEarlyMinutes: nonNeg(process.env.CHAUFFEUR_START_EARLY_MINUTES, 30),

  /** Booking reminders: minutes before start (rentals + chauffeur), and the sweep interval. */
  reminderLeadMinutes: list(process.env.BOOKING_REMINDER_LEADS_MINUTES || "1440,60")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a),
  reminderSweepSeconds: Math.max(1, Number(process.env.REMINDER_SWEEP_SECONDS) || 60),

  /** Trip chat stays readable this long after the trip ends. */
  chatHistoryHours: nonNeg(process.env.CHAT_HISTORY_HOURS, 24),

  /** Web push (VAPID). Unset → push is disabled and the web app hides the toggle. */
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    subject: process.env.VAPID_SUBJECT || "",
  },
};

function list(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Non-negative number; unset or "" → fallback (so "0" can switch a delay off). */
function nonNeg(raw, fallback) {
  const n = Number(raw);
  return raw !== "" && raw != null && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function testOnly(raw) {
  return (process.env.NODE_ENV || "") === "test" && raw ? String(raw) : "";
}

function percent(raw, fallback) {
  const n = Number(raw);
  return raw !== "" && raw != null && Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

function rate(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n < 1 && raw !== "" && raw != null ? n : fallback;
}
