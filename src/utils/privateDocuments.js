import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { localDocumentsPath } from "../config/upload.config.js";
import { httpError } from "../middleware/errorHandler.js";

/**
 * Private storage for driver documents (license front/back, registration, insurance).
 *
 * The DriverProfile stores an object *key* (e.g. `driver-documents/<userId>/licenseFront-<hex>.pdf`),
 * never a URL. Viewing a document asks the API, which checks owner / admin permission and
 * hands back a short-lived URL generated for that request:
 *
 *  - S3 (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; optional S3_ENDPOINT for
 *    S3-compatible storage): private objects, presigned GET URLs valid S3_SIGNED_URL_TTL_SECONDS.
 *    The browser downloads straight from S3.
 *  - Otherwise: private local disk (PRIVATE_UPLOAD_DIR, default ./private-uploads, never under
 *    the public /uploads route), served by GET /api/documents/file with an HMAC-signed,
 *    equally short-lived link.
 *
 * Legacy values keep working on read: files under the old public /uploads/documents folder
 * (now no longer served publicly) are signed like private local files; documents stored on the
 * external upload service keep their URL (that service cannot make them private — re-upload
 * to move them).
 */

export const DOCUMENT_UPLOAD_FIELDS = {
  licenseFront: "licenseFrontUrl",
  licenseBack: "licenseBackUrl",
  registrationDoc: "registrationDocUrl",
  insuranceDoc: "insuranceDocUrl",
};
/** Accepts "licenseFront" or "licenseFrontUrl" → the profile field name. */
export function profileFieldFor(name) {
  const n = String(name || "");
  if (DOCUMENT_UPLOAD_FIELDS[n]) return DOCUMENT_UPLOAD_FIELDS[n];
  return Object.values(DOCUMENT_UPLOAD_FIELDS).includes(n) ? n : null;
}

export const s3Configured = () =>
  Boolean(env.s3.bucket && env.s3.region && env.s3.accessKeyId && env.s3.secretAccessKey);

export const documentStorageMode = () => (s3Configured() ? "s3" : "local");

export const privateUploadRoot = path.resolve(env.privateUploadDir || path.join(process.cwd(), "private-uploads"));

const LEGACY_LOCAL = "legacy-local/";

// ----------------------------------------------------------------------------- file type

const TYPES = {
  pdf: { ext: "pdf", mime: "application/pdf" },
  jpg: { ext: "jpg", mime: "image/jpeg" },
  png: { ext: "png", mime: "image/png" },
  webp: { ext: "webp", mime: "image/webp" },
};

/** Image or PDF by magic bytes (the client's mimetype / extension are not trusted). */
export function detectDocumentType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return TYPES.pdf;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return TYPES.jpg;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return TYPES.png;
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return TYPES.webp;
  return null;
}

const mimeForKey = (key) => Object.values(TYPES).find((t) => key.toLowerCase().endsWith(`.${t.ext}`))?.mime || "application/octet-stream";

// ----------------------------------------------------------------------------- keys

const KEY_RE = /^[A-Za-z0-9._\-/]+$/;

/** A stored key (not a URL / data URI), safe to use as a path segment. */
export function isDocumentKey(value) {
  return typeof value === "string" && !/^(https?:|data:)/i.test(value) && KEY_RE.test(value) && !value.includes("..");
}

/** The key was issued to this user by storeDocument (keys are namespaced per user). */
export function keyBelongsTo(key, userId) {
  return isDocumentKey(key) && key.startsWith(`${env.s3.documentsPrefix}${userId}/`);
}

function localPathFor(key) {
  if (key.startsWith(LEGACY_LOCAL)) {
    const file = path.basename(key.slice(LEGACY_LOCAL.length));
    return path.join(localDocumentsPath, file);
  }
  const full = path.resolve(privateUploadRoot, key);
  if (!full.startsWith(privateUploadRoot + path.sep)) throw httpError(400, "Invalid document key");
  return full;
}

// ----------------------------------------------------------------------------- S3

