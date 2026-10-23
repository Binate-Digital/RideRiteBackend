/**
 * Request metrics for the admin health page (TRD 6.9 performance monitoring).
 *
 * Every API response is recorded as { at, route, ms, status } in a rolling in-memory window
 * (METRICS_WINDOW_MINUTES, default 15; at most METRICS_MAX_SAMPLES). `route` is the matched
 * Express route pattern (e.g. "GET /api/rides/:id"), so ids don't explode the route list.
 * Per-instance only — each API process reports its own traffic.
 */

const WINDOW_MS = Math.max(1, Number(process.env.METRICS_WINDOW_MINUTES) || 15) * 60000;
const MAX_SAMPLES = Math.max(1000, Number(process.env.METRICS_MAX_SAMPLES) || 50000);

const samples = [];

function prune(now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < samples.length && samples[drop].at < cutoff) drop += 1;
  if (samples.length - drop > MAX_SAMPLES) drop = samples.length - MAX_SAMPLES;
  if (drop) samples.splice(0, drop);
}

function routeKey(req) {
  const url = String(req.originalUrl || req.url || "").split("?")[0];
  if (req.route?.path) {
    const path = typeof req.route.path === "string" ? req.route.path : String(req.route.path);
    // An error passed on with next(err) leaves the router, which resets baseUrl
    const base = req.baseUrl || (url.startsWith("/api/") ? `/${url.split("/").filter(Boolean).slice(0, 2).join("/")}` : "");
    return `${req.method} ${base}${path === "/" && base ? "" : path}`;
  }
  // Unmatched (404) or static: group under the first two segments
  const parts = url.split("/").filter(Boolean).slice(0, 2);
  return `${req.method} /${parts.join("/")}${parts.length ? "/*" : ""}`;
}

export function requestMetrics(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    if (req.method === "OPTIONS") return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    samples.push({ at: Date.now(), route: routeKey(req), ms, status: res.statusCode });
    if (samples.length % 500 === 0) prune();
  });
  next();
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 10) / 10;
}

function summarize(rows, minutes) {
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const errors = rows.filter((r) => r.status >= 500).length;
  const clientErrors = rows.filter((r) => r.status >= 400 && r.status < 500).length;
  return {
    count: rows.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    maxMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
    errorRate: rows.length ? errors / rows.length : 0,
    clientErrorRate: rows.length ? clientErrors / rows.length : 0,
    perMinute: Math.round((rows.length / Math.max(minutes, 1 / 60)) * 10) / 10,
  };
}

/** Overall + per-route latency percentiles, error rates and throughput for the window. */
export function metricsSnapshot({ topRoutes = 30 } = {}) {
  const now = Date.now();
  prune(now);
  const oldest = samples[0]?.at ?? now;
  // Throughput over the time actually covered (a fresh process has less than the full window)
  const minutes = Math.min(WINDOW_MS, Math.max(now - oldest, 1000)) / 60000;
  const byRoute = new Map();
  for (const s of samples) {
    if (!byRoute.has(s.route)) byRoute.set(s.route, []);
    byRoute.get(s.route).push(s);
  }
  const routes = [...byRoute.entries()]
    .map(([route, rows]) => ({ route, ...summarize(rows, minutes) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topRoutes);
  return {
    windowMinutes: WINDOW_MS / 60000,
    coveredMinutes: Math.round(minutes * 10) / 10,
    overall: summarize(samples, minutes),
    routes,
  };
}
