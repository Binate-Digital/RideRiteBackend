import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "./errorHandler.js";

export const requireVerified = asyncHandler(async (req, _res, next) => {
  // Email-verified, or a phone account verified by SMS OTP
  if (!req.user?.isEmailVerified && !req.user?.isPhoneVerified) {
    throw httpError(403, "Account not verified");
  }
  next();
});
