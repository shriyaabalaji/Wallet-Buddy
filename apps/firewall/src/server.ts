import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describeRule, enforcedBy, formatUsd, policyHash, shortRecipient, validateRules, type AnomalySignal, type Rule, type Violation } from "@agent-firewall/policy";
import { config, explorerTx } from "./config";
import { ensureAgent, type DB } from "./db";
import { ReconcileError, activePolicy, evaluateAndReserve, markFailed, markSettled, parsePaymentRequest, reconcilePayment, savePolicy, setPaused, spendState } from "./engine";
import { compileRules } from "./compiler";
import { defaultSamples, dryRun, type Sample } from "./dryrun";
import { arcStatus, commitPolicyOnArc, logDecisionsOnArc, vaultFunding } from "./arc";
import { fundingStatus } from "./funding";
import {
  approvalOptions,
  approveWithPasskey,
  denyHold,
  denyLatestByPhone,
  hasPasskey,
  holdByToken,
  onHold,
  pendingHolds,
  registerPasskey,
  registrationOptions,
} from "./approvals";
import { sendSms, smsConfigured, twiml, validTwilioSignature } from "./sms";
import { SignError, signForRequest } from "./signer";
import { PAY_NETWORK, PayError, network, payWithCircle, payerAddress, paymentMode } from "./payer";
import { authConfig, authenticate, authSummary, issueAgentKey, withIssuedKeys, type AuthConfig, type Principal } from "./auth";
import { activityFilter, hourlySeries, listAgents, settlementOf, todayTotals } from "./overview";
import { CATEGORIES as OPT_CATEGORIES } from "@agent-firewall/policy";
import { DEMO_PROVIDERS, fetchQuote, listRecommendations, optimizerResolve, recommend, saveRecommendation } from "./optimizer";
import { proofView } from "./proof";
import { injectionFlag } from "./injection";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Who may call a route (enforced in createApp before the handler runs):
 *   public        anyone; must not reveal anything sensitive
 *   owner         FIREWALL_OWNER_TOKEN only (the dashboard's server-side proxy)
 *   agent         an agent token; handlers check the agent owns the body agentId / payment row
 *   ownerOrAgent  owner, or an agent reading its own data
 *   settlement    the agent that owns the payment, or FIREWALL_SERVICE_TOKEN
 *   approvalLink  anyone holding the unguessable hold token from the SMS link (approving still needs the passkey)
 *   webhook       Twilio; verified by its request signature inside the handler
 */
type Access = "public" | "owner" | "agent" | "ownerOrAgent" | "settlement" | "approvalLink" | "webhook";
type Handler = (ctx: { db: DB; req: IncomingMessage; params: Record<string, string>; query: URLSearchParams; body: any; raw: string; who: Principal | null; auth: AuthConfig }) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; keys: string[]; access: Access; handler: Handler }[] = [];
const route = (method: string, path: string, access: Access, handler: Handler) => {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, access, handler });
};

const ROLES: Partial<Record<Access, Principal["kind"][]>> = {
  owner: ["owner"],
  agent: ["agent"],
  ownerOrAgent: ["owner", "agent"],
  settlement: ["agent", "service"],
};

/** Returns null when the caller may proceed, else the HTTP error to send. `who` null = no credential (legacy agents only). */
function authorize(access: Access, who: Principal | null | "invalid", auth: AuthConfig): HttpError | null {
  const roles = ROLES[access];
  if (!roles) return null;
  if (access === "owner" && !auth.owner) return new HttpError(503, "Owner access isn't configured on the firewall (FIREWALL_OWNER_TOKEN).");
  if (who === "invalid") return new HttpError(401, "Invalid credentials.");
  if (who === null) return access !== "owner" && auth.allowUnauthenticatedAgents ? null : new HttpError(401, "Authentication required.");
  return roles.includes(who.kind) ? null : new HttpError(403, "These credentials can't do that.");
}

/** An agent may only act for itself. Owner and service pass; legacy unauthenticated agents act as whoever they claim. */
function assertActsFor(who: Principal | null, agentId: string) {
  if (who?.kind === "agent" && who.agentId !== agentId) throw new HttpError(403, "This credential can't act for another agent.");
}

/** Payment routes identify a request only by id: check it belongs to the calling agent. Same answer for "missing" and "someone else's". */
function assertOwnsRequest(db: DB, who: Principal | null, requestId: string) {
  if (who?.kind !== "agent") return;
  const row = db.prepare("SELECT agent_id FROM requests WHERE request_id=?").get(requestId) as { agent_id: string } | undefined;
  if (row?.agent_id !== who.agentId) throw new HttpError(403, "Unknown payment request for this agent.");
}

