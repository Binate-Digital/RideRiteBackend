import { DriverBonus } from "../models/DriverBonus.js";
import { Trip } from "../models/Trip.js";
import { asyncHandler } from "../utils/asyncHandler.js";

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** GET /api/driver/bonus/me — current month eligibility */
export const getMine = asyncHandler(async (req, res) => {
  const key = monthKey();
  let bonus = await DriverBonus.findOne({ userId: req.user._id, monthKey: key });
  if (!bonus) {
    const start = new Date(`${key}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const trips = await Trip.find({
      driverId: req.user._id,
      status: "completed",
      completedAt: { $gte: start, $lt: end },
    });
    const tripsCompleted = trips.length;
    // Proxy on-time: trips where arrivedAt exists before startedAt or completed
    let onTime = 0;
    for (const t of trips) {
      if (t.arrivedAt && t.acceptedAt) {
        const mins = (new Date(t.arrivedAt) - new Date(t.acceptedAt)) / 60000;
        if (mins <= 20) onTime += 1;
      } else onTime += 1;
    }
    const onTimeRate = tripsCompleted ? onTime / tripsCompleted : 0;
    const eligible = tripsCompleted >= 20 && onTimeRate >= 0.9;
    bonus = await DriverBonus.create({
      userId: req.user._id,
      monthKey: key,
      onTimeRate,
      tripsCompleted,
      safeDrivingScore: 100,
      eligible,
      giftCardCents: 10000,
      status: eligible ? "pending_review" : "rejected",
      adminNotes: eligible ? "" : "Not enough trips / on-time rate",
    });
  }
  res.json({ ok: true, bonus: bonus.toSafeJSON() });
});
