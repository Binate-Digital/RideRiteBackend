import express, { Router } from "express";
import * as telephony from "../controllers/telephony.controller.js";

const router = Router();

// Twilio posts form-encoded webhooks (signature-checked in the controller)
router.post("/voice", express.urlencoded({ extended: false }), telephony.inboundVoice);

export default router;