/**
 * Emergency pause stops money that was already allowed, not just new requests: a reservation made before the pause
 * can't be signed or paid while the agent is paused (it stays reserved, and counts, until the owner resumes).
 * Checked by the request's own agent_id, so it holds for every caller, including legacy unauthenticated agents.
 * /sign: this check and the signer's signed_ms claim run in the same tick (no await between them), so a pause
 * can't slip in. /pay: payWithCircle (payer.ts) awaits the seller's 402 probe before its claim, so a pause landing
 * during that probe (one HTTP round trip) doesn't stop that one payment. Closing it needs the claim itself to require
 * an active agent, which is a payer.ts change.
 */
function assertAgentActive(db: DB, requestId: string) {
  const row = db.prepare("SELECT a.status FROM requests r JOIN agents a ON a.id = r.agent_id WHERE r.request_id=?").get(requestId) as { status: string } | undefined;
  if (row?.status === "paused") throw new HttpError(403, "This agent is paused. The owner must resume it before this payment can go through.");
}

// ---------- views ----------
function sentence(r: any): string {
  const amt = formatUsd(r.amount_micro);
  const to = shortRecipient(r.recipient);
  const what = r.purpose?.trim() ? r.purpose.trim() : `${r.category} from ${to}`;
  switch (r.status) {
    case "reserved":
    case "settled":
      return `Bought ${what.charAt(0).toLowerCase() + what.slice(1)}, ${amt}`;
    case "released":
      return `Tried to buy ${what.charAt(0).toLowerCase() + what.slice(1)}, ${amt}, but the payment didn't go through (budget returned)`;
    case "unconfirmed":
      if (typeof r.failure_reason === "string" && r.failure_reason.startsWith("Circle wallet policy")) return `Blocked ${amt} to ${to}: ${r.failure_reason}`;
      return `Payment for ${what.charAt(0).toLowerCase() + what.slice(1)}, ${amt}, failed after signing; still counted until you reconcile it`;
    case "blocked":
      return `Blocked ${amt} to ${to}: ${r.reason}`;
    case "held":
      return `Held ${amt} to ${to} and texted you`;
    case "approved":
      return `You approved ${amt} to ${to}`;
    case "denied":
      return `You cancelled ${amt} to ${to}. Refunded`;
    case "expired":
      return `${amt} to ${to} expired without approval. Refunded`;
    default:
      return `${amt} to ${to}`;
  }
}

function activityItem(r: any) {
  return {
    requestId: r.request_id,
    agentId: r.agent_id,
    at: r.created_at,
    outcome: r.outcome,
    status: r.status,
    amountMicro: r.amount_micro,
    recipient: r.recipient,
    category: r.category,
    taskId: r.task_id,
    ruleId: r.rule_id,
    reason: r.reason,
    sentence: sentence(r),
    purpose: r.purpose,
    flags: JSON.parse(r.flags_json),
    anomalies: JSON.parse(r.anomalies_json ?? "[]"),
    arcTx: r.hold_tx ?? r.arc_tx ?? null,
    arcTxUrl: explorerTx(r.hold_tx ?? r.arc_tx),
    decisionLogTx: r.arc_tx ?? null,
    decisionLogTxUrl: explorerTx(r.arc_tx),
    resolveTx: r.resolve_tx ?? null,
    resolveTxUrl: explorerTx(r.resolve_tx),
    // How much is actually known about the money (simulated, no reference, unverified reference, confirmed). Additive.
    settlement: settlementOf(r),
  };
}

// An agent never sees anomaly measurements: not the signals, and not an anomalyGuard reason built from their
// explanations ("$2.50 is 25× this agent's typical $0.10"). Either would show a hijacked agent how to stay just under
// each baseline. The owner sees both; the response shape is unchanged.
const ANOMALY_REASON = "Unusual activity for this agent. The owner can see the details.";
function redactAnomalies<T extends { ruleId?: string | null; reason: string; violations: Violation[] }>(d: T): T {
  const guards = new Set(d.violations.filter((v) => v.kind === "anomalyGuard").map((v) => v.ruleId));
  if (!guards.size) return d;
  return {
    ...d,
    reason: d.ruleId && guards.has(d.ruleId) ? ANOMALY_REASON : d.reason,
    violations: d.violations.map((v) => (v.kind === "anomalyGuard" ? { ...v, reason: ANOMALY_REASON } : v)),
  };
}
const redactRow = (r: any): string => redactAnomalies({ ruleId: r.rule_id, reason: r.reason, violations: JSON.parse(r.violations_json ?? "[]") }).reason;
const agentActivityItem = (r: any) => activityItem({ ...r, reason: redactRow(r), anomalies_json: "[]" });
function agentReason(db: DB, requestId: string, reason: string): string {
  const r = db.prepare("SELECT rule_id, reason, violations_json FROM requests WHERE request_id=?").get(requestId);
  return r ? redactRow(r) : reason;
}

const ACTIVITY_SQL = `SELECT r.*, h.hold_tx, h.resolve_tx FROM requests r LEFT JOIN holds h ON h.request_id = r.request_id`;
const ruleViews = (rules: Rule[]) => rules.map((r) => ({ ruleId: r.id, kind: r.kind, sentence: describeRule(r), enforcedBy: enforcedBy(r) }));
const policyView = (p: ReturnType<typeof activePolicy>) => p && { id: p.id, hash: p.hash, rules: p.rules, committedTx: p.committedTx, committedTxUrl: explorerTx(p.committedTx), createdAt: p.createdAt };

