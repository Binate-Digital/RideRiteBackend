import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import * as addresses from "../controllers/addresses.controller.js";

const router = Router();
router.use(requireAuth, requireVerified);
router.get("/", addresses.list);
router.post("/", addresses.create);
router.delete("/:id", addresses.remove);

export default router;
