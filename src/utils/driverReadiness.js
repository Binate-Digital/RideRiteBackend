/** Minimum docs/fields required before a driver can accept/reject rides. */
export function isDriverVerificationComplete(profile) {
  if (!profile) return false;
  return Boolean(
    profile.licenseFrontUrl &&
      profile.licenseBackUrl &&
      profile.dlNumber &&
      profile.dlState &&
      profile.dlExpiresOn &&
      profile.dateOfBirth &&
      profile.addressLine1 &&
      profile.city &&
      profile.state &&
      profile.zip &&
      profile.vehicleMake &&
      profile.vehicleModel &&
      profile.vehicleYear &&
      profile.vehiclePlate &&
      profile.vehicleVin &&
      profile.insuranceCarrier &&
      profile.insurancePolicyNumber &&
      profile.insuranceExpiresOn,
  );
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
  if (!profile?.isApproved) blockReason = "Driver account pending admin approval";
  else if (!subscriptionActive) {
    blockReason = "Active driver subscription required ($100/mo or $32/wk)";
  } else if (!connectReady) {
    blockReason = "Complete Stripe Connect onboarding to receive payouts";
  } else if (!verificationComplete) {
    blockReason = "Upload driver license and verification documents to accept rides";
  }
  return {
    verificationComplete,
    connectReady,
    subscriptionActive: Boolean(subscriptionActive),
    canHandleRides,
    blockReason,
  };
}