// ---------- routes ----------
route("GET", "/health", "public", async ({ db, who, auth }) => {
  // Liveness for anyone; balances, payer and integration details only for the owner.
  if (who?.kind !== "owner") return { ok: true };
  // Vault funding: hold() pulls from the treasury with transferFrom, so a spent allowance silently breaks escrow.
  let vault: { allowanceUsdc: number; treasuryUsdc: number; low: boolean } | { error: string } | null = null;
  try {
    const f = await vaultFunding();
    if (f) vault = { allowanceUsdc: f.allowanceMicro / 1e6, treasuryUsdc: f.balanceMicro / 1e6, low: Math.min(f.allowanceMicro, f.balanceMicro) < 5_000_000 };
  } catch (e) {
    vault = { error: e instanceof Error ? e.message.split("\n")[0]! : "unreadable" };
  }
  const buyer = await fundingStatus(db).catch((e) => ({ enabled: true, error: e instanceof Error ? e.message.split("\n")[0]! : "unreadable" }));
  return { ok: true, signer: payerAddress(), paymentMode, network, arc: arcStatus(), vault, buyer, twilio: smsConfigured(), llm: Boolean(config.llmApiKey), passkey: hasPasskey(db), auth: authSummary(auth),
    mockPayments: config.mockPayments, reservationTtlMinutes: config.reservationTtlMinutes };
});

route("GET", "/v1/agents/:agentId/summary", "ownerOrAgent", ({ db, params, who }) => {
  const { agentId } = params as { agentId: string };
  assertActsFor(who, agentId);
  const forOwner = who?.kind === "owner";
  // Viewing an agent never registers it (agents appear when they first pay, get rules, or are registered).
  const agent = requireAgent(db, agentId);
  const policy = activePolicy(db, agentId);
  const rules = policy?.rules ?? [];
  // null until the agent's first payment request names a task.
  const taskId: string | null = agent.current_task ?? null;
  const state = spendState(db, agentId, taskId ?? "", new Date());
  const task = rules.find((r) => r.kind === "taskBudget" && (r.taskId === "*" || r.taskId === taskId));
  const day = rules.find((r) => r.kind === "periodBudget" && r.period === "day");
  return {
    agent: { id: agent.id, name: agent.name, status: agent.status, pausedReason: agent.paused_reason },
    task: { id: taskId, spentMicro: taskId ? state.taskSpentMicro : 0, budgetMicro: task?.kind === "taskBudget" ? task.maxMicro : null },
    today: { spentMicro: state.periodSpentMicro.day, capMicro: day?.kind === "periodBudget" ? day.maxMicro : null },
    // Dev-mode hold tokens are for the owner's "Review" button only; an agent never sees one.
    // Agents also never see anomaly measurements (see redactAnomalies).
    pending: pendingHolds(db, agentId).map((h) => (forOwner ? h : { ...h, token: undefined, reason: agentReason(db, h.requestId, h.reason) })),
    recent: (db.prepare(`${ACTIVITY_SQL} WHERE r.agent_id=? ORDER BY r.created_ms DESC LIMIT 10`).all(agentId) as any[]).map(forOwner ? activityItem : agentActivityItem),
    rules: ruleViews(rules),
    policy: policyView(policy),
    passkey: hasPasskey(db),
    // Today (UTC, like the daily budget), by money state; and the last 8 hours. See overview.ts for the states.
    totals: todayTotals(db, agentId),
    series: hourlySeries(db, agentId),
  };
});

const AGENT_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
function requireAgent(db: DB, agentId: string) {
  const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(agentId) as any;
  if (!agent) throw new HttpError(404, `No agent "${agentId}" is registered.`);
  return agent;
}

route("GET", "/v1/agents", "owner", ({ db, auth }) => ({ agents: listAgents(db, auth) }));

// Registers an agent id in the firewall's own table. It does NOT create a wallet (payer.ts / Person 1) or a
// credential: the agent can't pay until rules are saved and FIREWALL_AGENT_TOKENS has a token for it.
route("POST", "/v1/agents", "owner", ({ db, body }) => {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!AGENT_ID_RE.test(id)) throw new HttpError(400, "Agent id: 1-100 letters, digits, dots, dashes, underscores or colons.");
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : id.replace(/-/g, " ");
  if (db.prepare("SELECT 1 FROM agents WHERE id=?").get(id)) throw new HttpError(409, `An agent "${id}" is already registered.`);
  ensureAgent(db, id, name);
  if (body?.issueKey !== true) return { agent: { id, name, status: "active" }, wallet: null, note: "Registered in the firewall only. No wallet or credential was created." };
  // Website signup: issue the agent's key now (shown once). All agents pay from the one configured payer (the Circle
  // Agent Wallet by default); each agent's own rules and budgets are enforced by the firewall before any payment.
  return { agent: { id, name, status: "active" }, key: issueAgentKey(db, id), wallet: { address: payerAddress(), mode: paymentMode, shared: true },
    note: "Copy this key now; it won't be shown again. Give it to your agent as FIREWALL_AGENT_TOKEN. It can't pay until you save rules." };
});

