/**
 * Connect account ids given to seeded QA drivers (src/scripts/seed-test-accounts.js).
 * They have no real Stripe account, so never look them up in Stripe.
 */
export const SEEDED_CONNECT_ACCOUNT_PREFIX = "acct_seedtest_";

/** Core license docs needed to submit KYC for admin review. */
function hasCoreLicenseDocs(profile) {
  return Boolean(
    profile?.licenseFrontUrl &&
      profile?.licenseBackUrl &&
      profile?.dlNumber,
  );
}

/**
 * Verification gate for ride actions.
 * Once admin approves KYC (`isApproved` / verificationStatus=approved),
 * treat docs as complete — do not re-block on every optional profile field.
 * Before approval, require license front/back + DL number (what onboarding collects).
 */
export function isDriverVerificationComplete(profile) {
  if (!profile) return false;
  if (profile.isApproved || profile.verificationStatus === "approved") {
    return true;
  }
  return hasCoreLicenseDocs(profile);
}

export function isStripeConnectReady(profile) {
  if (!profile) return false;
  return Boolean(
    profile.stripeConnectAccountId &&
      profile.stripeConnectDetailsSubmitted &&
      profile.stripeConnectPayoutsEnabled,
  );
}

/** Full gate for accepting / rejecting trips. */
export function canDriverHandleRides(profile, { subscriptionActive = false } = {}) {
  return (
    Boolean(profile?.isApproved) &&
    Boolean(subscriptionActive) &&
    isStripeConnectReady(profile) &&
    isDriverVerificationComplete(profile)
  );
}

export function driverReadinessPayload(profile, { subscriptionActive = false } = {}) {
  const verificationComplete = isDriverVerificationComplete(profile);
  const connectReady = isStripeConnectReady(profile);
  const canHandleRides = canDriverHandleRides(profile, { subscriptionActive });
  let blockReason = null;
  if (!profile?.isApproved) {
    blockReason = hasCoreLicenseDocs(profile)
      ? "Driver account pending admin approval"
      : "Upload your license and verification documents before accepting rides";
  } else if (!subscriptionActive) {
    blockReason = "Active driver subscription required ($100/mo or $32/wk) — finish it in Billing";
  } else if (!connectReady) {
    blockReason = "Complete Stripe Connect onboarding to receive payouts";
  } else if (!verificationComplete) {
    blockReason = "Upload your license and verification documents before accepting rides";
  }
  return {
    verificationComplete,
    connectReady,
    subscriptionActive: Boolean(subscriptionActive),
    canHandleRides,
    blockReason,
  };
}
