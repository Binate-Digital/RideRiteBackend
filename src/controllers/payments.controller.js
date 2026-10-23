import crypto from "node:crypto";
import { Trip } from "../models/Trip.js";
import { Payment } from "../models/Payment.js";
import { User } from "../models/User.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { ensureStripeCustomer, getStripe, isStripeMock } from "../lib/stripe.js";
import { broadcastTrip } from "../realtime/index.js";
import { startDispatch } from "../utils/dispatch.js";
import { StripeEvent } from "../models/StripeEvent.js";
import { confirmRentalPaid, failRentalPayment } from "../utils/rentalBooking.js";
import { confirmChauffeurPaid, failChauffeurPayment } from "../utils/chauffeurBooking.js";
import {
  applyStripeSubscription,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionDeleted,
} from "../utils/subscriptionBilling.js";

const OFFLINE = new Set(["cash", "venmo", "zelle"]);

async function loadRiderTrip(tripId, userId) {
  const trip = await Trip.findById(tripId).select("+stripeClientSecret");
  if (!trip) throw httpError(404, "Trip not found");
  if (trip.riderId.toString() !== userId.toString()) {
    throw httpError(403, "Not your trip");
  }
  return trip;
}

async function markTripPaid(trip, { provider, paymentIntentId, paymentMethodType }) {
  trip.paid = true;
  trip.paidAt = new Date();
  trip.paymentStatus = "paid";
  if (paymentIntentId) trip.stripePaymentIntentId = paymentIntentId;
  // Release to driver dispatch only after escrow/payment succeeds
  if (trip.status === "pending_payment") {
    trip.status = "requested";
    trip.requestedAt = trip.requestedAt || new Date();
  }
  await trip.save();
  broadcastTrip(trip);

  await Payment.findOneAndUpdate(
    {
      tripId: trip._id,
      purpose: "ride",
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    },
    {
      $set: {
        userId: trip.riderId,
        tripId: trip._id,
        purpose: "ride",
        amountCents: trip.fareCents,
        currency: "usd",
        status: "succeeded",
        provider,
        stripePaymentIntentId: paymentIntentId || null,
        paymentMethodType: paymentMethodType || trip.paymentMethod,
      },
      $setOnInsert: { metadata: {} },
    },
    { upsert: true, new: true },
  );

  // Offer the ride to the nearest driver (no-op if dispatch already started)
  if (trip.status === "requested") await startDispatch(trip);

  return trip;
}

/** GET /api/payments/config — publishable key + mode for frontend */
export const getConfig = asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    mode: isStripeMock() ? "mock" : "stripe",
    publishableKey: env.stripePublishableKey || null,
  });
});

/**
 * POST /api/payments/rides/:tripId/intent
 * Create PaymentIntent (or mock intent) for a booked ride.
 */
