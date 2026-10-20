import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import { env } from "./config/env.js";
import { localUploadRoot } from "./config/upload.config.js";
import authRoutes from "./routes/auth.routes.js";
import ridesRoutes from "./routes/rides.routes.js";
import driverRoutes from "./routes/driver.routes.js";
import paymentsRoutes from "./routes/payments.routes.js";
import uploadsRoutes from "./routes/uploads.routes.js";
import { stripeWebhook } from "./controllers/payments.controller.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

  // Always allow WEB_APP_URL + CORS_ORIGIN list (UAT frontend is often only in WEB_APP_URL).
  const allowedOriginSet = new Set(
    [env.webAppUrl, ...String(env.corsOrigin || "").split(",")]
      .map((s) => String(s || "").trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
  const allowAllOrigins = env.corsOrigin === "*";

  app.use(
    cors({
      origin(origin, cb) {
        // Non-browser / same-origin tools send no Origin
        if (!origin) return cb(null, true);
        if (allowAllOrigins) return cb(null, true);
        const normalized = origin.replace(/\/$/, "");
        if (allowedOriginSet.has(normalized)) return cb(null, true);
        // Never throw — cors Error becomes HTTP 500 and browsers report "CORS failed"
        console.warn(
          `[cors] blocked origin: ${origin} (allowed: ${[...allowedOriginSet].join(", ")})`,
        );
        return cb(null, false);
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Accept"],
      optionsSuccessStatus: 204,
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
        uploads: "POST /api/uploads/avatar | file | files | driver-docs",
      },
    });
  });

  // Local-dev uploaded files (when UPLOAD_API_TOKEN is empty)
  app.use("/uploads", express.static(localUploadRoot));

  app.use("/api/auth", authRoutes);
  app.use("/api/rides", ridesRoutes);
  app.use("/api/driver", driverRoutes);
  app.use("/api/payments", paymentsRoutes);
  app.use("/api/uploads", uploadsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
