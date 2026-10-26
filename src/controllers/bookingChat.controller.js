import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { TripMessage } from "../models/TripMessage.js";
import { User } from "../models/User.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { hasPermission } from "../utils/permissions.js";
import { startMaskedCall, telephonyConfigured, userPhoneE164 } from "../utils/telephony.js";
import { emitToAdmins, emitToUser } from "../realtime/index.js";
import { notifyUser } from "./notifications.controller.js";

/**
 * Masked chat + calls for active bookings (TRD 4.6 "available only for active bookings"),
 * the same privacy rules as trip chat: no phone numbers, calls bridged through the Twilio
 * pool when configured.
 *
 *  chauffeur  rider ↔ assigned driver. Open from assignment until the booking is completed
 *             (driver_assigned, in_progress); readable CHAT_HISTORY_HOURS after it ends.
 *  rental     peer-to-peer: renter ↔ owner, open while confirmed or active.
 *             Company fleet: renter ↔ RideRite support — any admin with rentals:manage
 *             answers from the admin rentals page. No calls for fleet rentals (support is
 *             reached through chat).
 */

const CHAT_OPEN = {
  chauffeur: ["driver_assigned", "in_progress"],
  rental: ["confirmed", "active"],
};
const ENDED = ["completed", "cancelled", "expired"];

function endedAt(kind, b) {
  return b.completedAt || b.cancelledAt || b.updatedAt;
}

/** Load the booking and work out who the caller is in it. */
async function loadParty(kind, req) {
  const Model = kind === "chauffeur" ? ChauffeurBooking : RentalBooking;
  const booking = await Model.findById(req.params.id);
  if (!booking) throw httpError(404, "Booking not found");
  const uid = String(req.user._id);
  let me = null;
  let other = null;
  let fleet = false;
  if (kind === "chauffeur") {
    if (!booking.driverId) {
      if (String(booking.riderId) === uid) {
        throw httpError(409, "Chat opens once a driver is assigned", { code: "CHAT_NOT_AVAILABLE" });
      }
      throw httpError(403, "Not authorized");
    }
    if (String(booking.riderId) === uid) [me, other] = ["rider", booking.driverId];
    else if (String(booking.driverId) === uid) [me, other] = ["driver", booking.riderId];
  } else {
    fleet = booking.source === "fleet";
    if (!booking.paid) throw httpError(409, "Chat opens once the rental is paid", { code: "CHAT_NOT_AVAILABLE" });
    if (String(booking.renterId) === uid) [me, other] = ["renter", fleet ? null : booking.ownerId];
    else if (!fleet && String(booking.ownerId) === uid) [me, other] = ["owner", booking.renterId];
    else if (fleet && req.user.role === "admin" && hasPermission(req.user, "rentals:manage")) {
      [me, other] = ["support", booking.renterId];
    }
  }
  if (!me) throw httpError(403, "Not authorized");
  return { booking, me, other, fleet };
}

function chatState(kind, booking, me, now = Date.now()) {
  const open = CHAT_OPEN[kind].includes(booking.status) && (kind !== "rental" || booking.paid);
  const readable =
    open ||
    me === "support" ||
    (ENDED.includes(booking.status) && now - new Date(endedAt(kind, booking)).getTime() <= env.chatHistoryHours * 3600000);
  return { open, readable };
}

const counterpartLabel = (kind, me, fleet) =>
  kind === "chauffeur"
    ? me === "rider"
      ? "your driver"
      : "your rider"
    : fleet
      ? me === "support"
        ? "the renter"
        : "RideRite support"
      : me === "renter"
        ? "the owner"
        : "the renter";

function listMessages(kind) {
  return asyncHandler(async (req, res) => {
    const { booking, me, fleet } = await loadParty(kind, req);
    const { open, readable } = chatState(kind, booking, me);
    if (!readable) {
      throw httpError(403, `Chat closes ${env.chatHistoryHours}h after the booking ends`, { code: "CHAT_CLOSED" });
    }
    const rows = await TripMessage.find({ bookingKind: kind, bookingId: booking._id }).sort({ createdAt: 1 }).limit(200);
    const callable = open && !fleet && telephonyConfigured();
    res.json({
      ok: true,
      chatOpen: open,
      counterpart: counterpartLabel(kind, me, fleet),
      calling: { configured: telephonyConfigured() && !fleet, available: callable },
      messages: rows.map((r) => r.toSafeJSON()),
    });
  });
}