// Create a new key for an existing agent (lost or leaked key). The previous dashboard-issued key stops working.
route("POST", "/v1/agents/:agentId/key", "owner", ({ db, params }) => {
  const { agentId } = params as { agentId: string };
  requireAgent(db, agentId);
  return { agentId, key: issueAgentKey(db, agentId), note: "Copy this key now; it won't be shown again. The previous key no longer works." };
});

// Owner text-message settings on their own (no rules save, so no Arc re-commit).
route("POST", "/v1/agents/:agentId/notify", "owner", ({ db, params, body }) => {
  const agentId = params.agentId!;
  requireAgent(db, agentId);
  const raw = typeof body?.phone === "string" ? body.phone.trim() : "";
  if (raw && !/^\+[1-9]\d{7,14}$/.test(raw)) throw new HttpError(400, "Phone must be in international format, like +16045550100.");
  const events = Array.isArray(body?.events) ? [...new Set(body.events.filter((e: unknown) => ["hold", "budget80", "paused"].includes(e as string)))] : ["hold"];
  db.prepare("INSERT OR REPLACE INTO notify (agent_id, phone, events_json) VALUES (?,?,?)").run(agentId, raw || null, JSON.stringify(events));
  return { agentId, notify: { phone: raw || null, events } };
});

route("POST", "/v1/agents/:agentId/pause", "owner", async ({ db, params, body }) => {
  requireAgent(db, params.agentId!);
  setPaused(db, params.agentId!, true, typeof body?.reason === "string" ? body.reason : undefined);
  return { status: "paused" };
});
route("POST", "/v1/agents/:agentId/resume", "owner", ({ db, params }) => {
  requireAgent(db, params.agentId!);
  setPaused(db, params.agentId!, false);
  return { status: "active" };
});

// Filters (all optional): agentId (default research-agent, "all" for every agent), filter=blocked (legacy),
// status=paid|pending|held|blocked|returned, anomalies=1, requestId, limit (≤ 500).
route("GET", "/v1/activity", "owner", ({ db, query }) => {
  const { where, args, limit } = activityFilter(query);
  const rows = db.prepare(`${ACTIVITY_SQL} ${where} ORDER BY r.created_ms DESC LIMIT ?`).all(...args, limit) as any[];
  return { items: rows.map(activityItem) };
});

// Recent anomaly signals, one item per signal, newest first. Owner only: the measurements describe the agent's
// baselines. Uses the partial index requests_agent_anomalous.
route("GET", "/v1/agents/:agentId/anomalies", "owner", ({ db, params, query }) => {
  const limit = Math.max(1, Math.min(500, Number(query.get("limit") ?? 100) || 100));
  const sinceMs = Number(query.get("sinceMs") ?? 0) || 0;
  const rows = db
    .prepare(`SELECT request_id, agent_id, created_at, created_ms, outcome, status, amount_micro, recipient, task_id, anomalies_json FROM requests
      WHERE agent_id=? AND anomalies_json <> '[]' AND created_ms >= ? ORDER BY created_ms DESC LIMIT ?`)
    .all(params.agentId!, sinceMs, limit) as any[];
  const items = rows.flatMap((r) =>
    (JSON.parse(r.anomalies_json) as AnomalySignal[]).map((a) => ({
      requestId: r.request_id, agentId: r.agent_id, type: a.type, severity: a.severity, explanation: a.explanation, at: r.created_at,
      measured: a.measured, outcome: r.outcome, status: r.status, amountMicro: r.amount_micro, recipient: r.recipient, taskId: r.task_id,
    })),
  );
  return { items };
});

route("POST", "/v1/rules/compile", "owner", async ({ body }) => {
  const text = typeof body?.text === "string" ? body.text : "";
  const r = await compileRules(text);
  return { rules: r.rules, views: ruleViews(r.rules), ambiguities: r.ambiguities, model: r.model, errors: r.errors };
});

route("POST", "/v1/rules/dry-run", "owner", ({ db, body }) => {
  const agentId = typeof body?.agentId === "string" ? body.agentId : "research-agent";
  const { rules, errors } = validateRules(body?.rules);
  if (errors.length) throw new HttpError(400, errors.join("; "));
  const samples: Sample[] = Array.isArray(body?.samples) && body.samples.length ? body.samples : defaultSamples(rules);
  const agent = db.prepare("SELECT current_task FROM agents WHERE id=?").get(agentId) as any;
  const state = spendState(db, agentId, agent?.current_task ?? "", new Date());
  return { results: dryRun(rules, samples, state, agentId) };
});

