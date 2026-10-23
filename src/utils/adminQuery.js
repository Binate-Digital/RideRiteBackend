import mongoose from "mongoose";
import { User } from "../models/User.js";
import { httpError } from "../middleware/errorHandler.js";

/** Shared query helpers for the admin controllers. */

export function parsePaging(req, defaultLimit = 20) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export function paged({ page, limit }, total, key, rows) {
  return { ok: true, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), [key]: rows };
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ""));

export function requireObjectId(v, label = "id") {
  if (!isObjectId(v)) throw httpError(400, `Invalid ${label}`);
  return new mongoose.Types.ObjectId(String(v));
}

/** `from` / `to` query params (YYYY-MM-DD or ISO). `to` as a bare day includes that whole day. */
export function parseDateRange(req) {
  const parse = (raw, endOfDay) => {
    if (!raw) return null;
    const s = String(raw);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
    if (Number.isNaN(d.getTime())) throw httpError(400, `Invalid date: ${s}`);
    return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(d.getTime() + 86400000) : d;
  };
  return { from: parse(req.query.from, false), to: parse(req.query.to, true) };
}

export function dateFilter(field, { from, to }) {
  if (!from && !to) return {};
  return { [field]: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } };
}

/** Users matching a name / email / phone search → their ids (capped). */
export async function userIdsMatching(q, extra = {}) {
  const rx = new RegExp(escapeRegex(q), "i");
  const rows = await User.find({ ...extra, $or: [{ email: rx }, { fullName: rx }, { phone: rx }] })
    .select("_id")
    .limit(500)
    .lean();
  return rows.map((u) => u._id);
}

/** id → { id, fullName, email, phone } for a list of user ids. */
export async function usersById(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const users = await User.find({ _id: { $in: unique } }).select("fullName email phone role isActive").lean();
  return new Map(
    users.map((u) => [
      String(u._id),
      { id: String(u._id), fullName: u.fullName, email: u.email ?? null, phone: u.phone ?? null, role: u.role, isActive: u.isActive },
    ]),
  );
}

export const brief = (map, id) => (id ? map.get(String(id)) || { id: String(id), fullName: null, email: null } : null);
