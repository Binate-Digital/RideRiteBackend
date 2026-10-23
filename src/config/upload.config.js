import path from "node:path";
import fs from "node:fs";
import { env } from "./env.js";

/** Local fallback directory when UPLOAD_API_TOKEN is not set (dev only). */
export const localUploadRoot = path.join(process.cwd(), "uploads");
export const localAvatarsPath = path.join(localUploadRoot, "avatars");
export const localDocumentsPath = path.join(localUploadRoot, "documents");
export const localPhotosPath = path.join(localUploadRoot, "photos");

export function ensureLocalUploadDirs() {
  for (const dir of [localAvatarsPath, localDocumentsPath, localPhotosPath]) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn("[upload] could not create", dir, err.message);
    }
  }
}

ensureLocalUploadDirs();

export const ALLOWED_IMAGE_MIME = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

export const ALLOWED_DOCUMENT_MIME = [
  ...ALLOWED_IMAGE_MIME,
  "application/pdf",
];

export const uploadConfig = {
  apiUrl: env.uploadApiUrl,
  apiToken: env.uploadApiToken,
  projectName: env.uploadProjectName,
  /** Prefer remote S3 upload when token is present */
  useRemote: Boolean(env.uploadApiToken),
  maxImageBytes: 2 * 1024 * 1024,
  maxDocumentBytes: 50 * 1024 * 1024,
  /** Rental listing photos (images only; phone photos are often over the 2MB avatar cap) */
  maxPhotoBytes: 10 * 1024 * 1024,
};
