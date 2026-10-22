const UA = "RideRiteBackend/1.0 (driver-location; contact=getriderite@gmail.com)";

/** Best-effort forward geocode via OpenStreetMap Nominatim. */
export async function geocodeQuery(query) {
  const q = String(query || "").trim();
  if (q.length < 5) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const hit = Array.isArray(rows) ? rows[0] : null;
    const lat = Number(hit?.lat);
    const lng = Number(hit?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/** Orlando CBD — used when GPS + address geocode both fail (FL demo fallback). */
export const FL_ORLANDO_FALLBACK = { lat: 28.5383, lng: -81.3792 };

/**
 * Resolve a driver pin: explicit coords → profile address geocode → Orlando fallback for FL.
 */
export async function resolveDriverHomeBase(profile, explicit) {
  if (
    explicit &&
    Number.isFinite(explicit.lat) &&
    Number.isFinite(explicit.lng)
  ) {
    return { lat: explicit.lat, lng: explicit.lng, source: "gps" };
  }

  const parts = [
    profile.addressLine1,
    profile.city,
    profile.state,
    profile.zip,
  ]
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const geo = await geocodeQuery(parts.join(", "));
    if (geo) return { ...geo, source: "address" };
  }

  const state = String(profile.state || "FL").toUpperCase();
  if (state === "FL" || !state) {
    return { ...FL_ORLANDO_FALLBACK, source: "fallback" };
  }
  return null;
}
