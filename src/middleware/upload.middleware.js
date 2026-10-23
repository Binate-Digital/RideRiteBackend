import multer from "multer";
import path from "node:path";
import axios from "axios";
import FormData from "form-data";
import {
  ALLOWED_DOCUMENT_MIME,
  ALLOWED_IMAGE_MIME,
  localAvatarsPath,
  localDocumentsPath,
  localPhotosPath,
  uploadConfig,
} from "../config/upload.config.js";

/**
 * Remote storage — streams file to RideRite upload API → S3.
 * Multer custom engine: _handleFile / _removeFile
 */
function createRemoteStorage() {
  return {
    _handleFile(req, file, cb) {
      const formData = new FormData();
      formData.append("projectName", uploadConfig.projectName);
      formData.append("file", file.stream, {
        filename: file.originalname,
        contentType: file.mimetype,
      });

      axios
        .post(uploadConfig.apiUrl, formData, {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${uploadConfig.apiToken}`,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 60_000,
        })
        .then((response) => {
          const data = response.data?.data || response.data || {};
          cb(null, {
            filename: data.originalName || file.originalname,
            mimetype: file.mimetype,
            size: data.size || 0,
            location: data.url,
            key: data.fileKey,
          });
        })
        .catch((error) => {
          console.error("[upload] remote error:", error.message);
          cb(error);
        });
    },

    _removeFile(_req, _file, cb) {
      cb(null);
    },
  };
}

function createLocalDiskStorage(destDir, namePrefix) {
  return multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, destDir);
    },
    filename(_req, file, cb) {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const ext = path.extname(file.originalname) || ".bin";
      cb(null, `${namePrefix}-${unique}${ext}`);
    },
  });
}

function imageFilter(_req, file, cb) {
  if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) cb(null, true);
  else cb(new Error("Only JPG, PNG, or WEBP images are allowed"), false);
}

function documentFilter(_req, file, cb) {
  if (ALLOWED_DOCUMENT_MIME.includes(file.mimetype)) cb(null, true);
  else cb(new Error("Only image or PDF files are allowed"), false);
}

function buildUploader({ imagesOnly = true, maxBytes, localDir = null, localPrefix = null } = {}) {
  const limits = { fileSize: maxBytes };
  const fileFilter = imagesOnly ? imageFilter : documentFilter;

  if (uploadConfig.useRemote) {
    return multer({
      storage: createRemoteStorage(),
      limits,
      fileFilter,
    });
  }

  // Dev fallback — write to ./uploads and serve via /uploads/*
  const dest = localDir || (imagesOnly ? localAvatarsPath : localDocumentsPath);
  const prefix = localPrefix || (imagesOnly ? "avatar" : "doc");
  return multer({
    storage: createLocalDiskStorage(dest, prefix),
    limits,
    fileFilter,
  });
}

const imageUpload = buildUploader({
  imagesOnly: true,
  maxBytes: uploadConfig.maxImageBytes,
});

const documentUpload = buildUploader({
  imagesOnly: false,
  maxBytes: uploadConfig.maxDocumentBytes,
});

const photoUpload = buildUploader({
  imagesOnly: true,
  maxBytes: uploadConfig.maxPhotoBytes,
  localDir: localPhotosPath,
  localPrefix: "photo",
});

/** Normalize multer file → public URL + optional S3 key */
export function fileToUploadResult(file, req) {
  if (!file) return null;

  // Remote S3 engine
  if (file.location) {
    return {
      url: file.location,
      key: file.key || null,
      filename: file.filename || file.originalname,
      mimetype: file.mimetype,
      size: file.size || 0,
      storage: "s3",
    };
  }

  // Local disk
  const folder = file.destination?.includes("documents")
    ? "documents"
    : file.destination?.includes("photos")
      ? "photos"
      : "avatars";
  const base = `${req.protocol}://${req.get("host")}`;
  return {
    url: `${base}/uploads/${folder}/${file.filename}`,
    key: null,
    filename: file.filename,
    mimetype: file.mimetype,
    size: file.size || 0,
    storage: "local",
  };
}

// ——— Exports used by routes ———

/** Avatar / profile photo (images, 2MB) */
export const uploadAvatar = imageUpload;
export const uploadAvatarSingle = (field = "avatar") => imageUpload.single(field);

/** License / KYC / any document (images + PDF, 50MB) */
export const uploadDocument = documentUpload;
export const uploadSingle = (field = "file") => documentUpload.single(field);
export const uploadMultiple = (field = "files", max = 10) =>
  documentUpload.array(field, max);
export const uploadFields = (fields) => documentUpload.fields(fields);

/** Rental listing photos (JPG / PNG / WEBP, 10MB each) */
export const uploadPhotos = (field = "photos", max = 8) => photoUpload.array(field, max);