route("GET", "/v1/policy/:agentId", "owner", ({ db, params }) => {
  const p = activePolicy(db, params.agentId!);
  const notify = db.prepare("SELECT * FROM notify WHERE agent_id=?").get(params.agentId!) as any;
  return { policy: policyView(p), views: ruleViews(p?.rules ?? []), notify: notify ? { phone: notify.phone, events: JSON.parse(notify.events_json) } : null };
});

route("POST", "/v1/policy", "owner", async ({ db, body }) => {
  if (body?.confirmed !== true) throw new HttpError(400, "Rules are only saved after you confirm them.");
  const agentId = typeof body?.agentId === "string" ? body.agentId : "research-agent";
  const { rules, errors } = validateRules(body?.rules);
  if (errors.length) throw new HttpError(400, errors.join("; "));
  const hash = policyHash(rules);
  const saved = savePolicy(db, agentId, rules, hash);
  if (body?.notify) {
    const phone = typeof body.notify.phone === "string" ? body.notify.phone.trim() : null;
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) throw new HttpError(400, "Phone must be in international format, e.g. +15125551234");
    const events = Array.isArray(body.notify.events) ? body.notify.events.filter((e: unknown) => ["hold", "budget80", "paused"].includes(e as string)) : ["hold"];
    db.prepare("INSERT OR REPLACE INTO notify (agent_id, phone, events_json) VALUES (?,?,?)").run(agentId, phone, JSON.stringify(events));
  }
  try {
    const tx = await commitPolicyOnArc(agentId, hash);
    if (tx) {
      db.prepare("UPDATE policies SET committed_tx=? WHERE id=?").run(tx, saved.id);
      saved.committedTx = tx;
    }
  } catch (e) {
    console.error("[commitPolicy]", e);
  }
  return { policy: policyView(saved), arcConfigured: arcStatus().registry };
});

