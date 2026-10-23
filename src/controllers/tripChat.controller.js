import { Trip } from "../models/Trip.js";
import { emitChatMessage } from "../realtime/index.js";
import { TripMessage } from "../models/TripMessage.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { telephonyConfigured } from "../utils/telephony.js";
import { Dispute } from "../models/Dispute.js";
import { hasPermission } from "../utils/permissions.js";
import { audit } from "../utils/audit.js";

const ACTIVE = ["accepted", "en_route", "arrived", "in_progress"];
const ENDED = ["completed", "cancelled", "no_drivers"];

/** Chat stays readable during the trip and CHAT_HISTORY_HOURS after it ends (admins: always). */
function chatReadable(trip, user, now = Date.now()) {
  if (user.role === "admin" || !ENDED.includes(trip.status)) return true;
  const endedAt = trip.completedAt || trip.cancelledAt || trip.noDriversAt || trip.updatedAt;
  return now - new Date(endedAt).getTime() <= env.chatHistoryHours * 3600000;
}

async function assertTripParty(req) {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  const uid = req.user._id.toString();
  const isParty = trip.riderId.toString() === uid || (trip.driverId && trip.driverId.toString() === uid);
  if (isParty) return trip;
  // Admins read a transcript only to handle a dispute on the trip (TRD 6.4), audited
  if (req.user.role === "admin" && hasPermission(req.user, "trips:chat")) {
    if (!(await Dispute.exists({ tripId: trip._id }))) {
      throw httpError(403, "Chat transcripts are only available for trips with a reported problem", { code: "NO_DISPUTE" });
    }
    if (req.method === "GET") await audit(req, "trip.chat.view", "Trip", trip._id.toString());
    return trip;
  }
  throw httpError(403, "Not authorized");
}

/** GET /api/rides/:id/messages */
export const listMessages = asyncHandler(async (req, res) => {
  const trip = await assertTripParty(req);
  if (!chatReadable(trip, req.user)) {
    throw httpError(403, `Trip chat closes ${env.chatHistoryHours}h after the trip ends`, { code: "CHAT_CLOSED" });
  }
  const rows = await TripMessage.find({ tripId: trip._id }).sort({ createdAt: 1 }).limit(200);
  const active = ACTIVE.includes(trip.status);
  res.json({
    ok: true,
    // Masked calling (Twilio) — only during an active trip and only when configured
    calling: { configured: telephonyConfigured(), available: active && telephonyConfigured() },
    chatOpen: active,
    messages: rows.map((r) => r.toSafeJSON()),
  });
});

/** POST /api/rides/:id/messages */
export const sendMessage = asyncHandler(async (req, res) => {
  const trip = await assertTripParty(req);
  if (!ACTIVE.includes(trip.status)) {
    throw httpError(400, "Chat only available during active trip");
  }
  const body = String(req.body?.body || "").trim();
  if (!body) throw httpError(400, "Message body required");
  const row = await TripMessage.create({
    tripId: trip._id,
    senderId: req.user._id,
    body,
  });
  emitChatMessage(trip._id, row.toSafeJSON());

  try {
    const { notifyUser } = await import("./notifications.controller.js");
    const uid = req.user._id.toString();
    const recipientId =
      trip.riderId.toString() === uid ? trip.driverId : trip.riderId;
    if (recipientId) {
      const fromDriver = trip.driverId && trip.driverId.toString() === uid;
      await notifyUser(recipientId, {
        category: "ride",
        title: fromDriver ? "Message from your driver" : "Message from your rider",
        body: body.length > 120 ? `${body.slice(0, 117)}…` : body,
        data: {
          tripId: trip._id.toString(),
          href: fromDriver ? `/book?trip_id=${trip._id}` : "/driver",
          chat: true,
        },
      });
    }
  } catch {
    /* non-fatal */
  }

  res.status(201).json({ ok: true, message: row.toSafeJSON() });
});