export const createRidePaymentIntent = asyncHandler(async (req, res) => {
  const trip = await loadRiderTrip(req.params.tripId, req.user._id);

  if (trip.status === "cancelled") throw httpError(400, "Trip is cancelled");
  if (trip.paid || trip.paymentStatus === "paid") {
    return res.json({
      ok: true,
      alreadyPaid: true,
      trip: trip.toSafeJSON(),
    });
  }
  if (OFFLINE.has(trip.paymentMethod)) {
    throw httpError(
      400,
      `Trip payment method is "${trip.paymentMethod}" (pay on pickup). No card intent needed.`,
    );
  }

  // ---- Mock mode ----
  if (isStripeMock()) {
    const mockPi = `pi_mock_${crypto.randomBytes(12).toString("hex")}`;
    const mockSecret = `${mockPi}_secret_mock`;
    trip.stripePaymentIntentId = mockPi;
    trip.stripeClientSecret = mockSecret;
    trip.paymentStatus = "pending";
    await trip.save();

    await Payment.create({
      userId: req.user._id,
      tripId: trip._id,
      purpose: "ride",
      amountCents: trip.fareCents,
      status: "pending",
      provider: "mock",
      stripePaymentIntentId: mockPi,
      paymentMethodType: trip.paymentMethod,
    });

    return res.status(201).json({
      ok: true,
      mode: "mock",
      clientSecret: mockSecret,
      paymentIntentId: mockPi,
      amountCents: trip.fareCents,
      currency: "usd",
      trip: trip.toSafeJSON(),
      hint: "Call POST /api/payments/rides/:tripId/confirm-mock to simulate success",
    });
  }

  // ---- Real Stripe ----
  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(req.user);

  // Reuse open PI if still pending
  if (trip.stripePaymentIntentId) {
    try {
      const existing = await stripe.paymentIntents.retrieve(trip.stripePaymentIntentId);
      if (
        existing.status === "requires_payment_method" ||
        existing.status === "requires_confirmation" ||
        existing.status === "requires_action"
      ) {
        return res.json({
          ok: true,
          mode: "stripe",
          clientSecret: existing.client_secret,
          paymentIntentId: existing.id,
          amountCents: trip.fareCents,
          currency: "usd",
          trip: trip.toSafeJSON(),
        });
      }
      if (existing.status === "succeeded") {
        await markTripPaid(trip, {
          provider: "stripe",
          paymentIntentId: existing.id,
          paymentMethodType: trip.paymentMethod,
        });
        return res.json({ ok: true, alreadyPaid: true, trip: trip.toSafeJSON() });
      }
    } catch {
      /* create new */
    }
  }

  const createParams = {
    amount: trip.fareCents,
    currency: "usd",
    customer: customerId,
    metadata: {
      tripId: trip._id.toString(),
      userId: req.user._id.toString(),
      purpose: "ride",
    },
  };

  if (trip.paymentMethod === "cashapp") {
    createParams.payment_method_types = ["cashapp"];
  } else if (trip.paymentMethod === "paypal") {
    createParams.payment_method_types = ["paypal"];
  } else {
    createParams.automatic_payment_methods = {
      enabled: true,
      allow_redirects: "never",
    };
  }

  const finalIntent = await stripe.paymentIntents.create(createParams);

  trip.stripePaymentIntentId = finalIntent.id;
  trip.stripeClientSecret = finalIntent.client_secret;
  trip.paymentStatus = "pending";
  await trip.save();

  await Payment.create({
    userId: req.user._id,
    tripId: trip._id,
    purpose: "ride",
    amountCents: trip.fareCents,
    status: "pending",
    provider: "stripe",
    stripePaymentIntentId: finalIntent.id,
    paymentMethodType: trip.paymentMethod,
  });

  res.status(201).json({
    ok: true,
    mode: "stripe",
    clientSecret: finalIntent.client_secret,
    paymentIntentId: finalIntent.id,
    amountCents: trip.fareCents,
    currency: "usd",
    trip: trip.toSafeJSON(),
  });
});

/** POST /api/payments/rides/:tripId/confirm-mock — simulate successful card payment */
export const confirmMockPayment = asyncHandler(async (req, res) => {
  if (!isStripeMock() && !env.isDev) {
    throw httpError(403, "Mock confirm only available in mock/dev mode");
  }
  const trip = await loadRiderTrip(req.params.tripId, req.user._id);
  if (OFFLINE.has(trip.paymentMethod)) {
    throw httpError(400, "Offline payment method — no card confirm");
  }
  if (trip.paid) {
    return res.json({ ok: true, alreadyPaid: true, trip: trip.toSafeJSON() });
  }

  await markTripPaid(trip, {
    provider: "mock",
    paymentIntentId: trip.stripePaymentIntentId || `pi_mock_${trip._id}`,
    paymentMethodType: "card",
  });

  res.json({
    ok: true,
    message: "Mock payment succeeded",
    trip: trip.toSafeJSON(),
  });
});

/**
 * POST /api/payments/rides/:tripId/sync
 * Pull PaymentIntent status from Stripe and mark paid if succeeded.
 */
export const syncRidePayment = asyncHandler(async (req, res) => {
  const trip = await loadRiderTrip(req.params.tripId, req.user._id);
  if (trip.paid) return res.json({ ok: true, alreadyPaid: true, trip: trip.toSafeJSON() });

  if (isStripeMock()) {
    throw httpError(400, "Use confirm-mock in mock mode");
  }
  if (!trip.stripePaymentIntentId) {
    throw httpError(400, "No payment intent on this trip");
  }

  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(trip.stripePaymentIntentId);
  if (pi.status === "succeeded") {
    await markTripPaid(trip, {
      provider: "stripe",
      paymentIntentId: pi.id,
      paymentMethodType: trip.paymentMethod,
    });
    return res.json({ ok: true, message: "Payment confirmed", trip: trip.toSafeJSON() });
  }

  res.json({
    ok: true,
    paymentIntentStatus: pi.status,
    trip: trip.toSafeJSON(),
  });
});

