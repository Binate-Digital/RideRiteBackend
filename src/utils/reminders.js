import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { RentalListing } from "../models/RentalListing.js";
import { env } from "../config/env.js";
import { cancelUnassignedStartedBookings, expireDirectOffers } from "./chauffeurAssignment.js";
import { autoCompleteRentals } from "./rentalBooking.js";

/**
 * Booking reminders (TRD 4.9 / 4.11): riders, renters and assigned chauffeurs are reminded
 * BOOKING_REMINDER_LEADS_MINUTES before the start (default 24 h and 1 h).
 *
 * Each (audience, lead) is sent once: the booking's `remindersSent.<audience>_<lead>` flag is
 * claimed with a conditional update before notifying, so overlapping sweeps or several API
 * instances can't double-send. When several leads apply at once (a booking made 50 minutes
 * ahead), only the closest one is sent and the earlier ones are marked as passed.
 */

let timer = null;

function leadLabel(minutes) {
  if (minutes >= 1440 && minutes % 1440 === 0) return minutes === 1440 ? "24 hours" : `${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  if (minutes >= 1) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}`;
  return `${Math.round(minutes * 60)} seconds`;
}

const keyFor = (audience, lead) => `${audience}_${String(lead).replace(".", "_")}`;

/** Claim the closest due reminder for `audience`; returns its lead (minutes) or null. */
async function claimReminder(Model, doc, audience, startAt, now) {
  const minutesLeft = (startAt.getTime() - now.getTime()) / 60000;
  const due = env.reminderLeadMinutes.filter((lead) => minutesLeft <= lead);
  if (due.length === 0) return null;
  const target = Math.min(...due);
  const sent = doc.remindersSent || {};
  if (sent[keyFor(audience, target)]) return null;
  const $set = {};
  for (const lead of due) $set[`remindersSent.${keyFor(audience, lead)}`] = now;
  const claimed = await Model.findOneAndUpdate(
    { _id: doc._id, [`remindersSent.${keyFor(audience, target)}`]: { $exists: false } },
    { $set },
  );
  return claimed ? target : null;
}

async function notify(userId, payload) {
  const { notifyUser } = await import("../controllers/notifications.controller.js");
  return notifyUser(userId, payload);
}

const when = (d) =>
  new Date(d).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export async function sweepReminders(now = new Date()) {
  const maxLead = Math.max(0, ...env.reminderLeadMinutes);
  let sent = 0;
  if (maxLead > 0) {
    const horizon = new Date(now.getTime() + maxLead * 60000);

    const chauffeur = await ChauffeurBooking.find({
      status: { $in: ["confirmed", "driver_assigned"] },
      startAt: { $gt: now, $lte: horizon },
    }).limit(200);
    for (const b of chauffeur) {
      const riderLead = await claimReminder(ChauffeurBooking, b, "rider", b.startAt, now);
      if (riderLead) {
        sent += 1;
        await notify(b.riderId, {
          category: "chauffeur",
          title: `Private driver in ${leadLabel(riderLead)}`,
          body: `${when(b.startAt)} · ${b.durationHours}h from ${b.pickupAddress}${b.driverId ? "" : " — we're still finding your driver."}`,
          data: { chauffeurBookingId: b._id.toString(), href: "/chauffeur", reminder: riderLead },
          email: true,
          // Text the last reminder (1 h) only
          sms: riderLead <= 60,
        });
      }
      if (b.driverId) {
        const driverLead = await claimReminder(ChauffeurBooking, b, "driver", b.startAt, now);
        if (driverLead) {
          sent += 1;
          await notify(b.driverId, {
            category: "chauffeur",
            title: `Scheduled booking in ${leadLabel(driverLead)}`,
            body: `${when(b.startAt)} · ${b.durationHours}h · pick up at ${b.pickupAddress}`,
            data: { chauffeurBookingId: b._id.toString(), href: "/driver", reminder: driverLead },
            email: true,
            sms: driverLead <= 60,
          });
        }
      }
    }

    const rentals = await RentalBooking.find({
      status: "confirmed",
      startDate: { $gt: now, $lte: horizon },
    }).limit(200);
    for (const b of rentals) {
      const lead = await claimReminder(RentalBooking, b, "renter", b.startDate, now);
      if (!lead) continue;
      sent += 1;
      const listing = await RentalListing.findById(b.listingId).select("title city state");
      await notify(b.renterId, {
        category: "rental",
        title: `Rental pickup in ${leadLabel(lead)}`,
        body: `${listing?.title || "Your rental"} · ${[listing?.city, listing?.state].filter(Boolean).join(", ")} · pickup ${b.startDate.toISOString().slice(0, 10)}`,
        data: { rentalBookingId: b._id.toString(), href: "/rentals", reminder: lead },
        email: true,
      });
    }
  }
  // Paid private-driver bookings nobody accepted by their start time: cancel + full refund
  // A driver the rider picked didn't answer in time: rider picks again (or auto fallback)
  const directTimedOut = await expireDirectOffers(now);
  const autoCancelled = await cancelUnassignedStartedBookings(now);
  // Rentals RENTAL_AUTO_COMPLETE_HOURS past their return date: completed (owner earning payable)
  const rentalsCompleted = await autoCompleteRentals(now);
  return { sent, autoCancelled, directTimedOut, rentalsCompleted };
}

export function startReminderSweeper() {
  if (timer) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepReminders();
    } catch (err) {
      console.error("[reminders] sweep failed", err);
    } finally {
      running = false;
    }
  }, env.reminderSweepSeconds * 1000);
  timer.unref?.();
  console.log(
    `[reminders] leads ${env.reminderLeadMinutes.join(", ")} min before start, sweep every ${env.reminderSweepSeconds}s`,
  );
}
