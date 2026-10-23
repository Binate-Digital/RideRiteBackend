import mongoose from "mongoose";
import { Trip } from "../models/Trip.js";
import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";

/**
 * Public "who is picking you up" card for each driver: name, photo, vehicle,
 * plate and rating (average of riders' ratings on that driver's completed
 * trips). Phone numbers are never included — riders reach drivers through the
 * masked trip chat.
 *
 * Batched: one query per collection however many trips are listed.
 */
export async function driverCardsFor(driverIds) {
  const ids = [...new Set(driverIds.filter(Boolean).map(String))];
  const cards = new Map();
  if (ids.length === 0) return cards;

  const [users, profiles, ratings] = await Promise.all([
    User.find({ _id: { $in: ids } }).select("fullName avatarUrl").lean(),
    DriverProfile.find({ userId: { $in: ids } })
      .select("userId vehicleType vehicleMake vehicleModel vehicleColor vehiclePlate vehicleYear")
      .lean(),
    Trip.aggregate([
      {
        $match: {
          // aggregate() does not cast strings to ObjectIds the way find() does
          driverId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
          status: "completed",
          riderRating: { $ne: null },
        },
      },
      { $group: { _id: "$driverId", average: { $avg: "$riderRating" }, count: { $sum: 1 } } },
    ]),
  ]);

  const profileBy = new Map(profiles.map((p) => [String(p.userId), p]));
  const ratingBy = new Map(ratings.map((r) => [String(r._id), r]));
  for (const u of users) {
    const id = String(u._id);
    const p = profileBy.get(id);
    const r = ratingBy.get(id);
    cards.set(id, {
      id,
      name: u.fullName,
      avatarUrl: u.avatarUrl || null,
      vehicle: p
        ? {
            type: p.vehicleType,
            make: p.vehicleMake || "",
            model: p.vehicleModel || "",
            color: p.vehicleColor || "",
            plate: p.vehiclePlate || "",
            year: p.vehicleYear ?? null,
          }
        : null,
      rating: {
        average: r ? Math.round(r.average * 100) / 100 : null,
        count: r ? r.count : 0,
      },
    });
  }
  return cards;
}

/** `trip.toSafeJSON()` plus a `driver` card (null until a driver accepts). */
export async function tripsWithDrivers(trips) {
  const cards = await driverCardsFor(trips.map((t) => t.driverId));
  return trips.map((t) => ({
    ...t.toSafeJSON(),
    driver: t.driverId ? cards.get(String(t.driverId)) || null : null,
  }));
}

export async function tripWithDriver(trip) {
  const [json] = await tripsWithDrivers([trip]);
  return json;
}
