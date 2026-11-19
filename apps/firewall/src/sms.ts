// Texts to the owner. Two providers, no SDKs:
//   Textbelt (TEXTBELT_KEY set): real SMS to US numbers without carrier registration. https://docs.textbelt.com/master.md
//     Replies arrive as JSON at POST /v1/sms/textbelt, signed: hex HMAC-SHA256(key, X-textbelt-timestamp + raw body).
//   Twilio (TWILIO_* set): https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
//     Replies: POST /v1/twilio/inbound, X-Twilio-Signature (https://www.twilio.com/docs/usage/webhooks/webhooks-security)
// Neither configured: dry run (logged in sms_log, printed to the console).
import { createHmac, timingSafeEqual } from "node:crypto";
import { formatUsd, shortRecipient } from "@agent-firewall/policy";
import { config } from "./config";
import type { DB } from "./db";

const twilioConfigured = () => Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.from);
export const smsProvider = (): "textbelt" | "twilio" | "dry-run" => (config.textbelt.key ? "textbelt" : twilioConfigured() ? "twilio" : "dry-run");
export const smsConfigured = () => smsProvider() !== "dry-run";
/** Can texts carry links? Textbelt blocks URLs until the key is whitelisted. */
export const smsLinksAllowed = () => smsProvider() !== "textbelt" || config.textbelt.urlsAllowed;
/** Where Textbelt should POST replies (needs a public https URL, e.g. a tunnel). */
export const textbeltReplyUrl = () => (config.publicUrl.startsWith("https://") ? `${config.publicUrl}/v1/sms/textbelt` : null);

export async function sendSms(db: DB, to: string, body: string): Promise<string | null> {
  db.prepare("INSERT INTO sms_log (direction, phone, body, at) VALUES ('out', ?, ?, ?)").run(to, body, new Date().toISOString());
  const provider = smsProvider();
  if (provider === "dry-run") {
    console.log(`[sms:dry] → ${to}: ${body}`);
    return null;
  }
  if (provider === "textbelt") {
    const form = new URLSearchParams({ phone: to, message: body, key: config.textbelt.key!, sender: "Wallet Buddy" });
    const reply = textbeltReplyUrl();
    if (reply) form.set("replyWebhookUrl", reply);
    const res = await fetch("https://textbelt.com/text", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; textId?: string | number; error?: string; quotaRemaining?: number };
    if (!json.success) throw new Error(`Textbelt: ${json.error ?? `HTTP ${res.status}`}`);
    console.log(`[sms] textbelt → …${to.slice(-4)} (text ${json.textId}, ${json.quotaRemaining} credits left)`);
    return json.textId != null ? String(json.textId) : null;
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

/** Textbelt reply signature: hex HMAC-SHA256(key, timestamp + raw JSON body); timestamp at most 15 min old. */
export function validTextbeltSignature(signature: string | undefined, timestamp: string | undefined, raw: string, now = Date.now()): boolean {
  const key = config.textbelt.key;
  if (!key || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 15 * 60) return false;
  const expected = createHmac("sha256", key).update(timestamp + raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function holdMessage(p: { agentName: string; amountMicro: number; recipient: string; known: boolean; flags: string[]; minutes: number; link: string; code?: string | null; linkAllowed?: boolean }) {
  const who = p.known ? shortRecipient(p.recipient) : `an address you haven't approved (${shortRecipient(p.recipient)})`;
  const inj = p.flags.find((f) => /injection/i.test(f));
  const flag = inj ? ` Possible prompt injection: ${inj.replace(/^PROMPT_INJECTION: this request /, "it ").slice(0, 160)}.` : "";
  const approve = p.code ? `Reply YES ${p.code} to approve or NO to cancel.` : `Reply NO to cancel.${p.linkAllowed === false ? " To approve, use your passkey on the Wallet Buddy dashboard." : ` To approve, open: ${p.link}`}`;
  return `Wallet Buddy: your ${p.agentName} wants to send ${formatUsd(p.amountMicro)} to ${who}.${flag} Held safely; refunds in ${p.minutes} min if you do nothing. ${approve}`;
}

export const twiml = (msg: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)}</Message></Response>`;
