// Hold lifecycle: hold → (deny | approve-with-passkey | expire → refund).
// Denying is always safe (SMS "NO" works). Releasing money requires a verified passkey.
import { contactFor, getOwnerSettings, isOwnerPhone } from "./settings";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { shortRecipient } from "@agent-firewall/policy";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { config, explorerTx } from "./config";
import { immediate, type DB } from "./db";
import { hashToken } from "./engine";
import { arcStatus, vaultApprove, vaultDeny, vaultHold, vaultRefundExpired } from "./arc";
import { holdMessage, sendSms, smsLinksAllowed } from "./sms";
import { activePolicy } from "./engine";

export interface HeldView {
  requestId: string;
  token?: string;
  amountMicro: number;
  recipient: string;
  reason: string;
  flags: string[];
  createdAt: string;
  expiresAt: string;
  status: "held" | "approved" | "denied" | "expired";
  holdTx: string | null;
  /** Why the Arc escrow failed; null when it succeeded or Arc isn't configured. */
  holdError: string | null;
  holdTxUrl: string | null;
  resolveTx: string | null;
  resolveTxUrl: string | null;
  agentName: string;
}

const SELECT_HOLD = `SELECT h.*, r.amount_micro, r.recipient, r.reason, r.flags_json, r.created_at, r.agent_id, a.name agent_name
  FROM holds h JOIN requests r ON r.request_id = h.request_id JOIN agents a ON a.id = r.agent_id`;

