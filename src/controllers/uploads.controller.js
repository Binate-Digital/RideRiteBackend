import { asyncHandler } from "../utils/asyncHandler.js";
import { httpError } from "../middleware/errorHandler.js";
import { fileToUploadResult } from "../middleware/upload.middleware.js";
import { storeDocument } from "../utils/privateDocuments.js";

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

/**
 * POST /api/uploads/driver-docs — license front/back, vehicle registration and insurance
 * (fields: licenseFront, licenseBack, registrationDoc, insuranceDoc). Each file must really be
 * an image or PDF (magic bytes) and is stored privately; the response carries an opaque `ref`
 * (the storage key — `url` repeats it for older clients), never a public URL.
 */
export const uploadDriverDocs = asyncHandler(async (req, res) => {
  const userId = req.user._id.toString();
  const pick = async (field) => {
    const f = req.files?.[field]?.[0];
    if (!f) return null;
    const stored = await storeDocument({ userId, field, buffer: f.buffer });
    return { ref: stored.key, url: stored.key, mimetype: stored.mimetype, size: stored.size, storage: stored.storage, private: true };
  };
  const result = {
    licenseFront: await pick("licenseFront"),
    licenseBack: await pick("licenseBack"),
    registrationDoc: await pick("registrationDoc"),
    insuranceDoc: await pick("insuranceDoc"),
  };
  if (!Object.values(result).some(Boolean)) {
    throw httpError(400, "Upload licenseFront, licenseBack, registrationDoc and/or insuranceDoc");
  }
  res.status(201).json({ ok: true, files: result });
});
