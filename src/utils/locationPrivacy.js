import crypto from "node:crypto";
import { env } from "../config/env.js";
import { createOpaqueToken, hashToken } from "./tokens.js";

/**
 * Driver location privacy (no anonymous access to where a driver is or who they are).
 *
 * Nearby-driver pins (signed-in riders only):
 *  - `pinId`: HMAC(viewer, UTC day, driver) — stable for that viewer all day so markers don't
 *    jump, but unlinkable across viewers / days and never a user or profile id.
 *  - `snapToGrid`: coordinates rounded to the centre of a NEARBY_GRID_METERS cell.
 *
 * Shared trip links: the rider (or driver) creates a random token; only its SHA-256 is stored
 * on the trip. A link works while the trip runs and for TRIP_SHARE_GRACE_MINUTES after it
 * ends, never longer than TRIP_SHARE_MAX_HOURS after it was created.
 */

const METERS_PER_DEG_LAT = 111320;

export function snapToGrid(lat, lng, meters = env.nearbyGridMeters) {
  const latStep = meters / METERS_PER_DEG_LAT;
  const cellLat = Math.floor(lat / latStep) * latStep + latStep / 2;
  // Longitude cells keep roughly the same ground width at this latitude
  const lngStep = meters / (METERS_PER_DEG_LAT * Math.max(0.1, Math.cos((cellLat * Math.PI) / 180)));
  const cellLng = Math.floor(lng / lngStep) * lngStep + lngStep / 2;
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return { lat: round(cellLat), lng: round(cellLng) };
}

export function pinId(viewerId, driverKey, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return crypto
    .createHmac("sha256", env.jwtAccessSecret)
    .update(`nearby:${day}:${viewerId}:${driverKey}`)
    .digest("hex")
    .slice(0, 16);
}

export const TRIP_ENDED = ["completed", "cancelled", "no_drivers"];
const MAX_SHARE_TOKENS = 5;

/** New share token for a trip (stored hashed; the newest MAX_SHARE_TOKENS stay valid). */
export function addShareToken(trip, now = new Date()) {
  const token = createOpaqueToken(24);
  const kept = (trip.shareTokens || []).slice(-(MAX_SHARE_TOKENS - 1));
  trip.shareTokens = [...kept, { hash: hashToken(token), createdAt: now }];
  return { token, expiresAt: shareExpiry(trip, now) };
}

function tripEndedAt(trip) {
  if (!TRIP_ENDED.includes(trip.status)) return null;
  return trip.completedAt || trip.cancelledAt || trip.updatedAt || new Date();
}

/** When a token created at `createdAt` stops working (given the trip's current state). */
export function shareExpiry(trip, createdAt) {
  const cap = new Date(new Date(createdAt).getTime() + env.tripShareMaxHours * 3600000);
  const ended = tripEndedAt(trip);
  if (!ended) return cap;
  const afterEnd = new Date(new Date(ended).getTime() + env.tripShareGraceMinutes * 60000);
  return afterEnd < cap ? afterEnd : cap;
}

/** "ok" | "invalid" | "expired" for a presented token. */
export function checkShareToken(trip, token, now = new Date()) {
  if (!token) return "invalid";
  const hash = hashToken(String(token));
  const entry = (trip.shareTokens || []).find((t) => t.hash === hash);
  if (!entry) return "invalid";
  return shareExpiry(trip, entry.createdAt) > now ? "ok" : "expired";
}
