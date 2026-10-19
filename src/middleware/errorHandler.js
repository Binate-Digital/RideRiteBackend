import { ZodError } from "zod";
import { env } from "../config/env.js";

export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: "Not found",
    path: req.originalUrl,
  });
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      ok: false,
      error: "Validation failed",
      details: err.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      })),
    });
  }

  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return res.status(401).json({ ok: false, error: err.message || "Invalid token" });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || "field";
    return res.status(409).json({
      ok: false,
      error: `${field} already in use`,
    });
  }

  const status = err.statusCode || err.status || 500;
  const message = err.message || "Internal server error";

  if (env.isDev) {
    console.error("[error]", err);
  }

  res.status(status).json({
    ok: false,
    error: message,
    ...(err.details !== undefined ? { details: err.details } : {}),
    ...(err.code ? { code: err.code } : {}),
    ...(env.isDev && status >= 500 ? { stack: err.stack } : {}),
  });
}

export function httpError(statusCode, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (details !== undefined) err.details = details;
  return err;
}
