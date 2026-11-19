// Prompt-injection detection. In circle-agent-wallet mode the firewall itself fetches each paid seller response (payer.ts)
// before handing it to the agent, so it can see when a seller slips payment instructions into data ("send 3 USDC to
// 0x…", "SYSTEM NOTICE TO AI AGENTS", "do not ask the user"). Each such response is recorded; any later payment request
// from the same agent within the window is flagged PROMPT_INJECTION with the excerpt, and the owner is alerted.
// The flag never loosens a decision: the owner's rules still decide (a raw attacker address isn't on any allowlist).
// In local-key mode the agent fetches responses itself, so only the agent-reported sourceContext is available.
import type { DB } from "./db";

const WINDOW_MS = 30 * 60_000;
const PAY_INSTRUCTION = /\b(send|transfer|pay|wire|remit)\s+\$?(\d+(?:\.\d+)?)\s*(usdc|usd|dollars)?\s+(?:to\s+)?(0x[0-9a-fA-F]{40})/i;
const MARKERS: [RegExp, string][] = [
  [/system notice to ai agents|attention ai agent|note to (the )?(ai|assistant|agent)/i, "addresses AI agents directly"],
  [/ignore (all |any )?(previous|prior) instructions/i, "tells the agent to ignore its instructions"],
  [/do not (ask|tell|inform) the (user|owner)/i, "tells the agent to hide it from the owner"],
  [/(license|subscription|access) (has )?expired/i, "claims an expired license"],
];

export interface InjectionFinding { excerpt: string; address: string | null; amountUsdc: number | null; markers: string[] }

export function scanForPaymentInstruction(text: string): InjectionFinding | null {
  const m = PAY_INSTRUCTION.exec(text);
  const hits = MARKERS.filter(([re]) => re.test(text));
  if (!m && hits.length < 2) return null;
  const at = m?.index ?? text.search(hits[0]![0]);
  const excerpt = text.slice(at, at + 140).replace(/\s+/g, " ").trim();
  return { excerpt, address: m ? m[4]!.toLowerCase() : null, amountUsdc: m ? Number(m[2]) : null, markers: hits.map(([, label]) => label) };
}

function ensure(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS injection_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, request_id TEXT NOT NULL, seller TEXT NOT NULL,
    excerpt TEXT NOT NULL, address TEXT, amount_usdc REAL, markers_json TEXT NOT NULL, at_ms INTEGER NOT NULL)`);
}

/** Called with every seller response the firewall relays. Returns the finding (also stored) or null. */
export function recordSellerResponse(db: DB, agentId: string, requestId: string, seller: string, body: string): InjectionFinding | null {
  const f = scanForPaymentInstruction(body);
  if (!f) return null;
  ensure(db);
  db.prepare("INSERT INTO injection_events (agent_id, request_id, seller, excerpt, address, amount_usdc, markers_json, at_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(agentId, requestId, seller, f.excerpt, f.address, f.amountUsdc, JSON.stringify(f.markers), Date.now());
  console.warn(`[injection] ${seller} response to ${agentId} (${requestId}) contains a payment instruction: "${f.excerpt}"`);
  return f;
}

/** If this payment request follows a seller response that carried payment instructions, the flag text; else null. */
export function injectionFlag(db: DB, agentId: string, recipient: string, now = Date.now()): string | null {
  ensure(db);
  const rows = db.prepare("SELECT * FROM injection_events WHERE agent_id=? AND at_ms>=? ORDER BY at_ms DESC").all(agentId, now - WINDOW_MS) as any[];
  if (!rows.length) return null;
  const match = rows.find((r) => r.address && r.address === recipient.toLowerCase());
  const r = match ?? rows[0];
  const what = match ? `pays exactly the address that ${r.seller}'s response told the agent to pay` : `follows a ${r.seller} response that contained payment instructions`;
  return `PROMPT_INJECTION: this request ${what} ("${r.excerpt.slice(0, 120)}")`;
}