// Agent-facing
route("POST", "/v1/payments/evaluate", "agent", async ({ db, body, who }) => {
  let req;
  try {
    req = parsePaymentRequest(body);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  assertActsFor(who, req.agentId);
  const t0 = performance.now();
  const before = spendState(db, req.agentId, req.taskId, new Date());
  const res = evaluateAndReserve(db, req, { holdMinutes: config.holdMinutes, devMode: config.devMode });
  if (!res.duplicate) db.prepare("UPDATE requests SET decision_ms=? WHERE request_id=? AND decision_ms IS NULL").run(Math.round((performance.now() - t0) * 100) / 100, req.requestId);
  // Prompt injection: does this request follow a seller response that carried payment instructions? The flag is
  // logged with the decision and texted to the owner; the rules above have already decided (it never loosens them).
  if (!res.duplicate) {
    const flag = injectionFlag(db, req.agentId, req.recipient, req.taskId);
    if (flag) {
      res.decision.flags = [...(res.decision.flags ?? []), flag];
      db.prepare("UPDATE requests SET flags_json=? WHERE request_id=?").run(JSON.stringify(res.decision.flags), req.requestId);
      if (res.decision.outcome === "block") void alertOwner(db, `Wallet Buddy blocked ${req.agentId}: ${formatUsd(req.amountMicro)} to ${shortRecipient(req.recipient)}. ${flag.replace(/^PROMPT_INJECTION: /, "Possible prompt injection: ")} Rule: ${res.decision.reason}`);
    }
  }
  // A replayed requestId returns the stored decision; don't hand another agent's decision back.
  if (res.duplicate) assertOwnsRequest(db, { kind: "agent", agentId: req.agentId }, req.requestId);
  if (!res.duplicate) {
    if (res.decision.outcome === "hold" && res.holdToken) void onHold(db, req.requestId, res.holdToken, res.expiresAt!);
    if (res.decision.triggerPause) void notifyEvent(db, req.agentId, "paused", `Your agent was paused: ${res.decision.reason} Reply PAUSE anytime to stop it, or resume it from the dashboard.`);
    if (res.decision.outcome === "allow") void maybeBudgetAlert(db, req.agentId, req.taskId, before.taskSpentMicro);
  }
  // The agent never receives the approval token, nor the anomaly measurements (they'd show a hijacked agent how
  // to stay just under each baseline). A hold's reason still says why.
  const { anomalies: _owner, ...decision } = res.decision;
  return { ...redactAnomalies(decision), duplicate: res.duplicate, policyHash: res.policyHash };
});
// Optimizer: advice only. It reads the providers' live 402 quotes (unpaid) and pre-checks your rules; it never
// reserves, signs or pays. The agent still calls /v1/payments/evaluate, and the payer re-checks the 402 terms.
route("POST", "/v1/optimizer/recommend", "ownerOrAgent", async ({ db, body, who }) => {
  const agentId = typeof body?.agentId === "string" ? body.agentId : "";
  const taskId = typeof body?.taskId === "string" && body.taskId ? body.taskId : "default";
  const need = body?.need ?? {};
  const maxAmountMicro = Number(body?.maxAmountMicro);
  if (!agentId) throw new HttpError(400, "agentId is required");
  if (typeof need.sku !== "string" || !need.sku) throw new HttpError(400, "need.sku is required");
  if (!(OPT_CATEGORIES as readonly string[]).includes(need.category)) throw new HttpError(400, `need.category must be one of ${OPT_CATEGORIES.join(", ")}`);
  if (!Number.isSafeInteger(maxAmountMicro) || maxAmountMicro <= 0) throw new HttpError(400, "maxAmountMicro must be a positive integer (micro-USDC)");
  if (need.fields !== undefined && !(Array.isArray(need.fields) && need.fields.every((f: unknown) => typeof f === "string"))) throw new HttpError(400, "need.fields must be a list of strings");
  assertActsFor(who, agentId);
  requireAgent(db, agentId);
  const requestId = typeof body?.requestId === "string" && body.requestId ? body.requestId : undefined;
  const baselineProviderId = typeof body?.baselineProviderId === "string" ? body.baselineProviderId : undefined;
  const base = process.env.SELLERS_URL ?? "http://localhost:4200";
  const compatible = DEMO_PROVIDERS.filter((p) => p.sku === need.sku);
  const quotes = await Promise.all(compatible.map((p) => fetchQuote(p, base, PAY_NETWORK)));
  const policy = activePolicy(db, agentId);
  const rec = recommend({ agentId, taskId, need, maxAmountMicro, baselineProviderId }, DEMO_PROVIDERS, quotes, {
    rules: policy?.rules ?? null, state: spendState(db, agentId, taskId, new Date()), now: Date.now(), resolve: optimizerResolve,
  });
  const id = saveRecommendation(db, rec, requestId);
  return { id, ...rec, sellersUrl: base };
});
route("GET", "/v1/optimizer/recommendations", "owner", ({ db, query }) => listRecommendations(db, query.get("agentId") ?? undefined));
// Onchain proof: public by design. Everything here is already public on Arc, plus aggregate ledger counts (no
// tokens, phones, purposes of other agents' payments beyond what the decision log already commits to).
route("GET", "/v1/proof", "public", ({ db, query }) => proofView(db, Math.min(Number(query.get("limit") ?? 300) || 300, 1000)));
// Owner: the last texts the firewall sent or would have sent (dry-run without Twilio). Phone numbers are masked.
route("GET", "/v1/notifications", "owner", ({ db, query }) => ({
  twilio: smsConfigured(),
  items: (db.prepare("SELECT direction, phone, body, at FROM sms_log ORDER BY id DESC LIMIT ?").all(Math.min(Number(query.get("limit") ?? 10) || 10, 50)) as any[])
    .map((r) => ({ ...r, phone: r.phone ? `…${String(r.phone).slice(-4)}` : null })),
}));
route("GET", "/v1/signer", "public", () => ({ address: payerAddress(), mode: paymentMode, network: PAY_NETWORK, arcNetwork: network }));
/**
 * Request ids a /pay call is working on. payWithCircle awaits the seller probe before it claims signed_ms, so the
 * reservation timeout and owner reconciliation skip these (engine.releaseStaleReservations / reconcilePayment).
 */
export const paymentsInFlight = new Set<string>();

// circle-agent-wallet mode: the firewall makes the paid request itself (see payer.ts).
route("POST", "/v1/payments/:requestId/pay", "agent", async ({ db, params, body, who }) => {
  assertOwnsRequest(db, who, params.requestId!);
  assertAgentActive(db, params.requestId!);
  if (typeof body?.url !== "string") throw new HttpError(400, "url is required");
  if (paymentsInFlight.has(params.requestId!)) throw new HttpError(409, "This payment is already being made.");
  paymentsInFlight.add(params.requestId!);
  try {
    return await payWithCircle(db, params.requestId!, body.url);
  } catch (e) {
    if (e instanceof PayError) throw new HttpError(e.circlePolicy ? 402 : 403, e.message);
    throw e;
  } finally {
    paymentsInFlight.delete(params.requestId!);
  }
});
route("POST", "/v1/payments/:requestId/sign", "agent", async ({ db, params, body, who }) => {
  assertOwnsRequest(db, who, params.requestId!);
  assertAgentActive(db, params.requestId!);
  try {
    return { signature: await signForRequest(db, params.requestId!, body?.typedData) };
  } catch (e) {
    if (e instanceof SignError) throw new HttpError(403, e.message);
    throw e;
  }
});
// Outcome reports. Today the agent itself reports these in local-key mode, so they accept the owning agent as well
// as FIREWALL_SERVICE_TOKEN. See README Safety limits.
// circle-agent-wallet mode records outcomes inside payer.ts, and an agent report there is an attack: /failed sent
// while /pay awaits the seller probe releases the reservation, the payment still goes through, and the spend
// stops counting. So in that mode only the service token may report.
function assertMayReport(db: DB, who: Principal | null, requestId: string) {
  if (paymentMode === "circle-agent-wallet" && who?.kind !== "service") throw new HttpError(403, "The firewall records payment outcomes itself in circle-agent-wallet mode.");
  assertOwnsRequest(db, who, requestId);
}
route("POST", "/v1/payments/:requestId/settled", "settlement", ({ db, params, body, who }) => {
  assertMayReport(db, who, params.requestId!);
  return { ok: markSettled(db, params.requestId!, typeof body?.txHash === "string" ? body.txHash : undefined) };
});
route("POST", "/v1/payments/:requestId/failed", "settlement", ({ db, params, who }) => {
  assertMayReport(db, who, params.requestId!);
  return { ok: markFailed(db, params.requestId!) };
});

// Owner resolves an uncertain outcome (unconfirmed, or signed and never reported). Never automatic: the firewall
// can't tell whether money moved, so only the owner, after checking the payer's history, can release that budget.
route("POST", "/v1/payments/:requestId/reconcile", "owner", ({ db, params, body }) => {
  const outcome = body?.outcome;
  if (outcome !== "paid" && outcome !== "not_paid") throw new HttpError(400, 'outcome must be "paid" or "not_paid"');
  const txHash = typeof body?.txHash === "string" && body.txHash.trim() ? body.txHash.trim().slice(0, 200) : undefined;
  try {
    return reconcilePayment(db, params.requestId!, outcome, { txHash, note: typeof body?.note === "string" ? body.note : undefined, inFlight: paymentsInFlight });
  } catch (e) {
    if (e instanceof ReconcileError) throw new HttpError(409, e.message);
    throw e;
  }
});

// Approvals
route("GET", "/v1/approvals/:token", "approvalLink", ({ db, params }) => {
  const h = holdByToken(db, params.token!);
  if (!h) throw new HttpError(404, "This link isn't valid.");
  return { ...h, passkeyReady: hasPasskey(db) };
});
route("POST", "/v1/approvals/:token/deny", "approvalLink", async ({ db, params }) => {
  const h = holdByToken(db, params.token!);
  if (!h) throw new HttpError(404, "This link isn't valid.");
  const r = await denyHold(db, h.requestId);
  if (!r.ok) throw new HttpError(409, `This payment was already ${h.status}.`);
  return { status: "denied", refundTx: r.refundTx, refundTxUrl: explorerTx(r.refundTx) };
});
route("POST", "/v1/approvals/:token/approve/options", "approvalLink", async ({ db, params }) => {
  try {
    return await approvalOptions(db, params.token!);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
});
route("POST", "/v1/approvals/:token/approve", "approvalLink", async ({ db, params, body }) => {
  try {
    const r = await approveWithPasskey(db, params.token!, body?.assertion);
    return { status: "approved", releaseTx: r.releaseTx, releaseTxUrl: explorerTx(r.releaseTx) };
  } catch (e) {
    throw new HttpError(403, (e as Error).message);
  }
});

// Owner passkey enrollment
route("POST", "/v1/owner/passkey/options", "owner", ({ db }) => registrationOptions(db));
route("POST", "/v1/owner/passkey", "owner", async ({ db, body }) => {
  try {
    return await registerPasskey(db, body?.response);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

// Twilio inbound SMS
route("POST", "/v1/twilio/inbound", "webhook", async ({ db, req, raw }) => {
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const url = config.publicUrl + (req.url ?? "");
  if (!validTwilioSignature(req.headers["x-twilio-signature"] as string | undefined, url, params)) throw new HttpError(403, "bad signature");
  const from = params.From ?? "";
  const text = (params.Body ?? "").trim().toUpperCase();
  db.prepare("INSERT INTO sms_log (direction, phone, body, at) VALUES ('in', ?, ?, ?)").run(from, params.Body ?? "", new Date().toISOString());
  let reply: string;
  if (/^(NO|N|STOP PAYMENT|CANCEL)\b/.test(text)) {
    const r = await denyLatestByPhone(db, from);
    reply = r.ok ? `Cancelled ${r.count === 1 ? "the payment" : `${r.count} payments`}. The money is going back to your wallet.` : "Nothing is waiting for you right now.";
  } else if (/^PAUSE\b/.test(text)) {
    const agents = db.prepare("SELECT agent_id FROM notify WHERE phone=?").all(from) as any[];
    const ids = agents.length ? agents.map((a) => a.agent_id) : from === config.twilio.ownerPhone ? ["research-agent"] : [];
    ids.forEach((id) => setPaused(db, id, true, "Paused by text message"));
    reply = ids.length ? "Your agent is paused. It can't spend anything until you resume it." : "We don't recognize this number.";
  } else if (/^(YES|Y|APPROVE|OK)\b/.test(text)) {
    reply = "To approve, open the link. Approving needs your passkey.";
  } else {
    reply = "Reply NO to cancel a held payment, or PAUSE to stop your agent. To approve, open the link we sent.";
  }
  return { __twiml: twiml(reply) };
});

// ---------- notifications ----------
/** Security alerts go to the owner's phone whenever one is set (no opt-in needed). Dry-run logs them without Twilio. */
async function alertOwner(db: DB, body: string) {
  const phone = config.twilio.ownerPhone ?? (db.prepare("SELECT phone FROM notify WHERE phone IS NOT NULL LIMIT 1").get() as any)?.phone;
  if (!phone) return console.log(`[alert] (no owner phone set) ${body}`);
  try {
    await sendSms(db, phone, body);
  } catch (e) {
    console.error("[alert]", e);
  }
}

async function notifyEvent(db: DB, agentId: string, event: "paused" | "budget80", body: string) {
  const n = db.prepare("SELECT * FROM notify WHERE agent_id=?").get(agentId) as any;
  const phone = n?.phone ?? config.twilio.ownerPhone;
  const events: string[] = n ? JSON.parse(n.events_json) : [];
  if (!phone || !events.includes(event)) return;
  try {
    await sendSms(db, phone, body);
  } catch (e) {
    console.error("[notify]", e);
  }
}

async function maybeBudgetAlert(db: DB, agentId: string, taskId: string, beforeMicro: number) {
  const p = activePolicy(db, agentId);
  const rule = p?.rules.find((r) => r.kind === "taskBudget" && (r.taskId === "*" || r.taskId === taskId));
  if (rule?.kind !== "taskBudget") return;
  const after = spendState(db, agentId, taskId, new Date()).taskSpentMicro;
  const line = rule.maxMicro * 0.8;
  if (beforeMicro < line && after >= line) await notifyEvent(db, agentId, "budget80", `Heads up: your agent has used ${formatUsd(after)} of its ${formatUsd(rule.maxMicro)} task budget.`);
}

// ---------- Arc decision log batcher ----------
export async function flushDecisionsToArc(db: DB) {
  if (!arcStatus().registry) return;
  const rows = db.prepare("SELECT request_id, agent_id, outcome, rule_id, amount_micro FROM requests WHERE arc_logged=0 ORDER BY created_ms LIMIT 50").all() as any[];
  const byAgent = new Map<string, any[]>();
  for (const r of rows) byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r]);
  for (const [agentId, items] of byAgent) {
    const ids = items.map((i) => i.request_id);
    const mark = db.prepare(`UPDATE requests SET arc_logged=?, arc_tx=COALESCE(?, arc_tx) WHERE request_id IN (${ids.map(() => "?").join(",")})`);
    mark.run(2, null, ...ids); // 2 = in flight
    try {
      const tx = await logDecisionsOnArc(agentId, items.map((i) => ({ requestId: i.request_id, outcome: i.outcome, ruleId: i.rule_id, amountMicro: i.amount_micro })));
      mark.run(1, tx, ...ids);
    } catch (e) {
      console.error("[arc log]", e);
      mark.run(0, null, ...ids);
    }
  }
}

// ---------- server ----------
// Browsers reach the firewall only through the dashboard's server-side proxy, so CORS is never "*".
// CORS is not authentication; every route is still checked by authorize().
function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", config.appBaseUrl);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function createApp(db: DB, auth: AuthConfig = authConfig) {
  // Last-resort guard: any error escaping the handler (e.g. the client aborting mid-body) must not crash the firewall.
  return createServer((req, res) =>
    void handle(db, auth, req, res).catch((e) => {
      console.error(`[${req.method} ${req.url}]`, e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Something went wrong on our side." }));
      else res.destroy();
    }),
  );
}

async function handle(db: DB, envAuth: AuthConfig, req: IncomingMessage, res: ServerResponse) {
  cors(res);
  const auth = withIssuedKeys(db, envAuth);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url ?? "/", "http://x");
  const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!match) return res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
  const presented = authenticate(req.headers.authorization, auth);
  const denied = authorize(match.access, presented, auth);
  if (denied) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (denied.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="agent-firewall"';
    return res.writeHead(denied.status, headers).end(JSON.stringify({ error: denied.message }));
  }
  // Legacy unauthenticated agent (testnet-only switch): no principal, handlers fall back to the claimed agentId.
  const who = presented === "invalid" ? null : presented;
  const m = url.pathname.match(match.re)!;
  let params: Record<string, string>;
  try {
    params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
  } catch {
    // Malformed %-escape. Uncaught here it would be an unhandled rejection and take the whole process down.
    return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad path" }));
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) return res.writeHead(413).end();
  }
  let body: any = undefined;
  if (raw && (req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      body = JSON.parse(raw);
    } catch {
      return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid JSON" }));
    }
  }
  try {
    const out: any = await match.handler({ db, req, params, query: url.searchParams, body, raw, who, auth });
    if (out && typeof out === "object" && "__twiml" in out) return res.writeHead(200, { "Content-Type": "text/xml" }).end(out.__twiml);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out ?? { ok: true }));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(`[${req.method} ${url.pathname}]`, e);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: status === 500 ? "Something went wrong on our side." : (e as Error).message }));
  }
}