/** POST /api/payments/methods/setup — SetupIntent to save a card */
export const createSetupIntent = asyncHandler(async (req, res) => {
  if (isStripeMock()) {
    const id = `seti_mock_${crypto.randomBytes(8).toString("hex")}`;
    return res.status(201).json({
      ok: true,
      mode: "mock",
      setupIntentId: id,
      clientSecret: `${id}_secret_mock`,
      hint: "In mock mode, call POST /api/payments/methods/mock-attach to fake a saved card",
    });
  }

  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(req.user);
  const setup = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
    metadata: { userId: req.user._id.toString() },
  });

  res.status(201).json({
    ok: true,
    mode: "stripe",
    setupIntentId: setup.id,
    clientSecret: setup.client_secret,
  });
});

/** GET /api/payments/methods — list saved cards */
export const listPaymentMethods = asyncHandler(async (req, res) => {
  if (isStripeMock()) {
    const mockCards = req.user.defaultPaymentMethodId
      ? [
          {
            id: req.user.defaultPaymentMethodId,
            brand: "visa",
            last4: "4242",
            expMonth: 12,
            expYear: 2030,
            isDefault: true,
          },
        ]
      : [];
    return res.json({ ok: true, mode: "mock", paymentMethods: mockCards });
  }

  if (!req.user.stripeCustomerId) {
    return res.json({ ok: true, mode: "stripe", paymentMethods: [] });
  }

  const stripe = getStripe();
  const list = await stripe.paymentMethods.list({
    customer: req.user.stripeCustomerId,
    type: "card",
  });

  const methods = list.data.map((pm) => ({
    id: pm.id,
    brand: pm.card?.brand,
    last4: pm.card?.last4,
    expMonth: pm.card?.exp_month,
    expYear: pm.card?.exp_year,
    isDefault: pm.id === req.user.defaultPaymentMethodId,
  }));

  res.json({ ok: true, mode: "stripe", paymentMethods: methods });
});

/** POST /api/payments/methods/mock-attach — fake save a card in mock mode */
export const mockAttachCard = asyncHandler(async (req, res) => {
  if (!isStripeMock() && !env.isDev) {
    throw httpError(403, "Mock attach only in mock/dev mode");
  }
  const pmId = `pm_mock_${crypto.randomBytes(6).toString("hex")}`;
  req.user.defaultPaymentMethodId = pmId;
  if (!req.user.stripeCustomerId) {
    req.user.stripeCustomerId = `cus_mock_${req.user._id.toString().slice(-8)}`;
  }
  await req.user.save();

  res.status(201).json({
    ok: true,
    mode: "mock",
    paymentMethod: {
      id: pmId,
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    },
  });
});

/** POST /api/payments/methods/:id/default */
export const setDefaultPaymentMethod = asyncHandler(async (req, res) => {
  const pmId = req.params.id;
  if (isStripeMock()) {
    req.user.defaultPaymentMethodId = pmId;
    await req.user.save();
    return res.json({ ok: true, defaultPaymentMethodId: pmId });
  }

  if (!req.user.stripeCustomerId) throw httpError(400, "No Stripe customer");
  const stripe = getStripe();
  await stripe.customers.update(req.user.stripeCustomerId, {
    invoice_settings: { default_payment_method: pmId },
  });
  req.user.defaultPaymentMethodId = pmId;
  await req.user.save();
  res.json({ ok: true, defaultPaymentMethodId: pmId });
});

/** DELETE /api/payments/methods/:id */
export const detachPaymentMethod = asyncHandler(async (req, res) => {
  const pmId = req.params.id;
  if (isStripeMock()) {
    if (req.user.defaultPaymentMethodId === pmId) {
      req.user.defaultPaymentMethodId = null;
      await req.user.save();
    }
    return res.json({ ok: true, detached: pmId });
  }

  const stripe = getStripe();
  await stripe.paymentMethods.detach(pmId);
  if (req.user.defaultPaymentMethodId === pmId) {
    req.user.defaultPaymentMethodId = null;
    await req.user.save();
  }
  res.json({ ok: true, detached: pmId });
});

/** GET /api/payments/mine — payment history */
export const listMyPayments = asyncHandler(async (req, res) => {
  const payments = await Payment.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50);
  res.json({ ok: true, payments: payments.map((p) => p.toSafeJSON()) });
});

