// Explainable anomaly signals for a proposed payment, measured against the agent's own history in the `requests`
// ledger. No model, no second ledger: a handful of indexed queries and integer micro-USDC arithmetic.
//
// Called by evaluateAndReserve INSIDE its BEGIN IMMEDIATE transaction and BEFORE the current request is inserted, so
//   - the current payment is never part of its own baseline, and
//   - concurrent requests serialize: each one sees every earlier request's row (no racing past a frequency check).
//
// Signals only describe; they never allow. They change a decision only through an `anomalyGuard` rule, which holds
// (or blocks, with onViolation: "block") and, like every hold, never overrides a block. Without that rule they are
// recorded on the request (requests.anomalies_json) and shown to the owner.
//
// Insufficient history: an agent with fewer than MIN_HISTORY prior paid requests has no meaningful baseline, so the
// relative checks fall back to fixed absolute thresholds (all documented in DEFAULTS below):
//   AMOUNT_SPIKE      only the absolute threshold applies (AMOUNT_ABSOLUTE_MICRO)
//   FREQUENCY_SPIKE   only the absolute count applies (FREQUENCY_MIN_COUNT per window)
//   NEW_RECIPIENT     reported as "low" (everything is new to a new agent), except raw 0x addresses outside the
//                     allowlist, which stay "high"
// The other signals (depletion, denials, duplicates) use absolute thresholds and need no baseline.
import type { AnomalySeverity, AnomalySignal, PaymentRequest, Period, Rule, SpendState } from "@agent-firewall/policy";
import { formatUsd, periodStart, shortRecipient } from "@agent-firewall/policy";
import type { DB } from "./db";

export const ANOMALY_DEFAULTS = {
  /** Prior paid requests needed before relative (baseline) checks apply. */
  MIN_HISTORY: 5,
  /** Baseline: the agent's most recent N paid amounts. */
  BASELINE_SIZE: 50,
  /** AMOUNT_SPIKE: amount >= RATIO × median (medium), >= HIGH_RATIO × median (high), and at least MIN_DELTA above it. */
  AMOUNT_SPIKE_RATIO: 5,
  AMOUNT_SPIKE_HIGH_RATIO: 20,
  AMOUNT_MIN_DELTA_MICRO: 500_000, // $0.50: a jump from 1¢ to 5¢ isn't worth anyone's attention
  /** AMOUNT_SPIKE: any single payment at or above this is unusual regardless of history (medium). */
  AMOUNT_ABSOLUTE_MICRO: 2_000_000, // $2.00
  /** FREQUENCY_SPIKE: requests in the rolling window vs. the agent's average rate over the lookback before it. */
  FREQUENCY_WINDOW_MS: 60_000,
  FREQUENCY_LOOKBACK_MS: 3_600_000,
  FREQUENCY_MIN_COUNT: 10, // never flag fewer than this many in one window
  FREQUENCY_RATIO: 4, // and at least 4× the usual rate (when there is history)
  /** RAPID_BUDGET_DEPLETION: spend in the window (incl. this payment) as a share of what was left of a budget. */
  DEPLETION_WINDOW_MS: 600_000,
  DEPLETION_PCT: 50,
  DEPLETION_HIGH_PCT: 80,
  DEPLETION_MIN_MICRO: 250_000, // $0.25: ignore tiny absolute amounts
  /** REPEATED_DENIALS: blocked requests in the window before this one. */
  DENIAL_WINDOW_MS: 600_000,
  DENIAL_COUNT: 3,
  /** DUPLICATE_PATTERN: prior requests with the same task, recipient, amount and purpose in the window. */
  DUPLICATE_WINDOW_MS: 600_000,
  DUPLICATE_COUNT: 5,
};
export type AnomalyConfig = typeof ANOMALY_DEFAULTS;

/** Each default can be overridden with ANOMALY_<NAME> (a positive integer). Bad values keep the default and warn. */
export function loadAnomalyConfig(env: Record<string, string | undefined> = process.env, warn: (m: string) => void = console.warn): AnomalyConfig {
  const cfg = { ...ANOMALY_DEFAULTS };
  for (const k of Object.keys(cfg) as (keyof AnomalyConfig)[]) {
    const raw = env[`ANOMALY_${k}`];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) cfg[k] = n;
    else warn(`[anomaly] ANOMALY_${k}=${raw} is not a positive integer; using ${cfg[k]}.`);
  }
  return cfg;
}
export const anomalyConfig = loadAnomalyConfig();

