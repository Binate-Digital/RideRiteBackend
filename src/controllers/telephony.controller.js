import { Trip } from "../models/Trip.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { toE164 } from "../utils/phone.js";
import {
  bridgeTwiml,
  proxyNumberFor,
  sayTwiml,
  startMaskedCall,
  telephonyConfigured,
  userPhoneE164,
  validTwilioSignature,
} from "../utils/telephony.js";

/** Masked communication is limited to the active trip period (TRD 4.6). */
export const CALLABLE_TRIP_STATUSES = ["accepted", "en_route", "arrived", "in_progress"];

/**
 * POST /api/rides/:id/call — rider or driver asks to be connected to the other party.
 * Twilio rings the caller from a pool number and bridges them; real numbers stay hidden.
 */
export const callTripParty = asyncHandler(async (req, res) => {
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw httpError(404, "Trip not found");
  const uid = req.user._id.toString();
  const isRider = trip.riderId.toString() === uid;
  const isDriver = trip.driverId && trip.driverId.toString() === uid;
  if (!isRider && !isDriver) throw httpError(403, "Not authorized");
  if (!CALLABLE_TRIP_STATUSES.includes(trip.status)) {
    throw httpError(409, "Calling is only available during an active trip", { code: "TRIP_NOT_ACTIVE" });
  }
  if (!telephonyConfigured()) {
    throw httpError(503, "Calling isn't configured yet — use in-app chat", { code: "TELEPHONY_NOT_CONFIGURED" });
  }
  const other = await User.findById(isRider ? trip.driverId : trip.riderId).select("phone phoneE164");
  const callerE164 = userPhoneE164(req.user);
  const calleeE164 = userPhoneE164(other);
  if (!callerE164) {
    throw httpError(400, "Add your phone number in your profile to place calls", { code: "CALLER_NO_PHONE" });
  }
  if (!calleeE164) {
    throw httpError(400, `Your ${isRider ? "driver" : "rider"} can't take calls right now — use chat`, {
      code: "CALLEE_NO_PHONE",
    });
  }
  const call = await startMaskedCall({
    tripId: trip._id,
    callerE164,
    calleeE164,
    calleeLabel: isRider ? "driver" : "rider",
  });
  res.json({
    ok: true,
    message: "We're calling your phone now — answer to be connected.",
    callSid: call.callSid,
    proxyNumber: call.proxyNumber,
  });
});

/**
 * POST /api/telephony/voice — Twilio inbound voice webhook (configure it on every pool
 * number). Someone calling a pool number back is connected to the other party of their
 * active trip on that number; anyone else hears a short message.
 */
export const inboundVoice = asyncHandler(async (req, res) => {
  const base = (process.env.TWILIO_WEBHOOK_BASE_URL || env.appUrl).replace(/\/$/, "");
  const url = `${base}${req.originalUrl}`;
  if (!validTwilioSignature(url, req.body || {}, req.get("x-twilio-signature"))) {
    throw httpError(403, "Invalid Twilio signature");
  }
  res.type("text/xml");
  const from = toE164(req.body?.From || "");
  const pool = String(req.body?.To || "");
  const unreachable = () => res.send(sayTwiml(`Sorry, there is no active ${env.appName} trip to connect you to.`));
  if (!from || !telephonyConfigured()) return unreachable();

  const callers = await User.find({ $or: [{ phoneE164: from }, { phone: from.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3") }] })
    .select("_id")
    .lean();
  if (callers.length === 0) return unreachable();
  const ids = callers.map((u) => u._id);
  const trips = await Trip.find({
    status: { $in: CALLABLE_TRIP_STATUSES },
    $or: [{ riderId: { $in: ids } }, { driverId: { $in: ids } }],
  })
    .sort({ updatedAt: -1 })
    .limit(5);
  const trip = trips.find((t) => proxyNumberFor(t._id) === pool) || null;
  if (!trip) {
    // Returning a call about an active chauffeur booking / P2P rental (see bookingChat.controller)
    const { bookingCallTarget } = await import("./bookingChat.controller.js");
    const target = await bookingCallTarget(ids, pool, proxyNumberFor);
    if (!target) return unreachable();
    const callee = await User.findById(target.otherId).select("phone phoneE164");
    const dial = userPhoneE164(callee);
    if (!dial) return unreachable();
    return res.send(bridgeTwiml({ to: dial, proxyNumber: pool, say: `Connecting you to your ${target.label}.` }));
  }
  const callerIsRider = ids.some((id) => String(id) === String(trip.riderId));
  const other = await User.findById(callerIsRider ? trip.driverId : trip.riderId).select("phone phoneE164");
  const to = userPhoneE164(other);
  if (!to) return unreachable();
  res.send(bridgeTwiml({ to, proxyNumber: pool, say: `Connecting you to your ${callerIsRider ? "driver" : "rider"}.` }));
});
