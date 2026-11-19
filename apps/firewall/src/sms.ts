// Twilio over its REST API (no SDK, to keep deps small).
// Docs: https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
//       https://www.twilio.com/docs/usage/webhooks/webhooks-security
import { createHmac, timingSafeEqual } from "node:crypto";
import { formatUsd, shortRecipient } from "@agent-firewall/policy";
import { config } from "./config";
import type { DB } from "./db";

export const smsConfigured = () => Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.from);

export async function sendSms(db: DB, to: string, body: string): Promise<string | null> {
  db.prepare("INSERT INTO sms_log (direction, phone, body, at) VALUES ('out', ?, ?, ?)").run(to, body, new Date().toISOString());
  if (!smsConfigured()) {
    console.log(`[sms:dry] → ${to}: ${body}`);
    return null;
  }
  const { accountSid, authToken, from } = config.twilio;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from!, Body: body }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${json?.message ?? "send failed"}`);
  return json.sid as string;
}

/** X-Twilio-Signature = base64(HMAC-SHA1(authToken, fullUrl + sorted(key+value)...)). */
export function validTwilioSignature(signature: string | undefined, url: string, params: Record<string, string>): boolean {
  if (!config.twilio.authToken) return config.devMode; // allow local testing without Twilio
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", config.twilio.authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function holdMessage(p: { agentName: string; amountMicro: number; recipient: string; known: boolean; flags: string[]; minutes: number; link: string }) {
  const who = p.known ? shortRecipient(p.recipient) : `an address you haven't approved (${shortRecipient(p.recipient)})`;
  const inj = p.flags.find((f) => /injection/i.test(f));
  const flag = inj ? ` Possible prompt injection: ${inj.replace(/^PROMPT_INJECTION: this request /, "it ").slice(0, 160)}.` : "";
  return `Your ${p.agentName} wants to send ${formatUsd(p.amountMicro)} to ${who}.${flag} It's held safely and refunds in ${p.minutes} min if you do nothing. Reply NO to cancel it. To approve, open: ${p.link}`;
}

export const twiml = (msg: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)}</Message></Response>`;
