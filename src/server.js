import http from "node:http";
import { createApp } from "./app.js";
import { connectDb } from "./config/db.js";
import { env } from "./config/env.js";
import { initRealtime } from "./realtime/index.js";
import { startDispatchSweeper } from "./utils/dispatch.js";
import { startPaymentSweeper } from "./utils/paymentSweeper.js";

async function main() {
  await connectDb();
  const app = createApp();
  // One HTTP server for both the REST API and Socket.IO (same port, /socket.io path)
  const server = http.createServer(app);
  initRealtime(server);
  // Advances ride offers whose timer was lost (restart / crash)
  startDispatchSweeper();
  // Releases unpaid booking holds and retries pending refunds
  startPaymentSweeper();
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
