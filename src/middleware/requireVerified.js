import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "./errorHandler.js";

export const requireVerified = asyncHandler(async (req, _res, next) => {
  if (!req.user?.isEmailVerified) {
    throw httpError(403, "Email not verified");
  }
  next();
});
