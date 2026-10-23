import { z } from "zod";
import { Settings } from "../models/Settings.js";
import { env } from "../config/env.js";

/**
 * Admin-editable platform settings (TRD 6.8 / 6.6): fares per tier, cancellation fee rule,
 * commission rates, chauffeur hourly rates, bonus thresholds and the dispatch offer window.
 *
 * Defaults come from env / code constants, so with no admin changes the platform behaves
 * exactly as before. The Settings document stores only what an admin changed (`overrides`);
 * getSettings() = defaults ⊕ overrides, served from memory. The cache is reloaded on every
 * admin update and every SETTINGS_REFRESH_SECONDS (other API instances pick changes up).
 */

const VEHICLES = ["sedan", "suv", "truck"];

/** Ride pricing defaults (mirror of the web app's DEFAULT_PRICING). */
export const DEFAULT_FARES = {
  sedan: { baseCents: 300, perMileCents: 150, perMinuteCents: 30 },
  suv: { baseCents: 500, perMileCents: 225, perMinuteCents: 40 },
  truck: { baseCents: 700, perMileCents: 300, perMinuteCents: 50 },
  bookingFeeCents: 250,
  minimumFareCents: 700,
  serviceFeeRate: 0.15,
  taxRate: 0.07,
};

/** TRD 4.7: a fee once the driver is en route; the grace window after that is free. */
export const DEFAULT_CANCELLATION = { feeCents: 500, graceSeconds: 0 };

export function defaultSettings() {
  return {
    fares: structuredClone(DEFAULT_FARES),
    cancellation: { ...DEFAULT_CANCELLATION },
    commission: {
      platformRate: env.platformCommissionRate,
      rentalRate: env.rentalCommissionRate,
      chauffeurRate: env.chauffeurCommissionRate,
    },
    chauffeurHourlyCents: { ...env.chauffeurHourlyCents },
    bonus: {
      minTrips: env.bonus.minTrips,
      minOnTimeRate: env.bonus.minOnTimeRate,
      minSafeScore: env.bonus.minSafeScore,
      onTimeGraceMinutes: env.bonus.onTimeGraceMinutes,
      amountCents: env.bonus.amountCents,
    },
    dispatch: { offerSeconds: env.dispatchOfferSeconds },
  };
}

const cents = z.number().int().min(0).max(10_000_000);
const rate = z.number().min(0).max(0.99);
const tier = z.object({ baseCents: cents, perMileCents: cents, perMinuteCents: cents }).partial().strict();

/** Partial update: any subset of the settings tree. */
export const settingsPatchSchema = z
  .object({
    fares: z
      .object({
        sedan: tier,
        suv: tier,
        truck: tier,
        bookingFeeCents: cents,
        minimumFareCents: cents,
        serviceFeeRate: rate,
        taxRate: rate,
      })
      .partial()
      .strict(),
    cancellation: z
      .object({ feeCents: cents, graceSeconds: z.number().int().min(0).max(3600) })
      .partial()
      .strict(),
    commission: z.object({ platformRate: rate, rentalRate: rate, chauffeurRate: rate }).partial().strict(),
    chauffeurHourlyCents: z.object({ sedan: cents.min(100), suv: cents.min(100), truck: cents.min(100) }).partial().strict(),
    bonus: z
      .object({
        minTrips: z.number().int().min(1).max(10000),
        minOnTimeRate: z.number().min(0).max(1),
        minSafeScore: z.number().min(0).max(100),
        onTimeGraceMinutes: z.number().min(0).max(120),
        amountCents: cents,
      })
      .partial()
      .strict(),
    dispatch: z.object({ offerSeconds: z.number().int().min(5).max(300) }).partial().strict(),
  })
  .partial()
  .strict();

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

function deepMerge(base, patch) {
  const out = structuredClone(base ?? {});
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

/** Leaf paths that differ between two trees: [{ path, from, to }]. */
export function diffSettings(before, after, prefix = "") {
  const changes = [];
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = before?.[key];
    const b = after?.[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(a) || isObject(b)) changes.push(...diffSettings(a, b, path));
    else if (a !== b) changes.push({ path, from: a ?? null, to: b ?? null });
  }
  return changes;
}

let overrides = {};
let merged = null;
let refreshTimer = null;

/** Current settings (sync; defaults until loadSettings has run). */
export function getSettings() {
  if (!merged) merged = deepMerge(defaultSettings(), overrides);
  return merged;
}

function setOverrides(next) {
  overrides = next || {};
  merged = null;
}

export async function loadSettings() {
  try {
    const doc = await Settings.findById("global").lean();
    setOverrides(doc?.overrides);
  } catch (err) {
    console.error("[settings] load failed:", err.message);
  }
  return getSettings();
}

export function startSettingsRefresh() {
  if (refreshTimer) return;
  const seconds = Math.max(5, Number(process.env.SETTINGS_REFRESH_SECONDS) || 30);
  refreshTimer = setInterval(() => void loadSettings(), seconds * 1000);
  refreshTimer.unref?.();
}

/**
 * Apply an admin change. `reset: true` drops every override (back to env defaults).
 * Returns { settings, changes } — the caller audits `changes`.
 */
export async function updateSettings(patch, { actorId = null, reset = false } = {}) {
  const before = getSettings();
  const data = reset ? {} : settingsPatchSchema.parse(patch || {});
  const nextOverrides = reset ? {} : deepMerge(overrides, data);
  const after = deepMerge(defaultSettings(), nextOverrides);
  await Settings.findByIdAndUpdate(
    "global",
    { $set: { overrides: nextOverrides, updatedBy: actorId } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  setOverrides(nextOverrides);
  return { settings: getSettings(), changes: diffSettings(before, after), overrides: nextOverrides };
}

/** Pricing in the shape utils/fares.js computeFare uses. */
export function currentPricing() {
  const f = getSettings().fares;
  const labels = { sedan: "Sedan", suv: "SUV", truck: "Truck" };
  return {
    rates: Object.fromEntries(
      VEHICLES.map((v) => [v, { base: f[v].baseCents, perMile: f[v].perMileCents, perMin: f[v].perMinuteCents, label: labels[v] }]),
    ),
    bookingFeeCents: f.bookingFeeCents,
    minimumFareCents: f.minimumFareCents,
    serviceFeeRate: f.serviceFeeRate,
    taxRate: f.taxRate,
  };
}