function sendMessage(kind) {
  return asyncHandler(async (req, res) => {
    const { booking, me, other, fleet } = await loadParty(kind, req);
    if (!chatState(kind, booking, me).open) {
      throw httpError(400, "Chat is only available while the booking is active", { code: "CHAT_CLOSED" });
    }
    const body = String(req.body?.body || "").trim().slice(0, 1000);
    if (!body) throw httpError(400, "Message body required");
    const row = await TripMessage.create({
      bookingKind: kind,
      bookingId: booking._id,
      senderId: req.user._id,
      senderRole: me === "support" ? "support" : "party",
      body,
    });
    const payload = { kind, bookingId: booking._id.toString(), message: row.toSafeJSON() };
    emitToUser(String(req.user._id), "booking:message", payload);
    if (other) emitToUser(String(other), "booking:message", payload);
    if (fleet) emitToAdmins("booking:message", payload);

    if (other) {
      const from =
        me === "support" ? "RideRite support" : me === "driver" ? "your driver" : me === "rider" ? "your rider" : me === "owner" ? "the owner" : "your renter";
      const href = kind === "chauffeur" ? (me === "rider" ? "/driver" : "/chauffeur") : me === "owner" || me === "support" ? "/trips" : "/driver";
      await notifyUser(other, {
        category: kind === "chauffeur" ? "chauffeur" : "rental",
        title: `Message from ${from}`,
        body: body.length > 120 ? `${body.slice(0, 117)}…` : body,
        data: { [kind === "chauffeur" ? "chauffeurBookingId" : "rentalBookingId"]: booking._id.toString(), href, chat: true },
      }).catch(() => {});
    }
    res.status(201).json({ ok: true, message: row.toSafeJSON() });
  });
}

function callParty(kind) {
  return asyncHandler(async (req, res) => {
    const { booking, me, other, fleet } = await loadParty(kind, req);
    if (fleet) throw httpError(409, "Calls aren't available for RideRite fleet rentals — message support in chat", { code: "CALL_NOT_AVAILABLE" });
    if (!chatState(kind, booking, me).open) {
      throw httpError(409, "Calling is only available while the booking is active", { code: "BOOKING_NOT_ACTIVE" });
    }
    if (!telephonyConfigured()) {
      throw httpError(503, "Calling isn't configured yet — use in-app chat", { code: "TELEPHONY_NOT_CONFIGURED" });
    }
    const callee = await User.findById(other).select("phone phoneE164");
    const callerE164 = userPhoneE164(req.user);
    const calleeE164 = userPhoneE164(callee);
    if (!callerE164) throw httpError(400, "Add your phone number in your profile to place calls", { code: "CALLER_NO_PHONE" });
    if (!calleeE164) throw httpError(400, "They can't take calls right now — use chat", { code: "CALLEE_NO_PHONE" });
    const call = await startMaskedCall({
      // Stable pool number per booking (a missed call can be returned, see inboundVoice)
      tripId: `${kind}:${booking._id}`,
      callerE164,
      calleeE164,
      calleeLabel: counterpartLabel(kind, me, false).replace(/^your |^the /, ""),
    });
    res.json({ ok: true, message: "We're calling your phone now — answer to be connected.", callSid: call.callSid, proxyNumber: call.proxyNumber });
  });
}

export const chauffeurMessages = listMessages("chauffeur");
export const chauffeurSend = sendMessage("chauffeur");
export const chauffeurCall = callParty("chauffeur");
export const rentalMessages = listMessages("rental");
export const rentalSend = sendMessage("rental");
export const rentalCall = callParty("rental");

/**
 * Inbound call to a pool number with no active trip: connect the caller to the other party of
 * an active chauffeur booking or P2P rental on that number. Returns the E.164 to dial or null.
 */
export async function bookingCallTarget(callerIds, poolNumber, proxyNumberFor) {
  const [chauffeur, rentals] = await Promise.all([
    ChauffeurBooking.find({
      status: { $in: CHAT_OPEN.chauffeur },
      $or: [{ riderId: { $in: callerIds } }, { driverId: { $in: callerIds } }],
    })
      .sort({ updatedAt: -1 })
      .limit(5),
    RentalBooking.find({
      status: { $in: CHAT_OPEN.rental },
      paid: true,
      source: "peer",
      $or: [{ renterId: { $in: callerIds } }, { ownerId: { $in: callerIds } }],
    })
      .sort({ updatedAt: -1 })
      .limit(5),
  ]);
  const isCaller = (id) => callerIds.some((c) => String(c) === String(id));
  for (const b of chauffeur) {
    if (proxyNumberFor(`chauffeur:${b._id}`) !== poolNumber) continue;
    return { otherId: isCaller(b.riderId) ? b.driverId : b.riderId, label: isCaller(b.riderId) ? "driver" : "rider" };
  }
  for (const b of rentals) {
    if (proxyNumberFor(`rental:${b._id}`) !== poolNumber) continue;
    return { otherId: isCaller(b.renterId) ? b.ownerId : b.renterId, label: isCaller(b.renterId) ? "vehicle owner" : "renter" };
  }
  return null;
}
