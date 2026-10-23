import crypto from "node:crypto";
import { env } from "../config/env.js";
import { httpError } from "../middleware/errorHandler.js";
import { toE164 } from "./phone.js";
import { twilioAccountConfigured, twilioRequest } from "./twilio.js";

/**
 * Masked rider ↔ driver calling (TRD 4.6) over Twilio Programmable Voice.
 *
 * Configured when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN and a pool of Twilio numbers
 * (TWILIO_PROXY_NUMBERS) are set. A call request rings the caller from a pool number and,
 * when they answer, TwiML <Dial>s the other party with the same pool number as caller ID —
 * neither side ever sees the other's real number. The pool number is stable per trip, so a
 * call back to it is routed by the inbound voice webhook (POST /api/telephony/voice).
 */
export function telephonyConfigured() {
  return twilioAccountConfigured() && env.twilio.proxyNumbers.length > 0;
}

/** Same trip → same pool number (so a missed call can be returned). */
export function proxyNumberFor(tripId) {
  const pool = env.twilio.proxyNumbers;
  const h = crypto.createHash("sha256").update(String(tripId)).digest();
  return pool[h.readUInt32BE(0) % pool.length];
}

export function userPhoneE164(user) {
  return user?.phoneE164 || toE164(user?.phone || "") || null;
}

const xml = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

/** TwiML that connects the answered leg to `to`, showing the pool number. */
export function bridgeTwiml({ to, proxyNumber, say }) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say ? `<Say>${xml(say)}</Say>` : ""}<Dial callerId="${xml(proxyNumber)}" timeLimit="1800"><Number>${xml(to)}</Number></Dial></Response>`;
}

export function sayTwiml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(text)}</Say><Hangup/></Response>`;
}

/** Ring `callerE164` from the trip's pool number; on answer, bridge to `calleeE164`. */
export async function startMaskedCall({ tripId, callerE164, calleeE164, calleeLabel }) {
  if (!telephonyConfigured()) {
    throw httpError(503, "Calling isn't configured yet — use in-app chat", { code: "TELEPHONY_NOT_CONFIGURED" });
  }
  const proxyNumber = proxyNumberFor(tripId);
  try {
    const call = await twilioRequest(
      `https://api.twilio.com/2010-04-01/Accounts/${env.twilio.accountSid}/Calls.json`,
      {
        To: callerE164,
        From: proxyNumber,
        Twiml: bridgeTwiml({ to: calleeE164, proxyNumber, say: `Connecting you to your ${calleeLabel}.` }),
      },
    );
    return { callSid: call.sid, proxyNumber };
  } catch (err) {
    console.error(`[telephony] call for trip ${tripId} failed:`, err.message);
    throw httpError(502, "Couldn't place the call right now — try again or use chat", { code: "CALL_FAILED" });
  }
}

/**
 * Twilio request signature (X-Twilio-Signature): HMAC-SHA1 over the full webhook URL plus
 * every POST param (sorted by name, name+value concatenated), base64, keyed by the auth token.
 */
export function validTwilioSignature(url, params, signature) {
  if (!signature || !env.twilio.authToken) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac("sha1", env.twilio.authToken).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
