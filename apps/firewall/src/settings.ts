// Owner-wide settings (one wallet, one owner): the phone that gets texts and which events text it.
// A per-agent notify row (POST /v1/agents/:id/notify) still overrides these for that agent.
import { config } from "./config";
import type { DB } from "./db";

export type NotifyEvent = "hold" | "budget80" | "paused";
export const NOTIFY_EVENTS: NotifyEvent[] = ["hold", "budget80", "paused"];
const DEFAULT_EVENTS: NotifyEvent[] = ["hold"];

function ensure(db: DB) {
  db.exec("CREATE TABLE IF NOT EXISTS owner_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

/** Approving by text: on by default, up to $5 per payment; above the cap the owner's passkey is required. */
export interface TextApprove { enabled: boolean; maxMicro: number }
const DEFAULT_TEXT_APPROVE: TextApprove = { enabled: true, maxMicro: 5_000_000 };

export function getOwnerSettings(db: DB): { phone: string | null; events: NotifyEvent[]; textApprove: TextApprove } {
  ensure(db);
  const rows = Object.fromEntries((db.prepare("SELECT key, value FROM owner_settings").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  return {
    phone: rows.phone || null,
    events: rows.events ? (JSON.parse(rows.events) as NotifyEvent[]) : DEFAULT_EVENTS,
    textApprove: rows.textApprove ? { ...DEFAULT_TEXT_APPROVE, ...JSON.parse(rows.textApprove) } : DEFAULT_TEXT_APPROVE,
  };
}

export function setOwnerSettings(db: DB, s: { phone?: string | null; events?: NotifyEvent[]; textApprove?: TextApprove }) {
  ensure(db);
  const put = db.prepare("INSERT INTO owner_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  if (s.phone !== undefined) put.run("phone", s.phone ?? "");
  if (s.events) put.run("events", JSON.stringify(s.events));
  if (s.textApprove) put.run("textApprove", JSON.stringify(s.textApprove));
}

/** Who to text about this agent, and for which events: the agent's own setting, else the owner-wide one, else OWNER_PHONE. */
export function contactFor(db: DB, agentId: string): { phone: string | null; events: NotifyEvent[] } {
  return contactForInner(db, agentId);
}
function contactForInner(db: DB, agentId: string): { phone: string | null; events: NotifyEvent[] } {
  const row = db.prepare("SELECT phone, events_json FROM notify WHERE agent_id=?").get(agentId) as { phone: string | null; events_json: string } | undefined;
  if (row?.phone) return { phone: row.phone, events: JSON.parse(row.events_json) };
  const g = getOwnerSettings(db);
  if (g.phone) return { phone: g.phone, events: g.events };
  return { phone: config.twilio.ownerPhone ?? null, events: row ? JSON.parse(row.events_json) : DEFAULT_EVENTS };
}

/** Is this the owner's number (owner-wide setting or OWNER_PHONE)? Inbound texts from it act on every agent. */
export function isOwnerPhone(db: DB, phone: string): boolean {
  const g = getOwnerSettings(db).phone;
  return Boolean(phone) && (phone === g || phone === config.twilio.ownerPhone);
}
