import { createApp } from "./app.js";
import { connectDb } from "./config/db.js";
import { env } from "./config/env.js";

async function main() {
  await connectDb();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`[server] ${env.appName} API listening on http://localhost:${env.port}`);
    console.log(`[server] health → http://localhost:${env.port}/health`);
    console.log(`[server] auth   → http://localhost:${env.port}/api/auth`);
  });
}

main().catch((err) => {
  console.error("[server] failed to start", err);
  process.exit(1);
});
