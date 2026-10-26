import mongoose from "mongoose";
import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { ChauffeurDriverSlot, CHAUFFEUR_SLOT_MINUTES } from "../models/ChauffeurDriverSlot.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { DriverSubscription } from "../models/DriverSubscription.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";
import { canDriverHandleRides } from "./driverReadiness.js";
import { driverCardsFor } from "./tripDrivers.js";
import { recordChauffeurEarning } from "./earnings.js";
import { cancellationRefund, money, settleBookingRefund } from "./bookingRefunds.js";
import { emitToDrivers, emitToUser } from "../realtime/index.js";
import { getSettings } from "./settings.js";
import { bookingDisplayStatus } from "./receipts.js";

/**
 * Private driver (chauffeur) assignment — TRD 4.9.
 *
 * While booking, the rider either picks one of the available drivers (assignmentMode
 * "direct") or lets RideRite choose ("auto").
 *  - auto: the paid booking is `confirmed` and shows up as a "Scheduled booking" in the hub
 *    of every eligible driver (online, approved, subscribed, Connect ready, documents valid)
 *    with the matching vehicle type. The first driver to accept wins.
 *  - direct: only the picked driver is offered it, until `directOfferExpiresAt`
 *    (CHAUFFEUR_DIRECT_ACCEPT_MINUTES after payment, never later than
 *    CHAUFFEUR_DIRECT_CUTOFF_MINUTES before the start). A decline or timeout tells the rider,
 *    who picks someone else or switches to auto (automatic when `autoFallback`).
 * A driver's time is held in ChauffeurDriverSlot blocks (unique per driver + block), so a
 * driver can never hold two overlapping bookings, however requests race.
 *   confirmed → driver_assigned → in_progress → completed   (cancelled by rider or system)
 * Completion credits the driver's ledger (CHAUFFEUR_COMMISSION_RATE kept by the platform).
 * Nobody accepted by the start time → cancelled with a full refund (sweeper).
 */

const ACTIVE_FOR_DRIVER = ["driver_assigned", "in_progress"];
const HOUR_MS = 3600000;
const SLOT_MS = CHAUFFEUR_SLOT_MINUTES * 60000;

async function notify(userId, payload) {
  const { notifyUser } = await import("../controllers/notifications.controller.js");
  return notifyUser(userId, payload);
}

const when = (d) =>
  new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const firstName = (fullName) => String(fullName || "").trim().split(/\s+/)[0] || "Driver";

/** [start, end) of a booking's time block. */
export function bookingWindow(b) {
  const start = new Date(b.startAt);
  return { start, end: new Date(start.getTime() + Number(b.durationHours) * HOUR_MS) };
}

/** Calendar blocks a window touches (a partial block counts as taken). */
export function slotsFor(start, end) {
  const first = Math.floor(new Date(start).getTime() / SLOT_MS);
  const last = Math.ceil(new Date(end).getTime() / SLOT_MS);
  const out = [];
  for (let s = first; s < last; s += 1) out.push(s);
  return out;
}

/**
 * Hold `driverId`'s calendar for the booking's window. All-or-nothing: on any clash this
 * booking's partial claims for that driver are removed and false is returned.
 */
export async function claimDriverSlots(driverId, booking) {
  const { start, end } = bookingWindow(booking);
  const slots = slotsFor(start, end);
  const held = await ChauffeurDriverSlot.countDocuments({ bookingId: booking._id, driverId });
  if (held === slots.length) return true;
  try {
    await ChauffeurDriverSlot.insertMany(
      slots.map((slot) => ({ driverId, slot, bookingId: booking._id })),
      { ordered: true },
    );
    return true;
  } catch (err) {
    await ChauffeurDriverSlot.deleteMany({ bookingId: booking._id, driverId });
    if (err?.code === 11000 || err?.writeErrors?.some?.((e) => e.code === 11000)) {
      // Our own earlier partial claim also lands here: retry once from a clean slate
      if (held > 0) return claimDriverSlots(driverId, booking);
      return false;
    }
    throw err;
  }
}

