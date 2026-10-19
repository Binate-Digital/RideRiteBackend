import Stripe from "stripe";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";

let stripeSingleton = null;

export function isStripeMock() {
  return env.stripeMock;
}

export function getStripe() {
  if (isStripeMock()) {
    throw httpError(
      503,
      "Stripe is in mock mode. Set STRIPE_SECRET_KEY and STRIPE_MOCK=false for live Stripe calls.",
    );
  }
  if (!env.stripeSecretKey) {
    throw httpError(503, "STRIPE_SECRET_KEY is not configured");
  }
  if (!stripeSingleton) {
    stripeSingleton = new Stripe(env.stripeSecretKey);
  }
  return stripeSingleton;
}

export async function ensureStripeCustomer(user) {
  const stripe = getStripe();
  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.fullName,
    metadata: { userId: user._id.toString(), app: "riderite" },
  });
  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}
