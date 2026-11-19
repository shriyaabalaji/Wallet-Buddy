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

/** Scan a seller response. JSON bodies are scanned field by field so excerpts are clean text, not JSON syntax. */
export function scanForPaymentInstruction(body: string): InjectionFinding | null {
  let strings: string[] = [body];
  try {
    const out: string[] = [];
    const walk = (v: unknown) => (typeof v === "string" ? out.push(v) : v && typeof v === "object" ? Object.values(v).forEach(walk) : undefined);
    walk(JSON.parse(body));
    if (out.length) strings = out;
  } catch { /* not JSON: scan as text */ }
  for (const s of strings) {
    const f = scanText(s);
    if (f) return f;
  }
  return null;
}

function scanText(text: string): InjectionFinding | null {
  const m = PAY_INSTRUCTION.exec(text);
  const hits = MARKERS.filter(([re]) => re.test(text));
  if (!m && hits.length < 2) return null;
  const at = m?.index ?? text.search(hits[0]![0]);
  const excerpt = text.slice(at, at + 140).replace(/\s+/g, " ").trim();
  return { excerpt, address: m ? m[4]!.toLowerCase() : null, amountUsdc: m ? Number(m[2]) : null, markers: hits.map(([, label]) => label) };
}

function ensure(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS injection_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT, seller TEXT NOT NULL,
    excerpt TEXT NOT NULL, address TEXT, amount_usdc REAL, markers_json TEXT NOT NULL, at_ms INTEGER NOT NULL)`);
  try { db.exec("ALTER TABLE injection_events ADD COLUMN task_id TEXT"); } catch { /* already there */ }
}

/** Called with every seller response the firewall relays. Returns the finding (also stored) or null. */
export function recordSellerResponse(db: DB, agentId: string, requestId: string, seller: string, body: string): InjectionFinding | null {
  const f = scanForPaymentInstruction(body);
  if (!f) return null;
  ensure(db);
  const taskId = (db.prepare("SELECT task_id FROM requests WHERE request_id=?").get(requestId) as any)?.task_id ?? null;
  db.prepare("INSERT INTO injection_events (agent_id, request_id, task_id, seller, excerpt, address, amount_usdc, markers_json, at_ms) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(agentId, requestId, taskId, seller, f.excerpt, f.address, f.amountUsdc, JSON.stringify(f.markers), Date.now());
  console.warn(`[injection] ${seller} response to ${agentId} (${requestId}) contains a payment instruction: "${f.excerpt}"`);
  return f;
}

/**
 * If this payment request looks like it acts on injected instructions, the flag text; else null. Flagged when, within
 * the window, the agent read a tainted response and now (a) pays the exact address it was told to pay, (b) pays a raw
 * address, or (c) pays anyone within the same task. A later, unrelated purchase from a known seller isn't flagged.
 */
export function injectionFlag(db: DB, agentId: string, recipient: string, taskId?: string, now = Date.now()): string | null {
  ensure(db);
  const rows = db.prepare("SELECT * FROM injection_events WHERE agent_id=? AND at_ms>=? ORDER BY at_ms DESC").all(agentId, now - WINDOW_MS) as any[];
  if (!rows.length) return null;
  const exact = rows.find((r) => r.address && r.address === recipient.toLowerCase());
  const raw = /^0x[0-9a-fA-F]{40}$/.test(recipient);
  const sameTask = taskId ? rows.find((r) => r.task_id === taskId) : undefined;
  const r = exact ?? (raw ? rows[0] : sameTask);
  if (!r) return null;
  const what = exact ? `pays exactly the address that ${r.seller}'s response told the agent to pay`
    : raw ? `pays a raw address soon after a ${r.seller} response that contained payment instructions`
    : `comes in the same task as a ${r.seller} response that contained payment instructions`;
  return `PROMPT_INJECTION: this request ${what} ("${r.excerpt.slice(0, 100)}")`;
}