/** Free a booking's held driver time (all drivers, or just one). */
export function releaseDriverSlots(bookingId, driverId = null) {
  return ChauffeurDriverSlot.deleteMany({ bookingId, ...(driverId ? { driverId } : {}) });
}

/** Bookings that predate driver slots: an overlapping assigned booking also makes a driver busy. */
async function legacyBusyDriverIds(driverIds, start, end, excludeBookingId = null) {
  return ChauffeurBooking.distinct("driverId", {
    ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
    driverId: { $in: driverIds },
    status: { $in: ACTIVE_FOR_DRIVER },
    startAt: { $lt: end },
    $expr: { $gt: [{ $add: ["$startAt", { $multiply: ["$durationHours", HOUR_MS] }] }, start] },
  });
}

/** Public card a rider sees while choosing: first name, photo, vehicle (no plate), rating, jobs. */
function pickerCard(card, jobs) {
  return {
    id: card.id,
    firstName: firstName(card.name),
    avatarUrl: card.avatarUrl,
    vehicle: card.vehicle
      ? {
          type: card.vehicle.type,
          make: card.vehicle.make,
          model: card.vehicle.model,
          color: card.vehicle.color,
          year: card.vehicle.year,
        }
      : null,
    rating: card.rating,
    completedChauffeurJobs: jobs,
  };
}