function view(row: any, includeToken: boolean): HeldView {
  return {
    requestId: row.request_id,
    token: includeToken && row.dev_token ? row.dev_token : undefined,
    amountMicro: row.amount_micro,
    recipient: row.recipient,
    reason: row.reason,
    flags: JSON.parse(row.flags_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    holdTx: row.hold_tx,
    holdError: row.hold_error ?? null,
    holdTxUrl: explorerTx(row.hold_tx),
    resolveTx: row.resolve_tx,
    resolveTxUrl: explorerTx(row.resolve_tx),
    agentName: row.agent_name,
  };
}

/** Every agent's waiting holds, soonest-expiring first (owner Overview). */
export function allPendingHolds(db: DB): (HeldView & { agentId: string })[] {
  return (db.prepare(`${SELECT_HOLD} WHERE h.status = 'held' ORDER BY h.expires_ms`).all() as any[]).map((r) => ({ ...view(r, config.devMode), agentId: r.agent_id }));
}

export function pendingHolds(db: DB, agentId: string): HeldView[] {
  return (db.prepare(`${SELECT_HOLD} WHERE r.agent_id = ? AND h.status = 'held' ORDER BY h.expires_ms`).all(agentId) as any[]).map((r) => view(r, config.devMode));
}

export function holdByToken(db: DB, token: string): HeldView | null {
  const row = db.prepare(`${SELECT_HOLD} WHERE h.token_hash = ?`).get(hashToken(token));
  return row ? view(row, false) : null;
}

function ensureTextCols(db: DB) {
  try { db.exec("ALTER TABLE holds ADD COLUMN text_code_hash TEXT"); } catch { /* already there */ }
  try { db.exec("ALTER TABLE holds ADD COLUMN text_attempts INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
  try { db.exec("ALTER TABLE holds ADD COLUMN approved_via TEXT"); } catch { /* already there */ }
}
const MAX_TEXT_ATTEMPTS = 5;
const codeHash = (requestId: string, code: string) => createHash("sha256").update(`${requestId}:${code}`).digest("hex");

/** Side effects after a hold decision: escrow on Arc + text the owner. Errors are logged, never thrown to the agent. */
export async function onHold(db: DB, requestId: string, token: string, expiresAt: string) {
  const row = db.prepare(`${SELECT_HOLD} WHERE h.request_id = ?`).get(requestId) as any;
  if (!row) return;
  const policy = activePolicy(db, row.agent_id);
  const allow = policy?.rules.find((r) => r.kind === "allowlist");
  const known = allow?.kind === "allowlist" ? allow.recipients.includes(row.recipient.toLowerCase()) : false;
  const { phone, events } = contactFor(db, row.agent_id);

  const link = `${config.appBaseUrl}/a/${token}`;
  const tasks: Promise<unknown>[] = [];
  if (phone && events.includes("hold")) {
    // Approve by text: a one-time 6-digit code for THIS payment, only when enabled and within the owner's cap.
    const ta = getOwnerSettings(db).textApprove;
    let code: string | null = null;
    if (ta.enabled && row.amount_micro <= ta.maxMicro) {
      ensureTextCols(db);
      code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      db.prepare("UPDATE holds SET text_code_hash=?, text_attempts=0 WHERE request_id=?").run(codeHash(requestId, code), requestId);
    }
    const body = holdMessage({ agentName: row.agent_name, amountMicro: row.amount_micro, recipient: row.recipient, known, flags: JSON.parse(row.flags_json), minutes: config.holdMinutes, link, code, linkAllowed: smsLinksAllowed() });
    tasks.push(sendSms(db, phone, body).then((sid) => sid && db.prepare("UPDATE holds SET sms_sid=? WHERE request_id=?").run(sid, requestId)));
  }
  tasks.push(
    vaultHold(requestId, row.recipient, row.amount_micro, new Date(expiresAt))
      .then((tx) => tx && db.prepare("UPDATE holds SET hold_tx=?, hold_error=NULL WHERE request_id=?").run(tx, requestId))
      .catch((e) => {
        db.prepare("UPDATE holds SET hold_error=? WHERE request_id=?").run(shortError(e), requestId);
        throw e;
      }),
  );
  for (const r of await Promise.allSettled(tasks)) if (r.status === "rejected") console.error(`[hold ${requestId}]`, r.reason);
}

/** First line of a viem/contract error, without the stack and ABI dump. */
function shortError(e: unknown): string {
  const any = e as { shortMessage?: string; details?: string; message?: string };
  const msg = any?.details ?? any?.shortMessage ?? any?.message ?? String(e);
  return msg.replace(/^execution reverted:\s*/i, "").split("\n")[0]!.slice(0, 200);
}

const escrowed = (db: DB, requestId: string) =>
  Boolean((db.prepare("SELECT hold_tx FROM holds WHERE request_id=?").get(requestId) as any)?.hold_tx);

/** Atomically move a hold out of 'held'. Returns false if it was already resolved (double-click / race with expiry). */
function transition(db: DB, requestId: string, to: "approved" | "denied" | "expired", requestStatus: string): boolean {
  return immediate(db, () => {
    const r = db.prepare("UPDATE holds SET status=?, token_used=1 WHERE request_id=? AND status='held'").run(to, requestId);
    if (r.changes === 0) return false;
    db.prepare("UPDATE requests SET status=? WHERE request_id=?").run(requestStatus, requestId);
    return true;
  });
}

export async function denyHold(db: DB, requestId: string): Promise<{ ok: boolean; refundTx: string | null }> {
  if (!transition(db, requestId, "denied", "denied")) return { ok: false, refundTx: null };
  let tx: string | null = null;
  if (!escrowed(db, requestId)) return { ok: true, refundTx: null }; // never reached Arc: nothing to refund
  try {
    tx = await vaultDeny(requestId);
  } catch (e) {
    console.error(`[deny ${requestId}] vault`, e); // funds still refund via refundExpired after expiry
  }
  if (tx) db.prepare("UPDATE holds SET resolve_tx=? WHERE request_id=?").run(tx, requestId);
  return { ok: true, refundTx: tx };
}

/** "NO 482913": cancel just the payment with that code (same sender rules as approveByText). */
export async function denyByTextCode(db: DB, phone: string, code: string): Promise<boolean> {
  ensureTextCols(db);
  const rows = (isOwnerPhone(db, phone)
    ? db.prepare(`${SELECT_HOLD} WHERE h.status='held'`).all()
    : db.prepare(`${SELECT_HOLD} JOIN notify n ON n.agent_id = r.agent_id WHERE h.status='held' AND n.phone = ?`).all(phone)) as any[];
  const match = rows.find((r) => r.text_code_hash && r.text_code_hash === codeHash(r.request_id, code));
  return match ? (await denyHold(db, match.request_id)).ok : false;
}

/** Deny every pending hold this number can see (a bare SMS "NO" has no request id). */
export async function denyLatestByPhone(db: DB, phone: string): Promise<{ ok: boolean; count: number }> {
  // The owner's number cancels across every agent; a per-agent number only cancels that agent's holds.
  const rows = isOwnerPhone(db, phone)
    ? (db.prepare(`${SELECT_HOLD} WHERE h.status='held' ORDER BY h.expires_ms DESC`).all() as any[])
    : (db.prepare(`${SELECT_HOLD} LEFT JOIN notify n ON n.agent_id = r.agent_id WHERE h.status='held' AND n.phone = ? ORDER BY h.expires_ms DESC`).all(phone) as any[]);
  let count = 0;
  for (const row of rows) if ((await denyHold(db, row.request_id)).ok) count++;
  return { ok: count > 0, count };
}

export async function expireHolds(db: DB) {
  const rows = db.prepare("SELECT request_id FROM holds WHERE status='held' AND expires_ms <= ?").all(Date.now()) as any[];
  for (const { request_id } of rows) {
    if (!transition(db, request_id, "expired", "expired")) continue;
    if (!escrowed(db, request_id)) continue; // never reached Arc: nothing to refund
    try {
      const tx = await vaultRefundExpired(request_id);
      if (tx) db.prepare("UPDATE holds SET resolve_tx=? WHERE request_id=?").run(tx, request_id);
    } catch (e) {
      console.error(`[expire ${request_id}] vault`, e);
    }
  }
}

// ---------------- Passkeys (WebAuthn) ----------------
// Single owner for the hackathon. TODO: Circle Modular Wallets (passkey-native) would let the
// passkey sign the vault approve() itself instead of gating a service-held owner key.

const CHALLENGE_TTL = 5 * 60_000;
const saveChallenge = (db: DB, key: string, challenge: string) =>
  db.prepare("INSERT OR REPLACE INTO challenges (key, challenge, created_ms) VALUES (?,?,?)").run(key, challenge, Date.now());
const takeChallenge = (db: DB, key: string): string | null => {
  const row = db.prepare("SELECT * FROM challenges WHERE key=?").get(key) as any;
  db.prepare("DELETE FROM challenges WHERE key=?").run(key);
  return row && Date.now() - row.created_ms < CHALLENGE_TTL ? row.challenge : null;
};
const passkeys = (db: DB) => db.prepare("SELECT * FROM passkeys").all() as any[];

export const hasPasskey = (db: DB) => passkeys(db).length > 0;

export async function registrationOptions(db: DB) {
  const opts = await generateRegistrationOptions({
    rpName: "Agent Firewall",
    rpID: config.webauthn.rpId,
    userName: "owner",
    attestationType: "none",
    excludeCredentials: passkeys(db).map((p) => ({ id: p.id })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  saveChallenge(db, "reg", opts.challenge);
  return opts;
}

export async function registerPasskey(db: DB, response: any) {
  // Only the first passkey can be enrolled freely. Adding more requires being the owner already.
  // TODO: gate additional enrollments behind an existing-passkey assertion.
  if (hasPasskey(db) && !config.devMode) throw new Error("A passkey is already registered.");
  const expectedChallenge = takeChallenge(db, "reg");
  if (!expectedChallenge) throw new Error("Registration expired. Try again.");
  const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: config.webauthn.origin, expectedRPID: config.webauthn.rpId, requireUserVerification: true });
  if (!v.verified) throw new Error("Passkey could not be verified.");
  const c = v.registrationInfo.credential;
  db.prepare("INSERT OR REPLACE INTO passkeys (id, public_key, counter, transports_json, created_at) VALUES (?,?,?,?,?)").run(
    c.id, Buffer.from(c.publicKey).toString("base64url"), c.counter, JSON.stringify(c.transports ?? []), new Date().toISOString(),
  );
  return { ok: true };
}

export async function approvalOptions(db: DB, token: string) {
  const hold = holdByToken(db, token);
  if (!hold || hold.status !== "held") throw new Error("This payment is no longer waiting for approval.");
  const keys = passkeys(db);
  if (keys.length === 0) throw new Error("No passkey set up yet. Add one on the Rules page first.");
  const opts = await generateAuthenticationOptions({
    rpID: config.webauthn.rpId,
    userVerification: "required",
    allowCredentials: keys.map((k) => ({ id: k.id, transports: JSON.parse(k.transports_json ?? "[]") })),
  });
  saveChallenge(db, `auth:${hashToken(token)}`, opts.challenge);
  return opts;
}

export async function approveWithPasskey(db: DB, token: string, assertion: any): Promise<{ ok: boolean; releaseTx: string | null }> {
  const hold = holdByToken(db, token);
  if (!hold || hold.status !== "held") throw new Error("This payment is no longer waiting for approval.");
  if (Date.parse(hold.expiresAt) <= Date.now()) throw new Error("This approval link has expired. The money was refunded.");
  if (arcStatus().vault && !hold.holdTx) throw new Error("This payment never reached the vault on Arc, so there is nothing to release. Cancel it instead.");
  const expectedChallenge = takeChallenge(db, `auth:${hashToken(token)}`);
  if (!expectedChallenge) throw new Error("Approval timed out. Try again.");
  const key = db.prepare("SELECT * FROM passkeys WHERE id=?").get(assertion?.id) as any;
  if (!key) throw new Error("Unknown passkey.");
  const v = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge,
    expectedOrigin: config.webauthn.origin,
    expectedRPID: config.webauthn.rpId,
    requireUserVerification: true,
    credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.public_key, "base64url")), counter: key.counter, transports: JSON.parse(key.transports_json ?? "[]") },
  });
  if (!v.verified) throw new Error("Passkey check failed.");
  db.prepare("UPDATE passkeys SET counter=? WHERE id=?").run(v.authenticationInfo.newCounter, key.id);
  return release(db, hold.requestId, "passkey");
}

