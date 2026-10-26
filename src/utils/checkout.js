import crypto from "node:crypto";
import { Payment } from "../models/Payment.js";
import { ensureStripeCustomer, getStripe, isStripeMock } from "../lib/stripe.js";

const OPEN_INTENT_STATUSES = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

/**
 * PaymentIntent (or mock intent) for a rental / chauffeur booking. Mirrors the ride flow:
 * the booking stays `pending_payment` until the webhook (or the client's sync / mock
 * confirm) reports success. Reuses the booking's open intent when there is one.
 *
 * Returns { mode, clientSecret, paymentIntentId, amountCents, currency, alreadySucceeded? }.
 */
export async function createCheckoutIntent({ user, purpose, refId, amountCents, description, existingIntentId }) {
  if (isStripeMock()) {
    if (existingIntentId?.startsWith("pi_mock_")) {
      return {
        mode: "mock",
        clientSecret: `${existingIntentId}_secret_mock`,
        paymentIntentId: existingIntentId,
        amountCents,
        currency: "usd",
      };
    }
    const mockPi = `pi_mock_${crypto.randomBytes(12).toString("hex")}`;
    await Payment.create({
      userId: user._id,
      purpose,
      refId,
      amountCents,
      status: "pending",
      provider: "mock",
      stripePaymentIntentId: mockPi,
      paymentMethodType: "card",
      metadata: { description },
    });
    return {
      mode: "mock",
      clientSecret: `${mockPi}_secret_mock`,
      paymentIntentId: mockPi,
      amountCents,
      currency: "usd",
    };
  }

  const stripe = getStripe();
  if (existingIntentId && !existingIntentId.startsWith("pi_mock_")) {
    try {
      const existing = await stripe.paymentIntents.retrieve(existingIntentId);
      if (OPEN_INTENT_STATUSES.has(existing.status) && existing.amount === amountCents) {
        return {
          mode: "stripe",
          clientSecret: existing.client_secret,
          paymentIntentId: existing.id,
          amountCents,
          currency: "usd",
        };
      }
      if (existing.status === "succeeded") {
        return { mode: "stripe", alreadySucceeded: true, paymentIntentId: existing.id, amountCents, currency: "usd" };
      }
    } catch {
      /* create a new one */
    }
  }

  const customerId = await ensureStripeCustomer(user);
  // One intent per (booking, attempt): a double-clicked "Pay" or a client retry gets the same
  // intent back from Stripe instead of a second charge-able one
  const attempt = await Payment.countDocuments({ purpose, refId, provider: "stripe" });
  const intent = await stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: "usd",
      customer: customerId,
      description,
      receipt_email: user.email || undefined,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: {
        app: "riderite",
        purpose,
        refId: String(refId),
        [purpose === "rental" ? "rentalBookingId" : "chauffeurBookingId"]: String(refId),
        userId: user._id.toString(),
      },
    },
    { idempotencyKey: `pi_${purpose}_${refId}_${attempt}` },
  );
  await Payment.findOneAndUpdate(
    { stripePaymentIntentId: intent.id },
    {
      $setOnInsert: {
        userId: user._id,
        purpose,
        refId,
        amountCents,
        status: "pending",
        provider: "stripe",
        stripePaymentIntentId: intent.id,
        paymentMethodType: "card",
        metadata: { description },
      },
    },
    { upsert: true, new: true },
  );
  return {
    mode: "stripe",
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    amountCents,
    currency: "usd",
  };
}

/** Mark the Payment row for an intent as succeeded (creating it if the intent was made elsewhere). */
export async function recordIntentSucceeded({ purpose, refId, userId, paymentIntentId, amountCents, provider }) {
  return Payment.findOneAndUpdate(
    { stripePaymentIntentId: paymentIntentId },
    {
      $set: { status: "succeeded", provider },
      $setOnInsert: {
        userId,
        purpose,
        refId,
        amountCents,
        stripePaymentIntentId: paymentIntentId,
        paymentMethodType: "card",
        metadata: {},
      },
    },
    { upsert: true, new: true },
  );
}

/**
 * Stop an unpaid intent from being paid after its booking / ride was abandoned or its hold
 * ended, and cancel it in Stripe so the dashboard shows it `canceled` (not left incomplete).
 * `cancellation_reason`: abandoned (rider cancelled / hold expired) | failed_invoice etc.
 */
export async function cancelOpenIntent(paymentIntentId, { reason = "abandoned" } = {}) {
  if (!paymentIntentId) return;
  await Payment.updateMany(
    { stripePaymentIntentId: paymentIntentId, status: "pending" },
    { $set: { status: "canceled" } },
  );
  if (isStripeMock() || paymentIntentId.startsWith("pi_mock_")) return;
  try {
    await getStripe().paymentIntents.cancel(paymentIntentId, { cancellation_reason: reason });
  } catch (err) {
    // Already succeeded / canceled — a late success is handled by the confirm path
    if (err?.code !== "payment_intent_unexpected_state") {
      console.warn(`[stripe] cancel ${paymentIntentId} failed: ${err.message}`);
    }
  }
}

/** Client confirm path: pull the intent from Stripe. Returns its status. */
export async function retrieveIntentStatus(paymentIntentId) {
  if (!paymentIntentId || paymentIntentId.startsWith("pi_mock_")) return null;
  const pi = await getStripe().paymentIntents.retrieve(paymentIntentId);
  return pi.status;
}
