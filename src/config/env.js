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

  /**
   * Google + Apple sign-in through Firebase Authentication: the web app proves the identity with
   * Firebase and sends its ID token, verified here. Unset → the endpoint answers "not configured".
   */
  firebaseProjectId: String(process.env.FIREBASE_PROJECT_ID || "").trim(),
  /** Test-only override (NODE_ENV=test) so smoke tests can sign tokens with their own keys. */
  firebaseJwksUrl: testOnly(process.env.FIREBASE_JWKS_URL),

  /** Twilio (Verify for SMS OTP; Voice for masked calls). Unset → dev fallbacks. */
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID || "",
    /** Pool of Twilio numbers (E.164, comma-separated) that bridge rider ↔ driver calls. */
    proxyNumbers: list(process.env.TWILIO_PROXY_NUMBERS),
    /** SMS notifications (Programmable Messaging): a Messaging Service SID, else a From number. */
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || "",
    smsFrom: process.env.TWILIO_SMS_FROM || "",
  },
  /** SMS notifications per user per hour (on top of category / channel prefs). */
  smsNotifyMaxPerHour: Math.max(1, Number(process.env.SMS_NOTIFY_MAX_PER_HOUR) || 10),
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
  /**
   * Rider picked a specific chauffeur: that driver has this long (from payment) to accept,
   * and never later than CHAUFFEUR_DIRECT_CUTOFF_MINUTES before the start.
   */
  chauffeurDirectAcceptMinutes: Math.max(1, Number(process.env.CHAUFFEUR_DIRECT_ACCEPT_MINUTES) || 60),
  chauffeurDirectCutoffMinutes: nonNeg(process.env.CHAUFFEUR_DIRECT_CUTOFF_MINUTES, 30),
  /** Default for "if my driver can't take it, offer it to other drivers" (riders can change it). */
  chauffeurDirectAutoFallback: String(process.env.CHAUFFEUR_DIRECT_AUTO_FALLBACK || "").toLowerCase() === "true",

  /** Rental lifecycle: confirmed/active rentals are completed automatically this long after the return date. */
  rentalAutoCompleteHours: nonNeg(process.env.RENTAL_AUTO_COMPLETE_HOURS, 24),

  /**
   * Weekly automatic driver payouts (TRD 5.7). Off by default so a UAT stack never moves money
   * on its own; when on, one run per ISO week at PAYOUT_SCHEDULE_DAY / PAYOUT_SCHEDULE_HOUR_UTC
   * (a PayoutRun row makes it once even with several API instances). Drivers whose pending
   * balance is below PAYOUT_MIN_CENTS roll over to the next week.
   */
  autoPayouts: {
    enabled: String(process.env.AUTO_PAYOUTS_ENABLED || "").toLowerCase() === "true",
    day: weekday(process.env.PAYOUT_SCHEDULE_DAY, 1),
    hourUtc: Math.min(23, nonNeg(process.env.PAYOUT_SCHEDULE_HOUR_UTC, 14)),
    minCents: nonNeg(process.env.PAYOUT_MIN_CENTS, 100),
    sweepMinutes: Math.max(0.05, Number(process.env.PAYOUT_SWEEP_MINUTES) || 10),
  },

  /** Booking reminders: minutes before start (rentals + chauffeur), and the sweep interval. */
  reminderLeadMinutes: list(process.env.BOOKING_REMINDER_LEADS_MINUTES || "1440,60")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a),
  reminderSweepSeconds: Math.max(1, Number(process.env.REMINDER_SWEEP_SECONDS) || 60),

  /** Trip chat stays readable this long after the trip ends. */
  chatHistoryHours: nonNeg(process.env.CHAT_HISTORY_HOURS, 24),

  /** Driver document expiry: notify this many days before (each once), block once expired. */
  documentExpiryNoticeDays: list(process.env.DOCUMENT_EXPIRY_NOTICE_DAYS || "30,7,1")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => b - a),
  /** Driver housekeeping (document expiry, bonus months, maintenance due, membership notices). */
  // (capped below setInterval's 2^31 ms limit, ~24.8 days)
  driverSweepMinutes: Math.min(35000, Math.max(1, Number(process.env.DRIVER_SWEEP_MINUTES) || 24 * 60)),
  /** Membership that won't auto-renew: warn this many days before it ends. */
  subscriptionExpiryNoticeDays: nonNeg(process.env.SUBSCRIPTION_EXPIRY_NOTICE_DAYS, 3),

  /**
   * Monthly bonus (TRD 5.5). A trip is on time when the driver arrived within the pickup ETA
   * quoted at accept + the grace minutes. A month is eligible with at least BONUS_MIN_TRIPS
   * completed trips, an on-time rate ≥ BONUS_MIN_ONTIME_RATE and a safe-driving score ≥
   * BONUS_MIN_SAFE_SCORE; eligible months become a pending BONUS_AMOUNT_CENTS bonus for admin.
   */
  bonus: {
    onTimeGraceMinutes: nonNeg(process.env.BONUS_ONTIME_GRACE_MINUTES, 5),
    minTrips: Math.max(1, Number(process.env.BONUS_MIN_TRIPS) || 20),
    minOnTimeRate: rate01(process.env.BONUS_MIN_ONTIME_RATE, 0.9),
    minSafeScore: nonNeg(process.env.BONUS_MIN_SAFE_SCORE, 80),
    amountCents: Math.max(0, Number(process.env.BONUS_AMOUNT_CENTS) || 10000),
  },

  /** Company-covered maintenance (TRD 5.6): intervals and how early a due service can be requested. */
  maintenance: {
    oilChangeMonths: Math.max(1, Number(process.env.MAINTENANCE_OIL_CHANGE_MONTHS) || 3),
    inspectionMonths: Math.max(1, Number(process.env.MAINTENANCE_INSPECTION_MONTHS) || 12),
    requestWindowDays: nonNeg(process.env.MAINTENANCE_REQUEST_WINDOW_DAYS, 14),
  },

  /** P2P owners may decline a paid booking (full refund) within this many hours of it being made. */
  rentalOwnerDeclineHours: nonNeg(process.env.RENTAL_OWNER_DECLINE_HOURS, 12),
  /** An active listing whose daily price changes by more than this % goes back to admin review. */
  rentalPriceReviewPercent: nonNeg(process.env.RENTAL_PRICE_REVIEW_CHANGE_PERCENT, 50),

  /**
   * Driver location privacy. Nearby-driver pins are snapped to a grid of this many meters and
   * rate-limited per signed-in user; shared trip links stop working this long after the trip
   * ends (and at most TRIP_SHARE_MAX_HOURS after they were created).
   */
  nearbyGridMeters: Math.max(10, Number(process.env.NEARBY_GRID_METERS) || 120),
  nearbyRateLimitPerMinute: Math.max(1, Number(process.env.NEARBY_RATE_LIMIT_PER_MINUTE) || 30),
  tripShareGraceMinutes: nonNeg(process.env.TRIP_SHARE_GRACE_MINUTES, 60),
  tripShareMaxHours: Math.max(1, Number(process.env.TRIP_SHARE_MAX_HOURS) || 24),

  /**
   * Private driver documents (license, registration, insurance). All four S3_* set → private
   * S3 objects + presigned GET URLs; otherwise private local disk (PRIVATE_UPLOAD_DIR) served
   * only through short-lived signed links. Never the public upload service.
   */
  s3: {
    bucket: process.env.S3_BUCKET || "",
    region: process.env.S3_REGION || "",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    /** S3-compatible storage (MinIO, R2, Spaces…): endpoint URL, path-style addressing */
    endpoint: process.env.S3_ENDPOINT || "",
    documentsPrefix: (process.env.S3_DOCUMENTS_PREFIX || "driver-documents/").replace(/^\/+/, ""),
    signedUrlTtlSeconds: Math.min(3600, Math.max(30, Number(process.env.S3_SIGNED_URL_TTL_SECONDS) || 300)),
  },
  privateUploadDir: process.env.PRIVATE_UPLOAD_DIR || "",
  /** Max size of one driver document (MB). */
  documentMaxMb: Math.max(1, Number(process.env.DOCUMENT_MAX_MB) || 10),

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

/** "monday" / "mon" / "1" → 0..6 (Sunday = 0); unset or invalid → fallback. */
function weekday(raw, fallback) {
  // (declared inside: env above is built before module-level consts would be initialized)
  const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return fallback;
  if (/^[0-6]$/.test(s)) return Number(s);
  const i = WEEKDAYS.findIndex((d) => d === s || d.slice(0, 3) === s);
  return i >= 0 ? i : fallback;
}

function testOnly(raw) {
  return (process.env.NODE_ENV || "") === "test" && raw ? String(raw) : "";
}

function percent(raw, fallback) {
  const n = Number(raw);
  return raw !== "" && raw != null && Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

/** 0..1 inclusive (unset → fallback). */
function rate01(raw, fallback) {
  const n = Number(raw);
  return raw !== "" && raw != null && Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function rate(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n < 1 && raw !== "" && raw != null ? n : fallback;
}