/** Move a verified approval to 'approved' and release the escrow on Arc. Shared by passkey and text approval. */
async function release(db: DB, requestId: string, via: "passkey" | "text"): Promise<{ ok: boolean; releaseTx: string | null }> {
  if (!transition(db, requestId, "approved", "approved")) throw new Error("This payment was already handled.");
  ensureTextCols(db);
  db.prepare("UPDATE holds SET approved_via=? WHERE request_id=?").run(via, requestId);
  let tx: string | null = null;
  try {
    tx = await vaultApprove(requestId);
  } catch (e) {
    console.error(`[approve ${requestId}] vault`, e);
  }
  if (tx) db.prepare("UPDATE holds SET resolve_tx=? WHERE request_id=?").run(tx, requestId);
  return { ok: true, releaseTx: tx };
}

/**
 * "YES 482913" from the owner's phone. The code is per payment (only its hash is stored), the sender must be the
 * owner's number (or that agent's own number), the amount must be within the text-approval cap, and 5 wrong codes
 * lock text approval for the holds that number can see (passkey still works).
 */
export async function approveByText(db: DB, phone: string, code: string): Promise<{ ok: boolean; message: string; releaseTx?: string | null }> {
  ensureTextCols(db);
  const ta = getOwnerSettings(db).textApprove;
  if (!ta.enabled) return { ok: false, message: "Approving by text is turned off. Use your passkey on the dashboard." };
  const rows = (isOwnerPhone(db, phone)
    ? db.prepare(`${SELECT_HOLD} WHERE h.status='held'`).all()
    : db.prepare(`${SELECT_HOLD} JOIN notify n ON n.agent_id = r.agent_id WHERE h.status='held' AND n.phone = ?`).all(phone)) as any[];
  if (!rows.length) return { ok: false, message: "Nothing is waiting for you right now." };
  const live = rows.filter((r) => r.text_code_hash && r.text_attempts < MAX_TEXT_ATTEMPTS);
  const match = live.find((r) => {
    const a = Buffer.from(codeHash(r.request_id, code));
    const b = Buffer.from(r.text_code_hash);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!match) {
    for (const r of live) db.prepare("UPDATE holds SET text_attempts = text_attempts + 1 WHERE request_id=?").run(r.request_id);
    return { ok: false, message: live.length ? "That code doesn't match a waiting payment. Check the code in our text." : "Approving these by text isn't available. Use your passkey on the dashboard." };
  }
  if (match.amount_micro > ta.maxMicro) return { ok: false, message: `Payments over ${(ta.maxMicro / 1e6).toFixed(2)} USDC need your passkey in Wallet Buddy.` };
  if (match.expires_ms <= Date.now()) return { ok: false, message: "That payment expired and was refunded." };
  if (arcStatus().vault && !match.hold_tx) return { ok: false, message: "That payment never reached the vault on Arc, so there's nothing to release." };
  const r = await release(db, match.request_id, "text");
  return { ok: true, message: `Allowed: ${(match.amount_micro / 1e6).toFixed(2)} USDC to ${shortRecipient(match.recipient)}.${r.releaseTx ? " Released on Arc." : ""}`, releaseTx: r.releaseTx };
}