let s3 = null;
let s3Sdk = null;
async function s3Client() {
  if (!s3) {
    s3Sdk = await import("@aws-sdk/client-s3");
    s3 = new s3Sdk.S3Client({
      region: env.s3.region,
      ...(env.s3.endpoint ? { endpoint: env.s3.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey },
    });
  }
  return { client: s3, sdk: s3Sdk };
}

/** Test hook: swap in a fake S3 client ({ send }) — used by smoke tests only. */
export function __setS3ClientForTests(client, sdk) {
  s3 = client;
  s3Sdk = sdk;
}

// ----------------------------------------------------------------------------- write / read

/**
 * Validate (magic bytes, size) and store one document privately. Returns
 * { key, mimetype, size, storage }.
 */
export async function storeDocument({ userId, field, buffer }) {
  if (!buffer?.length) throw httpError(400, "Empty file");
  if (buffer.length > env.documentMaxMb * 1024 * 1024) {
    throw httpError(413, `Documents must be ${env.documentMaxMb} MB or smaller`, { code: "DOCUMENT_TOO_LARGE" });
  }
  const type = detectDocumentType(buffer);
  if (!type) throw httpError(400, "Documents must be a JPG, PNG, WEBP image or a PDF", { code: "DOCUMENT_TYPE_INVALID" });
  const key = `${env.s3.documentsPrefix}${userId}/${field}-${crypto.randomBytes(12).toString("hex")}.${type.ext}`;

  if (s3Configured()) {
    const { client, sdk } = await s3Client();
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
        Body: buffer,
        ContentType: type.mime,
        // Private by default (no ACL); AWS also encrypts at rest
        ...(env.s3.endpoint ? {} : { ServerSideEncryption: "AES256" }),
      }),
    );
    return { key, mimetype: type.mime, size: buffer.length, storage: "s3" };
  }
  const full = localPathFor(key);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, buffer, { mode: 0o600 });
  return { key, mimetype: type.mime, size: buffer.length, storage: "local" };
}

/** Whether a stored key still points at a file (local or S3). */
export async function documentExists(key) {
  if (!isDocumentKey(key)) return false;
  if (fs.existsSync(localPathFor(key))) return true;
  if (!s3Configured()) return false;
  const { client, sdk } = await s3Client();
  try {
    await client.send(new sdk.HeadObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Legacy public local URL (…/uploads/documents/<file>) → its private key, else null. */
function legacyLocalKey(value) {
  const m = /\/uploads\/documents\/([A-Za-z0-9._-]+)$/.exec(String(value || "").split(/[?#]/)[0]);
  return m ? `${LEGACY_LOCAL}${m[1]}` : null;
}

const sign = (key, exp) => crypto.createHmac("sha256", env.jwtAccessSecret).update(`doc:${key}:${exp}`).digest("hex");

/**
 * Short-lived URL to view a stored document (call only after the owner / admin check).
 * → { url, expiresAt, storage, mimetype } or null when there is no file.
 */
export async function signedDocumentUrl(value, { baseUrl }) {
  if (!value) return null;
  const ttl = env.s3.signedUrlTtlSeconds;
  const legacyKey = legacyLocalKey(value);
  const key = isDocumentKey(value) ? value : legacyKey;
  if (!key) {
    // External upload service URL: already public, nothing to sign
    return { url: value, expiresAt: null, storage: "legacy-public", mimetype: mimeForKey(String(value).split(/[?#]/)[0]) };
  }
  const exp = Math.floor(Date.now() / 1000) + ttl;
  if (fs.existsSync(localPathFor(key))) {
    const qs = new URLSearchParams({ key, exp: String(exp), sig: sign(key, exp) });
    return { url: `${baseUrl}/api/documents/file?${qs}`, expiresAt: new Date(exp * 1000), storage: "local", mimetype: mimeForKey(key) };
  }
  if (!s3Configured() || key.startsWith(LEGACY_LOCAL)) return null;
  const { client, sdk } = await s3Client();
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const url = await getSignedUrl(
    client,
    new sdk.GetObjectCommand({ Bucket: env.s3.bucket, Key: key, ResponseContentDisposition: "inline" }),
    { expiresIn: ttl },
  );
  return { url, expiresAt: new Date(exp * 1000), storage: "s3", mimetype: mimeForKey(key) };
}

/** GET /api/documents/file?key=&exp=&sig= — local private storage only; the signature is the auth. */
export function serveSignedLocalDocument(req, res) {
  const key = String(req.query.key || "");
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig || "");
  const valid =
    isDocumentKey(key) &&
    Number.isFinite(exp) &&
    sig.length === 64 &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(key, exp)));
  if (!valid) return res.status(403).json({ ok: false, error: "Invalid document link" });
  if (exp * 1000 < Date.now()) return res.status(403).json({ ok: false, error: "This document link has expired", code: "DOCUMENT_LINK_EXPIRED" });
  const full = localPathFor(key);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: "Document not found" });
  res.set({
    "Content-Type": mimeForKey(key),
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  });
  res.sendFile(full);
}

/** Delete a stored document (GDPR erasure / replacement). Never throws. */
export async function deleteDocument(value) {
  try {
    const key = isDocumentKey(value) ? value : legacyLocalKey(value);
    if (!key) return false; // external upload service: no delete API
    const full = localPathFor(key);
    if (fs.existsSync(full)) {
      await fs.promises.unlink(full);
      return true;
    }
    if (!s3Configured() || key.startsWith(LEGACY_LOCAL)) return false;
    const { client, sdk } = await s3Client();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    return true;
  } catch (err) {
    console.warn("[documents] delete failed:", err.message);
    return false;
  }
}
