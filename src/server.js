import http from "node:http";
import { createApp } from "./app.js";
import { connectDb } from "./config/db.js";
import { ensureLegalPages } from "./utils/legal.js";
import { env } from "./config/env.js";
import { initRealtime } from "./realtime/index.js";
import { startDispatchSweeper } from "./utils/dispatch.js";
import { startPaymentSweeper } from "./utils/paymentSweeper.js";
import { startReminderSweeper } from "./utils/reminders.js";
import { startDriverSweeper } from "./utils/driverSweeper.js";
import { startPayoutScheduler } from "./utils/payoutSchedule.js";
import { loadSettings, startSettingsRefresh } from "./utils/settings.js";
import { warnIfWebhookUnverified } from "./utils/stripeReconcile.js";

async function main() {
  await connectDb();
  // Legal pages: seed the placeholder Terms / Privacy / Refund policy / EULA once
  await ensureLegalPages().catch((err) => console.error("[legal] seed failed:", err.message));
  // Admin-edited fares, fees and commissions (defaults to env when none are saved)
  await loadSettings();
  startSettingsRefresh();
  const app = createApp();
  // One HTTP server for both the REST API and Socket.IO (same port, /socket.io path)
  const server = http.createServer(app);
  initRealtime(server);
  // Advances ride offers whose timer was lost (restart / crash)
  startDispatchSweeper();
  // Releases unpaid booking holds and retries pending refunds
  startPaymentSweeper();
  warnIfWebhookUnverified();
  // Rental / chauffeur reminders (24h, 1h), unassigned chauffeur bookings at start time,
  // timed-out driver picks and rental auto-complete
  startReminderSweeper();
  // Daily: document expiry, monthly bonus freeze, maintenance and membership notices
  startDriverSweeper();
  // Weekly automatic driver payouts (off unless AUTO_PAYOUTS_ENABLED=true)
  startPayoutScheduler();
  server.listen(env.port, () => {
    console.log(`[server] ${env.appName} API listening on http://localhost:${env.port}`);
    console.log(`[server] health → http://localhost:${env.port}/health`);
    console.log(`[server] auth   → http://localhost:${env.port}/api/auth`);
  });
}

main().catch((err) => {
  console.error("[server] failed to start", err);
  process.exit(1);
});