async function completedJobsBy(driverIds) {
  if (!driverIds.length) return new Map();
  const rows = await ChauffeurBooking.aggregate([
    {
      $match: {
        driverId: { $in: driverIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
        status: "completed",
      },
    },
    { $group: { _id: "$driverId", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/**
 * Drivers a rider can pick for a vehicle type and time window: approved, membership active,
 * Stripe Connect ready, no expired documents, matching vehicle, and free for the whole window
 * (no held chauffeur time). They don't need to be online — it's a scheduled booking.
 * `onlyIds` narrows to given drivers (checking one pick), `excludeIds` drops some.
 */
export async function availableChauffeurDrivers({
  vehicleType,
  startAt,
  durationHours,
  excludeIds = [],
  onlyIds = null,
  ignoreBookingId = null,
  now = new Date(),
}) {
  const start = new Date(startAt);
  const end = new Date(start.getTime() + Number(durationHours) * HOUR_MS);
  const exclude = new Set(excludeIds.filter(Boolean).map(String));
  const profiles = await DriverProfile.find({
    vehicleType,
    isApproved: true,
    stripeConnectAccountId: { $ne: null },
    ...(onlyIds ? { userId: { $in: onlyIds.filter((id) => mongoose.isValidObjectId(String(id))) } } : {}),
  }).limit(500);
  const candidates = profiles.filter((p) => !exclude.has(String(p.userId)));
  if (!candidates.length) return [];
  const ids = candidates.map((p) => p.userId);
  const [subs, users] = await Promise.all([
    DriverSubscription.find({ userId: { $in: ids } }),
    User.find({ _id: { $in: ids }, isActive: { $ne: false } }).select("_id").lean(),
  ]);
  const activeSub = new Set(subs.filter((s) => s.isActiveNow()).map((s) => String(s.userId)));
  const activeUser = new Set(users.map((u) => String(u._id)));
  const eligible = candidates.filter(
    (p) =>
      activeUser.has(String(p.userId)) &&
      canDriverHandleRides(p, { subscriptionActive: activeSub.has(String(p.userId)), now }),
  );
  if (!eligible.length) return [];
  const eligibleIds = eligible.map((p) => p.userId);
  const [slotBusy, legacyBusy] = await Promise.all([
    ChauffeurDriverSlot.distinct("driverId", {
      driverId: { $in: eligibleIds },
      slot: { $in: slotsFor(start, end) },
      ...(ignoreBookingId ? { bookingId: { $ne: ignoreBookingId } } : {}),
    }),
    legacyBusyDriverIds(eligibleIds, start, end, ignoreBookingId),
  ]);
  const busy = new Set([...slotBusy, ...legacyBusy].map(String));
  const free = eligibleIds.filter((id) => !busy.has(String(id)));
  const [cards, jobs] = await Promise.all([driverCardsFor(free), completedJobsBy(free)]);
  return free
    .map((id) => cards.get(String(id)))
    .filter(Boolean)
    .map((c) => pickerCard(c, jobs.get(c.id) || 0))
    .sort(
      (a, b) =>
        (b.rating.average ?? 0) - (a.rating.average ?? 0) ||
        b.completedChauffeurJobs - a.completedChauffeurJobs ||
        a.firstName.localeCompare(b.firstName),
    );
}

/** Throws 409 DRIVER_UNAVAILABLE unless `driverId` can take this window right now. */
export async function assertPickable(booking, driverId, { excludeIds = [] } = {}) {
  if (!mongoose.isValidObjectId(String(driverId))) throw httpError(400, "Invalid driverId");
  if (String(driverId) === String(booking.riderId)) throw httpError(400, "You can't book yourself");
  const [hit] = await availableChauffeurDrivers({
    vehicleType: booking.vehicleType,
    startAt: booking.startAt,
    durationHours: booking.durationHours,
    onlyIds: [driverId],
    excludeIds,
    ignoreBookingId: booking._id,
  });
  if (!hit) {
    throw httpError(409, "That driver isn't available for this time any more — pick another one", {
      code: "DRIVER_UNAVAILABLE",
    });
  }
  return hit;
}

/** When the picked driver's chance to accept ends. */
export function directOfferDeadline(startAt, from = new Date()) {
  const byWindow = from.getTime() + env.chauffeurDirectAcceptMinutes * 60000;
  const cutoff = new Date(startAt).getTime() - env.chauffeurDirectCutoffMinutes * 60000;
  let deadline = Math.min(byWindow, cutoff);
  // Booked very close to the start: still give the driver a minute (never past the start)
  if (deadline < from.getTime() + 60000) deadline = Math.min(from.getTime() + 60000, new Date(startAt).getTime());
  return new Date(deadline);
}

/** Booking JSON for its rider, with the assigned (or requested) driver's public card. */
export async function chauffeurBookingsForRider(bookings, now = new Date()) {
  const cards = await driverCardsFor(bookings.flatMap((b) => [b.driverId, b.requestedDriverId]));
  return bookings.map((b) => {
    const requested = b.requestedDriverId ? cards.get(String(b.requestedDriverId)) : null;
    return {
      ...b.toSafeJSON(),
      displayStatus: bookingDisplayStatus(b),
      driver: b.driverId ? cards.get(String(b.driverId)) || null : null,
      // Waiting on the rider's pick: no plate until they accept
      requestedDriver: requested ? pickerCard(requested, null) : null,
      cancelQuote:
        b.paid && ["confirmed", "driver_assigned"].includes(b.status) && now < b.startAt
          ? chauffeurCancelQuote(b, now)
          : null,
    };
  });
}

/** Booking JSON for a driver: rider's first name only. */
export async function chauffeurBookingsForDriver(bookings) {
  const riders = await User.find({ _id: { $in: bookings.map((b) => b.riderId) } }).select("fullName").lean();
  const names = new Map(riders.map((u) => [String(u._id), firstName(u.fullName)]));
  return bookings.map((b) => ({
    ...b.toSafeJSON(),
    riderFirstName: names.get(String(b.riderId)) || "Rider",
    driverEarningCents: Math.round(b.totalCents * (1 - getSettings().commission.chauffeurRate)),
  }));
}

/** Push the booking's latest state to its rider and driver (live status on both screens). */
export async function broadcastChauffeur(booking) {
  const [riderJson] = await chauffeurBookingsForRider([booking]);
  emitToUser(String(booking.riderId), "chauffeur:update", { booking: riderJson });
  const driverIds = [booking.driverId, booking.requestedDriverId].filter(Boolean).map(String);
  if (driverIds.length) {
    const [driverJson] = await chauffeurBookingsForDriver([booking]);
    for (const id of new Set(driverIds)) emitToUser(id, "chauffeur:update", { booking: driverJson });
  }
}

/** Can this driver take scheduled bookings? The open pool also needs them online. */
export async function chauffeurEligibility(userId, { requireOnline = true } = {}) {
  const profile = await DriverProfile.findOne({ userId });
  if (!profile) return { eligible: false, reason: "Set up your driver profile first", profile: null };
  const { driverHasActiveSubscription } = await import("../controllers/subscriptions.controller.js");
  const subscriptionActive = await driverHasActiveSubscription(userId);
  if (!canDriverHandleRides(profile, { subscriptionActive })) {
    return { eligible: false, reason: "Finish approval, membership and payouts to take bookings", profile };
  }
  if (requireOnline && !profile.isOnline) {
    return { eligible: false, reason: "Go online to see scheduled bookings", profile, offline: true };
  }
  return { eligible: true, reason: null, profile };
}

/**
 * What a driver's hub shows: `requests` — bookings a rider picked them for (online or not),
 * and `bookings` — the open "let RideRite choose" pool for their vehicle type (online only).
 */
export async function openChauffeurBookingsFor(userId, now = new Date()) {
  const base = await chauffeurEligibility(userId, { requireOnline: false });
  if (!base.eligible) return { ...base, bookings: [], requests: [] };
  const requests = await ChauffeurBooking.find({
    status: "confirmed",
    driverId: null,
    requestedDriverId: userId,
    directOfferExpiresAt: { $gt: now },
  }).sort({ startAt: 1 });
  const vehicleType = base.profile.vehicleType;
  if (!base.profile.isOnline) {
    return { eligible: false, offline: true, reason: "Go online to see open scheduled bookings", vehicleType, bookings: [], requests };
  }
  const rows = await ChauffeurBooking.find({
    status: "confirmed",
    driverId: null,
    requestedDriverId: null,
    assignmentMode: { $ne: "direct" },
    vehicleType,
    riderId: { $ne: userId },
    "directDeclines.driverId": { $ne: userId },
    startAt: { $gt: now },
  })
    .sort({ startAt: 1 })
    .limit(50);
  return { eligible: true, reason: null, vehicleType, bookings: rows, requests };
}

/**
 * A driver accepts. Direct bookings: only the picked driver, before the offer expires (their
 * time is already held). Auto bookings: first eligible online driver wins; their time is
 * claimed first, so a driver can't win two overlapping bookings in parallel.
 */
export async function acceptChauffeurBooking(bookingId, driverUserId, now = new Date()) {
  const booking = await ChauffeurBooking.findById(bookingId);
  if (!booking) throw httpError(404, "Booking not found");
  const direct = Boolean(booking.requestedDriverId);
  if (direct && String(booking.requestedDriverId) !== String(driverUserId)) {
    throw httpError(403, "The rider requested another driver for this booking", { code: "NOT_OFFERED_TO_YOU" });
  }
  if (!direct && booking.assignmentMode === "direct") {
    throw httpError(409, "The rider is choosing another driver for this booking", { code: "NOT_OFFERED_TO_YOU" });
  }
  const elig = await chauffeurEligibility(driverUserId, { requireOnline: !direct });
  if (!elig.eligible) throw httpError(403, elig.reason, { code: "DRIVER_NOT_ELIGIBLE" });
  if (booking.vehicleType !== elig.profile.vehicleType) {
    throw httpError(403, `This booking needs a ${booking.vehicleType.toUpperCase()}`, { code: "VEHICLE_MISMATCH" });
  }
  if (booking.status !== "confirmed" || booking.driverId) {
    throw httpError(409, "Another driver already accepted this booking", { code: "ALREADY_TAKEN" });
  }
  if (direct && booking.directOfferExpiresAt && now >= booking.directOfferExpiresAt) {
    throw httpError(409, "This request expired", { code: "OFFER_EXPIRED" });
  }
  const { start, end } = bookingWindow(booking);
  const legacyClash = await legacyBusyDriverIds([driverUserId], start, end, booking._id);
  if (legacyClash.length) throw httpError(409, "You already have a booking during this time", { code: "DRIVER_BUSY" });
  if (!(await claimDriverSlots(driverUserId, booking))) {
    throw httpError(409, "You already have a booking during this time", { code: "DRIVER_BUSY" });
  }

  const assigned = await ChauffeurBooking.findOneAndUpdate(
    {
      _id: booking._id,
      status: "confirmed",
      driverId: null,
      startAt: { $gt: now },
      requestedDriverId: direct ? driverUserId : null,
    },
    {
      $set: {
        driverId: driverUserId,
        status: "driver_assigned",
        assignedAt: now,
        directOfferExpiresAt: null,
        needsDriverChoice: false,
      },
    },
    { new: true },
  );
  if (!assigned) {
    await releaseDriverSlots(booking._id, driverUserId);
    throw httpError(409, "Another driver already accepted this booking", { code: "ALREADY_TAKEN" });
  }

  emitToDrivers("chauffeur:closed", { bookingId: assigned._id.toString() });
  await broadcastChauffeur(assigned);
  const driver = await User.findById(driverUserId).select("fullName");
  await notify(assigned.riderId, {
    category: "chauffeur",
    title: direct ? "Your driver accepted" : "Private driver assigned",
    body: `${firstName(driver?.fullName)} will pick you up ${when(assigned.startAt)} at ${assigned.pickupAddress}.`,
    data: { chauffeurBookingId: assigned._id.toString(), href: "/chauffeur", status: "driver_assigned" },
    sms: true,
    email: true,
  });
  return assigned;
}

/**
 * The picked driver can't take it (declined, let it time out, or became unavailable).
 * Their time is released; the rider is told and either picks again or — with autoFallback —
 * the booking is opened to every eligible driver.
 */
export async function directOfferFailed(booking, reason, now = new Date()) {
  const driverId = booking.requestedDriverId;
  if (!driverId) return null;
  const fallback = Boolean(booking.autoFallback);
  const updated = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: "confirmed", driverId: null, requestedDriverId: driverId },
    {
      $set: {
        requestedDriverId: null,
        directOfferExpiresAt: null,
        needsDriverChoice: !fallback,
        ...(fallback ? { assignmentMode: "auto" } : {}),
      },
      $push: { directDeclines: { driverId, reason, at: now } },
    },
    { new: true },
  );
  if (!updated) return null;
  await releaseDriverSlots(updated._id, driverId);
  emitToUser(String(driverId), "chauffeur:closed", { bookingId: updated._id.toString() });
  if (fallback) {
    emitToDrivers("chauffeur:open", {
      bookingId: updated._id.toString(),
      vehicleType: updated.vehicleType,
      startAt: updated.startAt,
    });
  }
  await broadcastChauffeur(updated);
  const driver = await User.findById(driverId).select("fullName");
  const who = firstName(driver?.fullName);
  const why = reason === "declined" ? "can't take" : reason === "timeout" ? "didn't confirm" : "is no longer available for";
  await notify(updated.riderId, {
    category: "chauffeur",
    title: fallback ? "Finding you another driver" : "Choose another driver",
    body: fallback
      ? `${who} ${why} your ${when(updated.startAt)} booking, so we've offered it to other drivers.`
      : `${who} ${why} your ${when(updated.startAt)} booking. Pick another driver or let RideRite choose — you're fully refunded if nobody is assigned by the start.`,
    data: { chauffeurBookingId: updated._id.toString(), href: "/chauffeur", status: "needs_driver" },
    sms: true,
    email: true,
  });
  return updated;
}

/** The picked driver declines a request. */
export async function declineChauffeurRequest(bookingId, driverUserId, now = new Date()) {
  const booking = await ChauffeurBooking.findById(bookingId);
  if (!booking) throw httpError(404, "Booking not found");
  if (String(booking.requestedDriverId) !== String(driverUserId) || booking.driverId) {
    throw httpError(409, "This request is no longer waiting on you", { code: "NOT_OFFERED_TO_YOU" });
  }
  const done = await directOfferFailed(booking, "declined", now);
  if (!done) throw httpError(409, "The booking just changed — refresh and try again");
  return done;
}

/**
 * Rider (re)chooses for an unassigned paid booking: a specific available driver, or
 * `auto` (offer to every eligible driver). Allowed until a driver is assigned.
 */
export async function chooseChauffeurDriver(booking, { driverId = null, auto = false, autoFallback } = {}, now = new Date()) {
  if (!booking.paid || booking.status !== "confirmed" || booking.driverId) {
    throw httpError(409, "A driver can only be chosen for a paid booking that has no driver yet", { code: "NOT_CHOOSABLE" });
  }
  if (now >= booking.startAt) throw httpError(409, "This booking has already started", { code: "ALREADY_STARTED" });
  const previous = booking.requestedDriverId;

  if (auto) {
    const updated = await ChauffeurBooking.findOneAndUpdate(
      { _id: booking._id, status: "confirmed", driverId: null, requestedDriverId: previous ?? null },
      { $set: { assignmentMode: "auto", requestedDriverId: null, directOfferExpiresAt: null, needsDriverChoice: false } },
      { new: true },
    );
    if (!updated) throw httpError(409, "The booking just changed — refresh and try again");
    if (previous) {
      await releaseDriverSlots(updated._id, previous);
      emitToUser(String(previous), "chauffeur:closed", { bookingId: updated._id.toString() });
    }
    emitToDrivers("chauffeur:open", { bookingId: updated._id.toString(), vehicleType: updated.vehicleType, startAt: updated.startAt });
    await broadcastChauffeur(updated);
    return updated;
  }

  if (!driverId) throw httpError(400, "driverId or auto is required");
  if (previous && String(previous) === String(driverId)) return booking;
  const declined = (booking.directDeclines || []).map((d) => String(d.driverId));
  if (declined.includes(String(driverId))) {
    throw httpError(409, "That driver already passed on this booking — pick another one", { code: "DRIVER_DECLINED" });
  }
  await assertPickable(booking, driverId);
  if (!(await claimDriverSlots(driverId, booking))) {
    throw httpError(409, "That driver was just booked for this time — pick another one", { code: "DRIVER_UNAVAILABLE" });
  }
  const updated = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: "confirmed", driverId: null, requestedDriverId: previous ?? null },
    {
      $set: {
        assignmentMode: "direct",
        requestedDriverId: driverId,
        directOfferExpiresAt: directOfferDeadline(booking.startAt, now),
        needsDriverChoice: false,
        ...(typeof autoFallback === "boolean" ? { autoFallback } : {}),
      },
    },
    { new: true },
  );
  if (!updated) {
    await releaseDriverSlots(booking._id, driverId);
    throw httpError(409, "The booking just changed — refresh and try again");
  }
  if (previous) {
    await releaseDriverSlots(updated._id, previous);
    emitToUser(String(previous), "chauffeur:closed", { bookingId: updated._id.toString() });
  }
  // It may have been in the open pool (auto) until now
  emitToDrivers("chauffeur:closed", { bookingId: updated._id.toString() });
  await offerToRequestedDriver(updated);
  await broadcastChauffeur(updated);
  return updated;
}

/** Tell the picked driver they have a request waiting (in-app, push, SMS, email). */
export async function offerToRequestedDriver(booking) {
  if (!booking.requestedDriverId) return;
  emitToUser(String(booking.requestedDriverId), "chauffeur:request", {
    bookingId: booking._id.toString(),
    expiresAt: booking.directOfferExpiresAt,
  });
  await notify(booking.requestedDriverId, {
    category: "chauffeur",
    title: "A rider requested you",
    body: `Private driver booking ${when(booking.startAt)} · ${booking.durationHours}h at ${booking.pickupAddress}. Accept by ${when(booking.directOfferExpiresAt)}.`,
    data: { chauffeurBookingId: booking._id.toString(), href: "/driver", status: "requested" },
    sms: true,
    email: true,
  });
}

/** Sweeper: picked drivers who didn't answer in time. */
export async function expireDirectOffers(now = new Date()) {
  const stale = await ChauffeurBooking.find({
    status: "confirmed",
    driverId: null,
    requestedDriverId: { $ne: null },
    directOfferExpiresAt: { $lte: now },
  }).limit(100);
  let n = 0;
  for (const b of stale) {
    try {
      if (await directOfferFailed(b, "timeout", now)) n += 1;
    } catch (err) {
      console.error(`[chauffeur] direct offer timeout ${b._id}:`, err.message);
    }
  }
  return n;
}

async function loadDriverBooking(bookingId, driverUserId) {
  const booking = await ChauffeurBooking.findById(bookingId);
  if (!booking) throw httpError(404, "Booking not found");
  if (String(booking.driverId) !== String(driverUserId)) throw httpError(403, "Not your booking");
  return booking;
}

/** Assigned driver starts the time block (from CHAUFFEUR_START_EARLY_MINUTES before startAt). */
export async function startChauffeurBooking(bookingId, driverUserId, now = new Date()) {
  const booking = await loadDriverBooking(bookingId, driverUserId);
  const earliest = booking.startAt.getTime() - env.chauffeurStartEarlyMinutes * 60000;
  if (now.getTime() < earliest) {
    throw httpError(400, `You can start this booking from ${when(new Date(earliest))}`, { code: "TOO_EARLY" });
  }
  const started = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: "driver_assigned", driverId: driverUserId },
    { $set: { status: "in_progress", startedAt: now } },
    { new: true },
  );
  if (!started) throw httpError(409, `Can't start a booking that is ${booking.status.replace("_", " ")}`);
  await broadcastChauffeur(started);
  await notify(started.riderId, {
    category: "chauffeur",
    title: "Private driver booking started",
    body: `Your ${started.durationHours}h booking is under way.`,
    data: { chauffeurBookingId: started._id.toString(), href: "/chauffeur", status: "in_progress" },
  });
  return started;
}

