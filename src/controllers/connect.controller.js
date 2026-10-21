import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { getStripe, isStripeMock } from "../lib/stripe.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { env } from "../config/env.js";

async function ensureDriverProfile(user) {
  let profile = await DriverProfile.findOne({ userId: user._id });
  if (!profile) {
    if (user.role !== "driver" && user.role !== "admin") {
      user.role = "driver";
      await user.save();
    }
    profile = await DriverProfile.create({
      userId: user._id,
      isApproved: false,
      verificationStatus: "incomplete",
    });
  }
  return profile;
}

async function syncConnectFlags(profile) {
  if (!profile.stripeConnectAccountId || isStripeMock()) return profile;
  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(profile.stripeConnectAccountId);
  profile.stripeConnectChargesEnabled = Boolean(account.charges_enabled);
  profile.stripeConnectPayoutsEnabled = Boolean(account.payouts_enabled);
  profile.stripeConnectDetailsSubmitted = Boolean(account.details_submitted);
  await profile.save();
  return profile;
}

async function createOnboardingLink(accountId) {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${env.webAppUrl}/driver/billing?connect=refresh`,
    return_url: `${env.webAppUrl}/driver/billing?connect=return`,
    type: "account_onboarding",
  });
  return link.url;
}

/** POST /api/payments/connect/account — create Express account + onboarding URL */
export const createConnectAccount = asyncHandler(async (req, res) => {
  if (isStripeMock()) {
    throw httpError(503, "Stripe Connect requires real Stripe keys (STRIPE_MOCK=false)");
  }

  const profile = await ensureDriverProfile(req.user);
  const stripe = getStripe();

  if (profile.stripeConnectAccountId) {
    await syncConnectFlags(profile);
    if (profile.stripeConnectDetailsSubmitted && profile.stripeConnectPayoutsEnabled) {
      return res.json({
        ok: true,
        accountId: profile.stripeConnectAccountId,
        onboardingUrl: null,
        alreadyOnboarded: true,
        driver: profile.toSafeJSON(),
      });
    }
    const onboardingUrl = await createOnboardingLink(profile.stripeConnectAccountId);
    return res.json({
      ok: true,
      accountId: profile.stripeConnectAccountId,
      onboardingUrl,
      alreadyOnboarded: false,
      driver: profile.toSafeJSON(),
    });
  }

  const account = await stripe.accounts.create({
    type: "express",
    country: "US",
    email: req.user.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_type: "individual",
    metadata: {
      userId: req.user._id.toString(),
      app: "riderite",
    },
  });

  profile.stripeConnectAccountId = account.id;
  await profile.save();

  const onboardingUrl = await createOnboardingLink(account.id);
  res.status(201).json({
    ok: true,
    accountId: account.id,
    onboardingUrl,
    alreadyOnboarded: false,
    driver: profile.toSafeJSON(),
  });
});

/** GET /api/payments/connect/status */
export const getConnectStatus = asyncHandler(async (req, res) => {
  const profile = await DriverProfile.findOne({ userId: req.user._id });
  if (!profile?.stripeConnectAccountId) {
    return res.json({
      ok: true,
      connected: false,
      accountId: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      onboardingUrl: null,
    });
  }

  if (!isStripeMock()) {
    await syncConnectFlags(profile);
  }

  let onboardingUrl = null;
  if (!profile.stripeConnectDetailsSubmitted || !profile.stripeConnectPayoutsEnabled) {
    if (!isStripeMock()) {
      onboardingUrl = await createOnboardingLink(profile.stripeConnectAccountId);
    }
  }

  res.json({
    ok: true,
    connected: Boolean(profile.stripeConnectAccountId),
    accountId: profile.stripeConnectAccountId,
    chargesEnabled: profile.stripeConnectChargesEnabled,
    payoutsEnabled: profile.stripeConnectPayoutsEnabled,
    detailsSubmitted: profile.stripeConnectDetailsSubmitted,
    onboardingUrl,
    driver: profile.toSafeJSON(),
  });
});

/** POST /api/payments/connect/onboarding-link */
export const refreshOnboardingLink = asyncHandler(async (req, res) => {
  if (isStripeMock()) {
    throw httpError(503, "Stripe Connect requires real Stripe keys");
  }
  const profile = await ensureDriverProfile(req.user);
  if (!profile.stripeConnectAccountId) {
    throw httpError(400, "No Connect account yet — call POST /api/payments/connect/account first");
  }
  const onboardingUrl = await createOnboardingLink(profile.stripeConnectAccountId);
  res.json({ ok: true, onboardingUrl });
});
