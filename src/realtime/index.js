import { Server } from "socket.io";
import { corsOrigin } from "../config/cors.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { User } from "../models/User.js";
import { Trip } from "../models/Trip.js";

/**
 * Socket.IO layer: pushes live updates instead of clients polling.
 *
 * Rooms
 *   user:<userId>   every socket of that user (notifications, their trips)
 *   drivers         all connected drivers (a request was taken / closed)
 *   trip:<tripId>   rider + driver of a trip (driver location, status, chat)
 *
 * Client → server
 *   trip:join  (tripId, ack)   join a trip room; only that trip's rider/driver/admin
 *   trip:leave (tripId)
 *
 * Server → client
 *   notification:new  { notification }
 *   trip:update       { trip }                      status / fare / cancel changes
 *   driver:location   { tripId, lat, lng, updatedAt }
 *   chat:message      { tripId, message }
 *   ride:offer        { trip, offerExpiresAt, offerSeconds, serverNow }
 *                     a request offered exclusively to this driver (dispatch)
 *   ride:closed       { tripId, reason? }           offer gone (taken, cancelled,
 *                                                    declined, timed out)
 *   chauffeur:open    { bookingId, vehicleType, startAt }   (drivers) a scheduled
 *                                                    private-driver booking was paid
 *   chauffeur:closed  { bookingId }                  (drivers) taken or cancelled
 *   chauffeur:update  { booking }                    rider / assigned driver: status change
 */

let io = null;

const ACTIVE_FOR_LOCATION = ["accepted", "en_route", "arrived", "in_progress"];

export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
    // Client falls back to long-polling when a proxy blocks WebSocket upgrades
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("unauthorized"));
      const payload = verifyAccessToken(token);
      if (payload.typ !== "access") return next(new Error("unauthorized"));
      const user = await User.findById(payload.sub).select("role isActive").lean();
      if (!user || !user.isActive) return next(new Error("unauthorized"));
      socket.data.userId = String(user._id);
      socket.data.role = user.role;
      next();
    } catch {
      // Expired token: the client refreshes and reconnects
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { userId, role } = socket.data;
    socket.join(`user:${userId}`);
    if (role === "driver") socket.join("drivers");

    socket.on("trip:join", async (tripId, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        const trip = await Trip.findById(String(tripId)).select("riderId driverId").lean();
        if (!trip) return reply({ ok: false, error: "Trip not found" });
        const allowed =
          role === "admin" ||
          String(trip.riderId) === userId ||
          (trip.driverId && String(trip.driverId) === userId);
        if (!allowed) return reply({ ok: false, error: "Not your trip" });
        socket.join(`trip:${tripId}`);
        reply({ ok: true });
      } catch {
        reply({ ok: false, error: "Invalid trip" });
      }
    });

    socket.on("trip:leave", (tripId) => {
      socket.leave(`trip:${String(tripId)}`);
    });
  });

  console.log("[realtime] Socket.IO ready");
  return io;
}

function emit(room, event, payload) {
  if (!io) return;
  io.to(room).emit(event, payload);
}

export function emitToUser(userId, event, payload) {
  if (userId) emit(`user:${userId}`, event, payload);
}

/** Every connected driver (the client re-fetches and filters by its own eligibility). */
export function emitToDrivers(event, payload) {
  emit("drivers", event, payload);
}

/** Push a trip's latest state to its room and to the rider's / driver's own sockets. */
export function broadcastTrip(trip) {
  if (!io || !trip) return;
  const payload = { trip: typeof trip.toSafeJSON === "function" ? trip.toSafeJSON() : trip };
  const rooms = [`trip:${trip._id ?? trip.id}`, `user:${trip.riderId}`];
  if (trip.driverId) rooms.push(`user:${trip.driverId}`);
  io.to(rooms).emit("trip:update", payload);
}

/** Tell every driver a request is gone (accepted, cancelled) so any open offer closes. */
export function broadcastRideClosed(tripId) {
  emit("drivers", "ride:closed", { tripId: String(tripId) });
}

export function emitChatMessage(tripId, message) {
  emit(`trip:${tripId}`, "chat:message", { tripId: String(tripId), message });
}

/** Forward a driver's GPS ping to the rider of their current trip, if any. */
export async function relayDriverLocation(driverUserId, location) {
  if (!io) return;
  const trip = await Trip.findOne({
    driverId: driverUserId,
    status: { $in: ACTIVE_FOR_LOCATION },
  })
    .select("_id riderId")
    .lean();
  if (!trip) return;
  io.to([`trip:${trip._id}`, `user:${trip.riderId}`]).emit("driver:location", {
    tripId: String(trip._id),
    lat: location.lat,
    lng: location.lng,
    updatedAt: location.updatedAt,
  });
}
