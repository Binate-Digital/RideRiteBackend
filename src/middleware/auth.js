import { User } from "../models/User.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "./errorHandler.js";
import { hasPermission } from "../utils/permissions.js";

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

/**
 * Admin panel gate: role "admin". A legacy admin without an adminRole is super_admin — the
 * role is written back once so the admins list shows it (migration on read).
 */
export const requireAdmin = asyncHandler(async (req, _res, next) => {
  if (!req.user) throw httpError(401, "Unauthorized");
  if (req.user.role !== "admin") throw httpError(403, "Forbidden for this role");
  if (!req.user.adminRole) {
    req.user.adminRole = "super_admin";
    await User.updateOne({ _id: req.user._id, adminRole: null }, { $set: { adminRole: "super_admin" } });
  }
  next();
});

/** Every listed permission is required (see utils/permissions.js for the role → permission map). */
export function requirePermission(...permissions) {
  return (req, _res, next) => {
    const missing = permissions.filter((p) => !hasPermission(req.user, p));
    if (missing.length) {
      return next(httpError(403, `Your admin role can't do this (needs ${missing.join(", ")})`, { code: "FORBIDDEN_PERMISSION", missing }));
    }
    next();
  };
}
