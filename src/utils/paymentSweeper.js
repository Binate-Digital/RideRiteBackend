import { Trip } from "../models/Trip.js";
import { env } from "../config/env.js";
import { settleTripRefund } from "./refunds.js";
import { sweepExpiredRentalHolds } from "./rentalBooking.js";
import { sweepExpiredChauffeurHolds } from "./chauffeurBooking.js";
import { broadcastTrip } from "../realtime/index.js";
import { sweepBookingRefunds } from "./bookingRefunds.js";
import { RentalBooking } from "../models/RentalBooking.js";
import { ChauffeurBooking } from "../models/ChauffeurBooking.js";
import { reconcilePendingIntents, reconcileSubscriptions } from "./stripeReconcile.js";

let sweeper = null;

/**
 * Background money housekeeping:
 *  - release rental / chauffeur holds whose payment never completed (BOOKING_HOLD_SECONDS)
 *  - refund trips left `refund_pending` (Stripe error on cancel, or a no-drivers trip whose
 *    NO_DRIVERS_REFUND_DELAY_SECONDS re-request window has passed)
 *  - reconcile with Stripe what a webhook would have told us (utils/stripeReconcile.js)
 */
export async function sweepPayments(now = new Date()) {
  const released = (await sweepExpiredRentalHolds(now)) + (await sweepExpiredChauffeurHolds(now));

  const noDriversCutoff = new Date(now.getTime() - env.noDriversRefundDelaySeconds * 1000);
  const owed = await Trip.find({
    paymentStatus: "refund_pending",
    $or: [{ status: "cancelled" }, { status: "no_drivers", noDriversAt: { $lte: noDriversCutoff } }],
  })
    .select("_id")
    .limit(100)
    .lean();
  let refunded = 0;
  for (const t of owed) {
    const result = await settleTripRefund(t._id, { reason: "refund sweep" }).catch((err) => {
      console.error(`[payments] refund sweep ${t._id}:`, err.message);
      return null;
    });
    if (result?.trip) {
      refunded += 1;
      broadcastTrip(result.trip);
      console.log(`[payments] trip ${t._id} refund settled → ${result.trip.paymentStatus}`);
    }
  }
  // Cancelled rentals / chauffeur bookings whose refund hit a Stripe error
  refunded += (await sweepBookingRefunds(RentalBooking, "rental")) + (await sweepBookingRefunds(ChauffeurBooking, "chauffeur"));
  // Missed webhooks: pending card payments and lapsed-looking memberships re-read from Stripe
  const reconciled = (await reconcilePendingIntents(now)) + (await reconcileSubscriptions(now));
  return { released, refunded, reconciled };
}

export function startPaymentSweeper() {
  if (sweeper) return;
  let running = false;
  sweeper = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepPayments();
    } catch (err) {
      console.error("[payments] sweep failed", err);
    } finally {
      running = false;
    }
  }, env.paymentSweepSeconds * 1000);
  sweeper.unref?.();
  console.log(
    `[payments] booking holds ${env.bookingHoldSeconds}s, no-driver refund delay ${env.noDriversRefundDelaySeconds}s, sweep every ${env.paymentSweepSeconds}s`,
  );
}