// Statuses that mean money moved or is committed (same set budgets count, minus "held": a hold isn't a payment yet).
const PAID = `('reserved','settled','approved','unconfirmed')`;
const norm = (s: string) => s.trim().toLowerCase();
const isAddress = (s: string) => /^0x[0-9a-f]{40}$/i.test(s);
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;
const pct = (part: number, whole: number) => Math.floor((part * 100) / whole);
const PERIOD_LABEL: Record<Period, string> = { day: "daily", week: "weekly", month: "monthly" };

/** Integer median of a sorted list (lower middle for even counts, so no fractions). */
const median = (sorted: number[]) => sorted[Math.floor((sorted.length - 1) / 2)]!;

export function detectAnomalies(db: DB, req: PaymentRequest, rules: Rule[], state: SpendState, now: Date, cfg: AnomalyConfig = anomalyConfig): AnomalySignal[] {
  const t = now.getTime();
  const one = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T;
  const count = (sql: string, ...args: (string | number)[]) => Number(one<{ n: number }>(sql, ...args).n);
  const out: AnomalySignal[] = [];
  const add = (type: AnomalySignal["type"], severity: AnomalySeverity, explanation: string, measured: AnomalySignal["measured"]) =>
    out.push({ type, severity, explanation, measured });

  // ---- baseline: the agent's recent paid amounts (the current request isn't in the ledger yet) ----
  const amounts = (db
    .prepare(`SELECT amount_micro a FROM requests WHERE agent_id=? AND status IN ${PAID} ORDER BY created_ms DESC LIMIT ?`)
    .all(req.agentId, cfg.BASELINE_SIZE) as { a: number }[]).map((r) => Number(r.a)).sort((x, y) => x - y);
  const hasHistory = amounts.length >= cfg.MIN_HISTORY;

  // ---- 1. AMOUNT_SPIKE ----
  const amt = req.amountMicro;
  if (hasHistory) {
    const med = median(amounts);
    const ratioX100 = med > 0 ? Math.floor((amt * 100) / med) : 0;
    if (amt - med >= cfg.AMOUNT_MIN_DELTA_MICRO && amt >= med * cfg.AMOUNT_SPIKE_RATIO) {
      const high = amt >= med * cfg.AMOUNT_SPIKE_HIGH_RATIO;
      add("AMOUNT_SPIKE", high ? "high" : "medium", `${formatUsd(amt)} is ${Math.floor(ratioX100 / 100)}× this agent's typical payment of ${formatUsd(med)}.`, {
        amountMicro: amt, medianMicro: med, ratioX100, sampleSize: amounts.length, basis: "history",
      });
    }
  }
  if (!out.some((a) => a.type === "AMOUNT_SPIKE") && amt >= cfg.AMOUNT_ABSOLUTE_MICRO) {
    add("AMOUNT_SPIKE", "medium", `${formatUsd(amt)} is at or above the ${formatUsd(cfg.AMOUNT_ABSOLUTE_MICRO)} large-payment threshold${hasHistory ? "" : " (not enough history to compare)"}.`, {
      amountMicro: amt, thresholdMicro: cfg.AMOUNT_ABSOLUTE_MICRO, sampleSize: amounts.length, basis: "absolute",
    });
  }

  // ---- 2. FREQUENCY_SPIKE: this window vs. the agent's average rate in the lookback before it ----
  const inWindow = count(`SELECT COUNT(*) n FROM requests WHERE agent_id=? AND created_ms > ?`, req.agentId, t - cfg.FREQUENCY_WINDOW_MS) + 1; // + this one
  const lookback = count(`SELECT COUNT(*) n FROM requests WHERE agent_id=? AND created_ms > ? AND created_ms <= ?`, req.agentId, t - cfg.FREQUENCY_WINDOW_MS - cfg.FREQUENCY_LOOKBACK_MS, t - cfg.FREQUENCY_WINDOW_MS);
  const windows = Math.max(1, Math.floor(cfg.FREQUENCY_LOOKBACK_MS / cfg.FREQUENCY_WINDOW_MS));
  // Relative test in integers: inWindow / 1 >= RATIO × (lookback / windows)  ⇔  inWindow × windows >= RATIO × lookback.
  const usesBaseline = lookback >= cfg.MIN_HISTORY;
  if (inWindow >= cfg.FREQUENCY_MIN_COUNT && (!usesBaseline || inWindow * windows >= cfg.FREQUENCY_RATIO * lookback)) {
    const high = inWindow >= 2 * cfg.FREQUENCY_MIN_COUNT && (!usesBaseline || inWindow * windows >= 2 * cfg.FREQUENCY_RATIO * lookback);
    const usualX100 = Math.floor((lookback * 100) / windows);
    add("FREQUENCY_SPIKE", high ? "high" : "medium",
      usesBaseline
        ? `${inWindow} payment requests in the last ${Math.round(cfg.FREQUENCY_WINDOW_MS / 1000)}s, against a usual ${(usualX100 / 100).toFixed(2)} per ${Math.round(cfg.FREQUENCY_WINDOW_MS / 1000)}s.`
        : `${inWindow} payment requests in the last ${Math.round(cfg.FREQUENCY_WINDOW_MS / 1000)}s (threshold ${cfg.FREQUENCY_MIN_COUNT}; not enough history to compare).`,
      { requestsInWindow: inWindow, windowMs: cfg.FREQUENCY_WINDOW_MS, usualPerWindowX100: usualX100, lookbackRequests: lookback, basis: usesBaseline ? "history" : "absolute" });
  }

  // ---- 3. NEW_RECIPIENT: never paid before by this agent (the allowlist rule is untouched and still applies) ----
  const r = norm(req.recipient);
  const paidBefore = count(`SELECT COUNT(*) n FROM requests WHERE agent_id=? AND lower(recipient)=? AND status IN ${PAID}`, req.agentId, r) > 0;
  if (!paidBefore) {
    const allowed = rules.some((x) => x.kind === "allowlist" && x.recipients.map(norm).includes(r));
    const severity: AnomalySeverity = allowed ? "low" : isAddress(r) ? "high" : amounts.length === 0 ? "low" : "medium";
    const why = allowed ? "it's on your approved list" : isAddress(r) ? "it's a raw wallet address you haven't approved" : amounts.length === 0 ? "this agent has no payment history yet" : "it isn't on your approved list";
    add("NEW_RECIPIENT", severity, `First payment to ${shortRecipient(req.recipient)} by this agent; ${why}.`, {
      recipient: req.recipient, onAllowlist: allowed, rawAddress: isAddress(r), priorPaidRequests: amounts.length,
    });
  }

  // ---- 4. RAPID_BUDGET_DEPLETION: recent spend as a share of what was left of a budget ----
  const since = t - cfg.DEPLETION_WINDOW_MS;
  const recentTask = count(`SELECT COALESCE(SUM(amount_micro),0) n FROM requests WHERE agent_id=? AND task_id=? AND status IN ${PAID} AND created_ms > ?`, req.agentId, req.taskId, since);
  // A period budget only counts spend since its own reset (just after UTC midnight, yesterday's burst isn't today's).
  const recentInPeriod = (p: Period) =>
    count(`SELECT COALESCE(SUM(amount_micro),0) n FROM requests WHERE agent_id=? AND status IN ${PAID} AND created_ms > ? AND created_ms >= ?`, req.agentId, since, periodStart(p, now).getTime());
  const budgets: { label: string; max: number; spent: number; recent: number }[] = [];
  for (const rule of rules) {
    if (rule.kind === "taskBudget" && (rule.taskId === "*" || rule.taskId === req.taskId)) budgets.push({ label: "task", max: rule.maxMicro, spent: state.taskSpentMicro, recent: recentTask });
    if (rule.kind === "periodBudget") budgets.push({ label: PERIOD_LABEL[rule.period], max: rule.maxMicro, spent: state.periodSpentMicro[rule.period], recent: recentInPeriod(rule.period) });
  }
  let worst: { severity: AnomalySeverity; share: number; b: (typeof budgets)[number]; remaining: number; burst: number } | null = null;
  for (const b of budgets) {
    const remaining = b.max - b.spent;
    const burst = b.recent + amt;
    // Exhausted, or this payment alone exceeds what's left: the budget rule blocks it; that's not an anomaly.
    if (remaining <= 0 || amt > remaining || burst < cfg.DEPLETION_MIN_MICRO) continue;
    const share = pct(burst, remaining);
    if (share < cfg.DEPLETION_PCT || (worst && share <= worst.share)) continue;
    worst = { severity: share >= cfg.DEPLETION_HIGH_PCT ? "high" : "medium", share, b, remaining, burst };
  }
  if (worst) {
    // At the burst's pace, how long until the rest of the budget is gone (whole minutes, floor).
    const left = Math.max(0, worst.remaining - amt);
    const minutesToEmpty = Math.floor((left * cfg.DEPLETION_WINDOW_MS) / worst.burst / 60_000);
    add("RAPID_BUDGET_DEPLETION", worst.severity,
      `${formatUsd(worst.burst)} in the last ${mins(cfg.DEPLETION_WINDOW_MS)} (including this payment) is ${worst.share}% of the ${formatUsd(worst.remaining)} left in the ${worst.b.label} budget.`,
      { budget: worst.b.label, budgetMicro: worst.b.max, remainingMicro: worst.remaining, windowSpendMicro: worst.burst, sharePct: worst.share, windowMs: cfg.DEPLETION_WINDOW_MS, minutesToEmptyAtThisPace: minutesToEmpty });
  }

  // ---- 5. REPEATED_DENIALS: recent requests the policy engine blocked, or the owner refused (denied holds) ----
  const rejected = one<{ blocked: number; denied: number }>(
    `SELECT COALESCE(SUM(outcome='block'),0) blocked, COALESCE(SUM(status='denied'),0) denied FROM requests WHERE agent_id=? AND created_ms > ?`,
    req.agentId, t - cfg.DENIAL_WINDOW_MS,
  );
  const blocked = Number(rejected.blocked);
  const ownerDenied = Number(rejected.denied);
  const denials = blocked + ownerDenied;
  if (denials >= cfg.DENIAL_COUNT) {
    const what = ownerDenied === 0 ? "were blocked" : blocked === 0 ? "were refused by you" : `were blocked or refused by you (${blocked} blocked, ${ownerDenied} refused)`;
    add("REPEATED_DENIALS", denials >= 2 * cfg.DENIAL_COUNT ? "high" : "medium", `${denials} of this agent's payment requests ${what} in the last ${mins(cfg.DENIAL_WINDOW_MS)}, and it is still trying.`, {
      rejectedInWindow: denials, blockedInWindow: blocked, ownerDeniedInWindow: ownerDenied, windowMs: cfg.DENIAL_WINDOW_MS,
    });
  }

  // ---- 6. DUPLICATE_PATTERN: the same purchase over and over (requestId replays never get here: they're idempotent) ----
  // Keyed on task + recipient + amount only. `purpose` is written by the agent and never trusted: rewording it each
  // time must not hide a repeat. It's reported, not matched.
  const dup = one<{ n: number; purposes: number }>(
    `SELECT COUNT(*) n, COUNT(DISTINCT purpose) purposes FROM requests WHERE agent_id=? AND task_id=? AND lower(recipient)=? AND amount_micro=? AND outcome<>'block' AND created_ms > ?`,
    req.agentId, req.taskId, r, amt, t - cfg.DUPLICATE_WINDOW_MS,
  );
  const dupes = Number(dup.n);
  if (dupes >= cfg.DUPLICATE_COUNT) {
    add("DUPLICATE_PATTERN", dupes >= 2 * cfg.DUPLICATE_COUNT ? "medium" : "low", `This agent already made ${dupes} identical ${formatUsd(amt)} purchases from ${shortRecipient(req.recipient)} for this task in the last ${mins(cfg.DUPLICATE_WINDOW_MS)}.`, {
      identicalInWindow: dupes, distinctPurposes: Number(dup.purposes), windowMs: cfg.DUPLICATE_WINDOW_MS, taskId: req.taskId, purpose: req.purpose,
    });
  }

  return out;
}