/** Driver ends the booking → completed, driver earning recorded once. */
export async function completeChauffeurBooking(bookingId, driverUserId, now = new Date()) {
  const booking = await loadDriverBooking(bookingId, driverUserId);
  const done = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: "in_progress", driverId: driverUserId },
    { $set: { status: "completed", completedAt: now } },
    { new: true },
  );
  if (!done) throw httpError(409, `Can't complete a booking that is ${booking.status.replace("_", " ")}`);
  try {
    await recordChauffeurEarning(done);
  } catch (err) {
    console.error(`[earnings] chauffeur ${done._id} not recorded:`, err.message);
  }
  // Finished early: the rest of the block is free for other bookings
  await ChauffeurDriverSlot.deleteMany({
    bookingId: done._id,
    slot: { $gte: Math.ceil(now.getTime() / SLOT_MS) },
  });
  await broadcastChauffeur(done);
  await notify(done.riderId, {
    category: "chauffeur",
    title: "Private driver booking completed",
    body: "Thanks for riding with RideRite.",
    data: { chauffeurBookingId: done._id.toString(), href: "/chauffeur", status: "completed" },
  });
  return done;
}

export function chauffeurCancelQuote(booking, now = new Date()) {
  return cancellationRefund({
    paidCents: booking.totalCents,
    startsAt: booking.startAt,
    fullRefundHours: env.chauffeurFullRefundHours,
    lateRefundPercent: env.chauffeurLateRefundPercent,
    now,
  });
}

