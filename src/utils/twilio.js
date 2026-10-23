import { env } from "../config/env.js";

/**
 * Minimal Twilio REST client (Verify + Voice) over fetch — no SDK needed for the three
 * calls RideRite makes. Every helper throws on a non-2xx answer with Twilio's message.
 */
export function twilioAccountConfigured() {
  return Boolean(env.twilio.accountSid && env.twilio.authToken);
}

export async function twilioRequest(url, params) {
  const auth = Buffer.from(`${env.twilio.accountSid}:${env.twilio.authToken}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || `Twilio request failed (${res.status})`);
    err.twilioStatus = res.status;
    err.twilioCode = json?.code;
    throw err;
  }
  return json;
}
