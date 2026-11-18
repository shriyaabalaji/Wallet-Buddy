import { createHash, randomBytes } from "node:crypto";
import {
  evaluate,
  periodStart,
  validateRules,
  CATEGORIES,
  type Decision,
  type PaymentRequest,
  type Period,
  type Rule,
  type SpendState,
} from "@agent-firewall/policy";
import { ensureAgent, immediate, SPENDING_SQL, type DB } from "./db";
import { anomalyConfig, detectAnomalies, type AnomalyConfig } from "./anomaly";

export interface ActivePolicy {
  id: string;
  rules: Rule[];
  hash: string;
  committedTx: string | null;
  createdAt: string;
}

export function activePolicy(db: DB, agentId: string): ActivePolicy | null {
  const row = db.prepare("SELECT * FROM policies WHERE agent_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1").get(agentId) as any;
  if (!row) return null;
  return { id: row.id, rules: JSON.parse(row.rules_json), hash: row.hash, committedTx: row.committed_tx, createdAt: row.created_at };
}

/** Spend state computed from the ledger. Must be called inside the reservation transaction. */
export function spendState(db: DB, agentId: string, taskId: string, now: Date): SpendState {
  const sum = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as any).s ?? 0);
  const periodSpent = (p: Period) =>
    sum(`SELECT COALESCE(SUM(amount_micro),0) s FROM requests WHERE agent_id=? AND status IN ${SPENDING_SQL} AND created_ms >= ?`, agentId, periodStart(p, now).getTime());
  const agent = db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId) as any;
  return {
    taskSpentMicro: sum(`SELECT COALESCE(SUM(amount_micro),0) s FROM requests WHERE agent_id=? AND task_id=? AND status IN ${SPENDING_SQL}`, agentId, taskId),
    periodSpentMicro: { day: periodSpent("day"), week: periodSpent("week"), month: periodSpent("month") },
    requestsLastMinute: sum("SELECT COUNT(*) s FROM requests WHERE agent_id=? AND created_ms > ?", agentId, now.getTime() - 60_000),
    paused: agent?.status === "paused",
  };
}

export interface EvaluateResult {
  decision: Decision;
  /** Raw approval token, only returned for holds. Never logged. */
  holdToken?: string;
  expiresAt?: string;
  policyHash: string | null;
  duplicate: boolean;
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function parsePaymentRequest(body: any): PaymentRequest {
  const str = (k: string, max = 200) => {
    const v = body?.[k];
    if (typeof v !== "string" || v.length === 0 || v.length > max) throw new Error(`${k} must be a non-empty string (≤${max} chars)`);
    return v;
  };
  const amountMicro = body?.amountMicro;
  if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) throw new Error("amountMicro must be a positive integer (micro-USDC)");
  if (!(CATEGORIES as readonly string[]).includes(body?.category)) throw new Error(`category must be one of ${CATEGORIES.join(", ")}`);
  return {
    requestId: str("requestId", 100),
    agentId: str("agentId", 100),
    taskId: str("taskId", 100),
    recipient: str("recipient", 200),
    amountMicro,
    category: body.category,
    purpose: typeof body.purpose === "string" ? body.purpose.slice(0, 500) : "",
    sourceContext: typeof body.sourceContext === "string" ? body.sourceContext.slice(0, 200) : undefined,
  };
}

/**
 * Evaluate + reserve in ONE write transaction. This is the race-condition fix:
 * two $0.80 requests against $1.00 of budget serialize on BEGIN IMMEDIATE, so the
 * second one sees the first one's reservation and is blocked.
 */
