import { Trip } from "../models/Trip.js";
import { emitChatMessage } from "../realtime/index.js";
import { TripMessage } from "../models/TripMessage.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";

const ACTIVE = ["accepted", "en_route", "arrived", "in_progress"];

async function assertTripParty(req) {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  const uid = req.user._id.toString();
  const isParty =
    trip.riderId.toString() === uid ||
    (trip.driverId && trip.driverId.toString() === uid) ||
    req.user.role === "admin";
  if (!isParty) throw httpError(403, "Not authorized");
  return trip;
}

/** GET /api/rides/:id/messages */
export const listMessages = asyncHandler(async (req, res) => {
  const trip = await assertTripParty(req);
  const rows = await TripMessage.find({ tripId: trip._id }).sort({ createdAt: 1 }).limit(200);
  res.json({
    ok: true,
    maskedPhone: "845-RIDE", // stub proxy until Twilio provisioned
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