/** Shape of the Stripe payment_intent we act on (purpose from our metadata). */
async function onIntentSucceeded(pi) {
  const purpose = pi.metadata?.purpose || (pi.metadata?.tripId ? "ride" : null);
  const method = pi.payment_method_types?.[0] || "card";
  if (purpose === "ride" && pi.metadata?.tripId) {
    const trip = await Trip.findById(pi.metadata.tripId);
    if (trip && !trip.paid) {
      await markTripPaid(trip, { provider: "stripe", paymentIntentId: pi.id, paymentMethodType: method });
    }
    return "ride";
  }
  if (purpose === "rental" && pi.metadata?.refId) {
    await confirmRentalPaid(pi.metadata.refId, { paymentIntentId: pi.id, provider: "stripe" });
    return "rental";
  }
  if (purpose === "chauffeur" && pi.metadata?.refId) {
    await confirmChauffeurPaid(pi.metadata.refId, { paymentIntentId: pi.id, provider: "stripe" });
    return "chauffeur";
  }
  // Subscription invoices' intents carry no purpose — invoice.paid handles them
  return null;
}

async function onIntentFailed(pi) {
  const purpose = pi.metadata?.purpose || (pi.metadata?.tripId ? "ride" : null);
  if (purpose === "ride" && pi.metadata?.tripId) {
    await Trip.updateOne({ _id: pi.metadata.tripId, paid: false }, { paymentStatus: "failed" });
    await Payment.findOneAndUpdate({ stripePaymentIntentId: pi.id }, { status: "failed" });
    return "ride";
  }
  if (purpose === "rental" && pi.metadata?.refId) {
    await failRentalPayment(pi.metadata.refId, pi.id);
    return "rental";
  }
  if (purpose === "chauffeur" && pi.metadata?.refId) {
    await failChauffeurPayment(pi.metadata.refId, pi.id);
    return "chauffeur";
  }
  return null;
}

/**
 * Apply one Stripe event. Idempotent: an event id is acted on once (Stripe retries
 * deliveries), and every handler is itself a conditional update, so replays are no-ops.
 * Exported so tests can feed constructed events.
 */
export async function handleStripeEvent(event) {
  if (!event?.id || !event.type) throw httpError(400, "Malformed event");
  if (await StripeEvent.exists({ eventId: event.id })) {
    return { duplicate: true, type: event.type };
  }
  const obj = event.data?.object || {};
  let handled = null;
  switch (event.type) {
    case "payment_intent.succeeded":
      handled = await onIntentSucceeded(obj);
      break;
    case "payment_intent.payment_failed":
      handled = await onIntentFailed(obj);
      break;
    case "invoice.paid":
    case "invoice.payment_succeeded":
      handled = (await handleInvoicePaid(obj)) ? "subscription" : null;
      break;
    case "invoice.payment_failed":
      handled = (await handleInvoicePaymentFailed(obj)) ? "subscription" : null;
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
      handled = (await applyStripeSubscription(obj)) ? "subscription" : null;
      break;
    case "customer.subscription.deleted":
      handled = (await handleSubscriptionDeleted(obj)) ? "subscription" : null;
      break;
    default:
      break;
  }
  await StripeEvent.create({ eventId: event.id, type: event.type }).catch((err) => {
    if (err?.code !== 11000) throw err;
  });
  return { duplicate: false, type: event.type, handled };
}

/**
 * Stripe webhook — mount with express.raw before json parser.
 * Mock mode in development accepts unsigned JSON events so the handlers can be exercised
 * locally (there is no Stripe to sign them); everywhere else the signature is required.
 */
export const stripeWebhook = asyncHandler(async (req, res) => {
  let event;
  if (isStripeMock()) {
    if (!env.isDev) return res.json({ ok: true, ignored: true, reason: "mock mode" });
    try {
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || ""));
    } catch {
      throw httpError(400, "Invalid JSON event");
    }
  } else {
    if (!env.stripeWebhookSecret) {
      throw httpError(503, "STRIPE_WEBHOOK_SECRET not configured");
    }
    const sig = req.headers["stripe-signature"];
    try {
      event = getStripe().webhooks.constructEvent(req.body, sig, env.stripeWebhookSecret);
    } catch (err) {
      throw httpError(400, `Webhook signature verification failed: ${err.message}`);
    }
  }

  const result = await handleStripeEvent(event);
  res.json({ ok: true, received: true, ...result });
});