export function evaluateAndReserve(db: DB, req: PaymentRequest, opts: { now?: Date; holdMinutes?: number; devMode?: boolean; anomaly?: AnomalyConfig } = {}): EvaluateResult {
  const now = opts.now ?? new Date();
  ensureAgent(db, req.agentId);
  return immediate(db, () => {
    const existing = db.prepare("SELECT * FROM requests WHERE request_id = ?").get(req.requestId) as any;
    if (existing) {
      // Idempotent replay: return the original decision; never re-reserve.
      return {
        decision: {
          requestId: req.requestId,
          outcome: existing.outcome,
          ruleId: existing.rule_id ?? undefined,
          reason: existing.reason,
          violations: JSON.parse(existing.violations_json),
          triggerPause: false,
          flags: JSON.parse(existing.flags_json),
          anomalies: JSON.parse(existing.anomalies_json ?? "[]"),
          at: existing.created_at,
        },
        policyHash: existing.policy_hash,
        duplicate: true,
      };
    }

    const policy = activePolicy(db, req.agentId);
    // No policy = deny by default. An agent with no rules can't spend.
    const rules: Rule[] = policy ? policy.rules : [];
    const state = spendState(db, req.agentId, req.taskId, now);
    // Same transaction, before this request's row exists: it never counts in its own baseline.
    const anomalies = detectAnomalies(db, req, rules, state, now, opts.anomaly ?? anomalyConfig);
    let decision: Decision = policy
      ? evaluate(rules, req, { ...state, anomalies }, { now })
      : { requestId: req.requestId, outcome: "block", ruleId: "no-policy", reason: "No rules saved yet. Set rules before the agent can spend.", violations: [], triggerPause: false, flags: [], anomalies, at: now.toISOString() };

    if (decision.triggerPause) {
      db.prepare("UPDATE agents SET status='paused', paused_reason=? WHERE id=?").run(decision.reason, req.agentId);
    }

    const status = decision.outcome === "allow" ? "reserved" : decision.outcome === "hold" ? "held" : "blocked";
    db.prepare(
      `INSERT INTO requests (request_id, agent_id, task_id, recipient, amount_micro, category, purpose, source_context, outcome, status, rule_id, reason, flags_json, violations_json, policy_hash, created_at, created_ms, anomalies_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      req.requestId, req.agentId, req.taskId, req.recipient, req.amountMicro, req.category, req.purpose, req.sourceContext ?? null,
      decision.outcome, status, decision.ruleId ?? null, decision.reason, JSON.stringify(decision.flags), JSON.stringify(decision.violations),
      policy?.hash ?? null, now.toISOString(), now.getTime(), JSON.stringify(decision.anomalies),
    );
    db.prepare("UPDATE agents SET current_task=? WHERE id=?").run(req.taskId, req.agentId);

    let holdToken: string | undefined;
    let expiresAt: string | undefined;
    if (decision.outcome === "hold") {
      holdToken = randomBytes(24).toString("base64url");
      const exp = new Date(now.getTime() + (opts.holdMinutes ?? 15) * 60_000);
      expiresAt = exp.toISOString();
      db.prepare("INSERT INTO holds (request_id, token_hash, dev_token, expires_at, expires_ms) VALUES (?,?,?,?,?)").run(
        req.requestId, hashToken(holdToken), opts.devMode ? holdToken : null, expiresAt, exp.getTime(),
      );
    }
    return { decision, holdToken, expiresAt, policyHash: policy?.hash ?? null, duplicate: false };
  });
}

/**
 * Agent (local-key) or payer.ts (circle-agent-wallet) reports the payment went through.
 * Under MOCK_PAYMENTS=1 the sellers accept any payment header, so nothing moved: the row is marked simulated.
 */
export function markSettled(db: DB, requestId: string, txHash?: string): boolean {
  const simulated = process.env.MOCK_PAYMENTS === "1" ? 1 : 0;
  const r = db
    .prepare("UPDATE requests SET status='settled', settled_tx=COALESCE(?, settled_tx), simulated=? WHERE request_id=? AND status='reserved'")
    .run(txHash ?? null, simulated, requestId);
  return r.changes > 0;
}

/**
 * Agent reports the payment failed. If the firewall never signed it, give the budget back.
 * If it DID sign, the seller holds a valid authorization and may already have settled it, so it stays counted as
 * "unconfirmed" until the owner reconciles it (fail closed: never overspend).
 */
export function markFailed(db: DB, requestId: string, failureReason?: string): boolean {
  const r = db
    .prepare("UPDATE requests SET status = CASE WHEN signed_ms IS NULL THEN 'released' ELSE 'unconfirmed' END, failure_reason = COALESCE(?, failure_reason) WHERE request_id=? AND status='reserved'")
    .run(failureReason ?? null, requestId);
  return r.changes > 0;
}

/**
 * Reservation timeout. An allowed payment that was never signed or paid (signed_ms IS NULL) and is older than ttlMs
 * gives its budget back: no money can have moved. A row with signed_ms set is NEVER released here, however old: it may
 * have been submitted or accepted, so it waits for an outcome report or owner reconciliation.
 *
 * `inFlight` = request ids a /pay call is working on right now. payWithCircle reads status='reserved', awaits the
 * seller's 402 probe, and only then claims signed_ms, so without this guard a release during that probe could be
 * followed by a payment the budget no longer counts. (/sign claims synchronously after its status check, so it has
 * no such window.) The guard is in-process: it relies on the firewall being one process. The claim in payer.ts also
 * requiring status='reserved' would make it hold across processes too.
 */
export function releaseStaleReservations(db: DB, opts: { now?: number; ttlMs: number; inFlight?: ReadonlySet<string> }): string[] {
  const now = opts.now ?? Date.now();
  const stale = db
    .prepare("SELECT request_id FROM requests WHERE status='reserved' AND signed_ms IS NULL AND created_ms < ?")
    .all(now - opts.ttlMs) as { request_id: string }[];
  const release = db.prepare(
    "UPDATE requests SET status='released', failure_reason=? WHERE request_id=? AND status='reserved' AND signed_ms IS NULL",
  );
  const reason = `Reservation expired unused after ${Math.round(opts.ttlMs / 60_000)} min (never signed or paid).`;
  const released: string[] = [];
  for (const { request_id } of stale) {
    if (opts.inFlight?.has(request_id)) continue;
    if (release.run(reason, request_id).changes > 0) released.push(request_id);
  }
  return released;
}

export type ReconcileOutcome = "paid" | "not_paid";
export class ReconcileError extends Error {}

/**
 * Owner resolves a payment whose outcome the firewall can't know: "unconfirmed", or signed but never reported.
 *   paid      → settled (counts, as before), with the owner's transaction reference if given
 *   not_paid  → released (budget returned). Only the owner can assert this, after checking the payer's history.
 * Unsigned reservations aren't uncertain (the timeout handles them) and settled/approved rows are already resolved.
 */
export function reconcilePayment(db: DB, requestId: string, outcome: ReconcileOutcome, opts: { txHash?: string; note?: string; now?: number; inFlight?: ReadonlySet<string> } = {}) {
  const now = opts.now ?? Date.now();
  // A payment still being made has no outcome yet; "not paid" now could release budget for money about to move.
  if (opts.inFlight?.has(requestId)) throw new ReconcileError("This payment is still being made. Try again once it finishes.");
  return immediate(db, () => {
    const row = db.prepare("SELECT status, signed_ms FROM requests WHERE request_id=?").get(requestId) as { status: string; signed_ms: number | null } | undefined;
    if (!row) throw new ReconcileError("Unknown payment request.");
    const uncertain = row.status === "unconfirmed" || (row.status === "reserved" && row.signed_ms !== null);
    if (!uncertain) throw new ReconcileError(`This payment is ${row.status}${row.status === "reserved" ? " and was never signed" : ""}; there is nothing to reconcile.`);
    const note = opts.note?.trim().slice(0, 200) || null;
    if (outcome === "paid") {
      db.prepare("UPDATE requests SET status='settled', settled_tx=COALESCE(?, settled_tx), reconciled_ms=?, failure_reason=COALESCE(?, failure_reason) WHERE request_id=?")
        .run(opts.txHash ?? null, now, note && `Owner reconciled as paid: ${note}`, requestId);
    } else {
      db.prepare("UPDATE requests SET status='released', reconciled_ms=?, failure_reason=? WHERE request_id=?")
        .run(now, `Owner reconciled as not paid${note ? `: ${note}` : "."}`, requestId);
    }
    return { status: outcome === "paid" ? "settled" : "released" };
  });
}

export function savePolicy(db: DB, agentId: string, rules: Rule[], hash: string): ActivePolicy {
  const { errors } = validateRules(rules);
  if (errors.length) throw new Error(errors.join("; "));
  ensureAgent(db, agentId);
  const id = `pol_${randomBytes(6).toString("hex")}`;
  const createdAt = new Date().toISOString();
  immediate(db, () => {
    db.prepare("UPDATE policies SET active=0 WHERE agent_id=?").run(agentId);
    db.prepare("INSERT INTO policies (id, agent_id, rules_json, hash, created_at) VALUES (?,?,?,?,?)").run(id, agentId, JSON.stringify(rules), hash, createdAt);
  });
  return { id, rules, hash, committedTx: null, createdAt };
}

export function setPaused(db: DB, agentId: string, paused: boolean, reason?: string) {
  ensureAgent(db, agentId);
  db.prepare("UPDATE agents SET status=?, paused_reason=? WHERE id=?").run(paused ? "paused" : "active", paused ? reason ?? "Paused by owner" : null, agentId);
}
