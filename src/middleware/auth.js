import { User } from "../models/User.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "./errorHandler.js";

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw httpError(401, "Missing or invalid Authorization header");
  }

  const payload = verifyAccessToken(token);
  if (payload.typ !== "access") {
    throw httpError(401, "Invalid access token type");
  }

  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) {
    throw httpError(401, "User not found or inactive");
  }

  req.user = user;
  req.auth = payload;
  next();
});

export function requireRole(...roles) {
  return asyncHandler(async (req, _res, next) => {
    if (!req.user) throw httpError(401, "Unauthorized");
    if (!roles.includes(req.user.role)) {
      throw httpError(403, "Forbidden for this role");
    }
    next();
  });
}

/** Attach req.user when a valid Bearer token is present; otherwise continue anonymously. */
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return next();
  }

  try {
    const payload = verifyAccessToken(token);
    if (payload.typ !== "access") return next();
    const user = await User.findById(payload.sub);
    if (user?.isActive) {
      req.user = user;
      req.auth = payload;
    }
  } catch {
    // ignore invalid/expired access token — logout can still use refreshToken
  }
  next();
});