/**
 * Cancel a paid booking. by "rider": refund per policy (CHAUFFEUR_FULL_REFUND_HOURS /
 * CHAUFFEUR_LATE_CANCEL_REFUND_PERCENT), only before the start. by "system": nobody accepted
 * before the start time — full refund.
 */
export async function cancelPaidChauffeur(booking, { by = "rider", reason = null, now = new Date() } = {}) {
  if (!booking.paid || !["confirmed", "driver_assigned"].includes(booking.status)) {
    throw httpError(400, "Only an upcoming booking can be cancelled", { code: "NOT_CANCELLABLE" });
  }
  if (by === "rider" && now >= booking.startAt) {
    throw httpError(400, "This booking has already started and can't be cancelled", { code: "ALREADY_STARTED" });
  }
  const policy =
    by === "system"
      ? { percent: 100, refundCents: booking.totalCents }
      : chauffeurCancelQuote(booking, now);
  const cancelled = await ChauffeurBooking.findOneAndUpdate(
    { _id: booking._id, status: booking.status, driverId: booking.driverId ?? null },
    {
      $set: {
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: by,
        cancelReason: reason,
        refundCents: policy.refundCents,
        refundPercent: policy.percent,
        directOfferExpiresAt: null,
        needsDriverChoice: false,
      },
    },
    { new: true },
  );
  if (!cancelled) throw httpError(409, "The booking just changed — refresh and try again");
  await releaseDriverSlots(cancelled._id);
  const settled =
    policy.refundCents > 0 ? await settleBookingRefund(ChauffeurBooking, "chauffeur", cancelled._id) : null;
  const finalBooking = settled?.booking || (await ChauffeurBooking.findById(cancelled._id));

  emitToDrivers("chauffeur:closed", { bookingId: cancelled._id.toString() });
  await broadcastChauffeur(finalBooking);
  const refundLine =
    policy.refundCents > 0
      ? `${money(policy.refundCents)} (${policy.percent}%) is being refunded to your card.`
      : "No refund applies under the cancellation policy.";
  await notify(cancelled.riderId, {
    category: "chauffeur",
    title: by === "system" ? "No private driver available" : "Private driver booking cancelled",
    body:
      by === "system"
        ? `No driver accepted your ${when(cancelled.startAt)} booking, so it was cancelled. ${refundLine}`
        : `${when(cancelled.startAt)} · ${cancelled.durationHours}h. ${refundLine}`,
    data: { chauffeurBookingId: cancelled._id.toString(), href: "/chauffeur", status: "cancelled" },
    email: true,
  });
  const driverToTell = booking.driverId || booking.requestedDriverId;
  if (driverToTell) {
    await notify(driverToTell, {
      category: "chauffeur",
      title: booking.driverId ? "Scheduled booking cancelled" : "Booking request withdrawn",
      body: `The rider cancelled the ${when(cancelled.startAt)} booking at ${cancelled.pickupAddress}.`,
      data: { chauffeurBookingId: cancelled._id.toString(), href: "/driver", status: "cancelled" },
      sms: Boolean(booking.driverId),
      email: Boolean(booking.driverId),
    });
  }
  return { booking: finalBooking, policy };
}

/** Sweeper: paid bookings nobody accepted by their start time are cancelled and refunded. */
export async function cancelUnassignedStartedBookings(now = new Date()) {
  const stale = await ChauffeurBooking.find({ status: "confirmed", driverId: null, startAt: { $lte: now } }).limit(50);
  let n = 0;
  for (const b of stale) {
    try {
      await cancelPaidChauffeur(b, { by: "system", reason: "No driver accepted before the start time", now });
      n += 1;
    } catch (err) {
      if (err.statusCode !== 409) console.error(`[chauffeur] auto-cancel ${b._id}:`, err.message);
    }
  }
  return n;
}
