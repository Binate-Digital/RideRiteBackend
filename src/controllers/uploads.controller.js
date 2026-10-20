import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { fileToUploadResult } from "../middleware/upload.middleware.js";

/** POST /api/uploads/file — generic image/document → S3 (or local fallback) */
export const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) throw httpError(400, "No file uploaded");
  const file = fileToUploadResult(req.file, req);
  res.status(201).json({ ok: true, file });
});

/** POST /api/uploads/files — multiple files */
export const uploadFiles = asyncHandler(async (req, res) => {
  const list = Array.isArray(req.files) ? req.files : [];
  if (!list.length) throw httpError(400, "No files uploaded");
  const files = list.map((f) => fileToUploadResult(f, req));
  res.status(201).json({ ok: true, files });
});

/** POST /api/uploads/avatar — upload + save on user profile */
export const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw httpError(400, "No avatar file uploaded");
  const file = fileToUploadResult(req.file, req);
  req.user.avatarUrl = file.url;
  await req.user.save();
  res.status(201).json({
    ok: true,
    file,
    user: req.user.toSafeJSON(),
  });
});

/** POST /api/uploads/driver-docs — license front/back (fields: licenseFront, licenseBack) */
export const uploadDriverDocs = asyncHandler(async (req, res) => {
  const front = req.files?.licenseFront?.[0];
  const back = req.files?.licenseBack?.[0];
  if (!front && !back) {
    throw httpError(400, "Upload licenseFront and/or licenseBack");
  }

  const result = {
    licenseFront: front ? fileToUploadResult(front, req) : null,
    licenseBack: back ? fileToUploadResult(back, req) : null,
  };

  res.status(201).json({ ok: true, files: result });
});
