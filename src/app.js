import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import ridesRoutes from "./routes/rides.routes.js";
import driverRoutes from "./routes/driver.routes.js";
import paymentsRoutes from "./routes/payments.routes.js";
import { stripeWebhook } from "./controllers/payments.controller.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(",").map((s) => s.trim()),
      credentials: true,
    }),
  );

  // Stripe webhook needs raw body — must be before express.json()
  app.post(
    "/api/payments/webhook",
    express.raw({ type: "application/json" }),
    stripeWebhook,
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(env.isDev ? "dev" : "combined"));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "riderite-backend",
      env: env.nodeEnv,
      paymentsMode: env.stripeMock ? "mock" : "stripe",
      time: new Date().toISOString(),
    });
  });

  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      name: env.appName,
      message: "RideRite API",
      docs: {
        health: "GET /health",
        auth: "POST /api/auth/*",
        rides: "POST /api/rides/*",
        driver: "GET /api/driver/*",
        payments: "POST /api/payments/rides/:id/intent | methods | webhook",
      },
    });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/rides", ridesRoutes);
  app.use("/api/driver", driverRoutes);
  app.use("/api/payments", paymentsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
