import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import {
  uploadAvatarSingle,
  uploadSingle,
  uploadMultiple,
  uploadPrivateDocuments,
  uploadPhotos,
} from "../middleware/upload.middleware.js";
import * as uploads from "../controllers/uploads.controller.js";

const router = Router();

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many uploads. Try again later." },
});

router.use(requireAuth, requireVerified, uploadLimiter);

/** Profile photo: multipart field `avatar` */
router.post("/avatar", uploadAvatarSingle("avatar"), uploads.uploadAvatar);

/** Generic single file: multipart field `file` */
router.post("/file", uploadSingle("file"), uploads.uploadFile);

/** Multiple files: multipart field `files` */
router.post("/files", uploadMultiple("files", 10), uploads.uploadFiles);

/**
 * Driver documents (image or PDF): `licenseFront`, `licenseBack`, `registrationDoc`,
 * `insuranceDoc`. Stored privately; returns opaque refs that PATCH /api/driver/verification
 * saves with expiry dates.
 */
router.post(
  "/driver-docs",
  uploadPrivateDocuments([
    { name: "licenseFront", maxCount: 1 },
    { name: "licenseBack", maxCount: 1 },
    { name: "registrationDoc", maxCount: 1 },
    { name: "insuranceDoc", maxCount: 1 },
  ]),
  uploads.uploadDriverDocs,
);

/** Rental listing photos: multipart field `photos` (up to 8 images) */
router.post("/photos", uploadPhotos("photos", 8), uploads.uploadFiles);

export default router;
