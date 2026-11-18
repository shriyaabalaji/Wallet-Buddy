import { formatUsd } from "./money";
import { ANOMALY_SEVERITIES, type AnomalySignal, type Decision, type PaymentRequest, type Rule, type RuleKind, type Severity, type SpendState, type Violation } from "./types";

/**
 * Default severity per rule kind.
 * - Budgets, limits, categories, time windows, rate limits, pause: hard block.
 * - Unknown recipient (allowlist): HOLD for a human. Money still can't move without the
 *   owner's passkey, and Circle's native allowlist (outer wall) only lets the agent wallet
 *   pay approved sellers or the ApprovalVault. Set onViolation: "block" to make it strict.
 * - approvalThreshold: hold, by definition.
 */
export const DEFAULT_SEVERITY: Record<RuleKind, Severity> = {
  paused: "block",
  rateLimit: "block",
  categories: "block",
  timeWindow: "block",
  perTxLimit: "block",
  taskBudget: "block",
  periodBudget: "block",
  allowlist: "hold",
  approvalThreshold: "hold",
  anomalyGuard: "hold",
};

export interface EvaluateOptions {
  now?: Date;
  /** Recipients that count as "known" for injection heuristics, in addition to allowlists. */
  knownRecipients?: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Pure policy evaluation. Collects every violation, then:
 *   any "block" violation → block (first one in rule order is reported)
 *   else any "hold" violation → hold
 *   else allow
 * The caller is responsible for doing this inside the same DB transaction as the reservation.
 */
export function evaluate(
  rules: Rule[],
  req: PaymentRequest,
  state: SpendState,
  opts: EvaluateOptions = {},
): Decision {
  const now = opts.now ?? new Date();
  const violations: Violation[] = [];
  let triggerPause = false;
  const amt = req.amountMicro;

  const v = (rule: Rule, reason: string) =>
    violations.push({ ruleId: rule.id, kind: rule.kind, severity: rule.onViolation ?? DEFAULT_SEVERITY[rule.kind], reason });

  const anomalies = state.anomalies ?? [];
  if (!Number.isSafeInteger(amt) || amt <= 0) {
    return finish(req, now, [{ ruleId: "input", kind: "perTxLimit", severity: "block", reason: "Amount must be a positive whole number of micro-USDC." }], false, [], anomalies);
  }

  if (state.paused) {
    violations.push({ ruleId: "paused", kind: "paused", severity: "block", reason: "Agent is paused." });
  }

  for (const rule of rules) {
    switch (rule.kind) {
      case "paused":
        v(rule, "Spending is paused by the owner.");
        break;
      case "perTxLimit":
        if (amt > rule.maxMicro) v(rule, `${formatUsd(amt)} is over the ${formatUsd(rule.maxMicro)} per-payment limit.`);
        break;
      case "taskBudget":
        if ((rule.taskId === "*" || rule.taskId === req.taskId) && state.taskSpentMicro + amt > rule.maxMicro) {
          const left = Math.max(0, rule.maxMicro - state.taskSpentMicro);
          v(rule, `Only ${formatUsd(left)} left of the ${formatUsd(rule.maxMicro)} task budget.`);
        }
        break;
      case "periodBudget": {
        const spent = state.periodSpentMicro[rule.period];
        if (spent + amt > rule.maxMicro) {
          const left = Math.max(0, rule.maxMicro - spent);
          v(rule, `Only ${formatUsd(left)} left of the ${formatUsd(rule.maxMicro)} ${periodLabel(rule.period)} budget.`);
        }
        break;
      }
      case "categories":
        if (!rule.allowed.includes(req.category)) v(rule, `"${req.category}" purchases aren't allowed (allowed: ${rule.allowed.join(", ")}).`);
        break;
      case "allowlist":
        if (!rule.recipients.map(norm).includes(norm(req.recipient))) v(rule, `${shortRecipient(req.recipient)} isn't on your approved list.`);
        break;
      case "timeWindow":
        if (!inWindow(rule, now)) v(rule, `Outside allowed spending hours (${windowLabel(rule)}).`);
        break;
      case "rateLimit":
        if (state.requestsLastMinute + 1 > rule.maxPerMinute) {
          triggerPause = true;
          v(rule, `More than ${rule.maxPerMinute} payments in a minute. Agent paused.`);
        }
        break;
      case "approvalThreshold":
        if (amt > rule.aboveMicro) v(rule, `${formatUsd(amt)} is over ${formatUsd(rule.aboveMicro)}, so it needs your OK.`);
        break;
      case "anomalyGuard": {
        const hit = guardedAnomalies(rule, anomalies);
        if (hit.length) v(rule, `Unusual activity: ${hit[0]!.explanation}${hit.length > 1 ? ` (+${hit.length - 1} more signal${hit.length > 2 ? "s" : ""})` : ""}`);
        break;
      }
      default: {
        const _exhaustive: never = rule;
        throw new Error(`unknown rule ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  return finish(req, now, violations, triggerPause, injectionFlags(rules, req, opts), anomalies);
}

const rank = (s: string) => ANOMALY_SEVERITIES.indexOf(s as (typeof ANOMALY_SEVERITIES)[number]);

/** Signals an anomalyGuard rule reacts to, most severe first. Default threshold: "high". */
export function guardedAnomalies(rule: Extract<Rule, { kind: "anomalyGuard" }>, anomalies: AnomalySignal[]): AnomalySignal[] {
  const min = rank(rule.minSeverity ?? "high");
  return anomalies
    .filter((a) => rank(a.severity) >= min && (!rule.signals?.length || rule.signals.includes(a.type)))
    .sort((a, b) => rank(b.severity) - rank(a.severity));
}

function finish(req: PaymentRequest, now: Date, violations: Violation[], triggerPause: boolean, flags: string[], anomalies: AnomalySignal[]): Decision {
  const block = violations.find((x) => x.severity === "block");
  // Prefer the allowlist reason for holds: "unknown recipient" tells the human more than "over $1".
  const hold = violations.find((x) => x.severity === "hold" && x.kind === "allowlist") ?? violations.find((x) => x.severity === "hold");
  const decider = block ?? hold;
  return {
    requestId: req.requestId,
    outcome: block ? "block" : hold ? "hold" : "allow",
    ruleId: decider?.ruleId,
    reason: decider?.reason ?? "Within all rules.",
    violations,
    triggerPause,
    flags,
    anomalies,
    at: now.toISOString(),
  };
}

/**
 * Heuristic: an unknown recipient requested right after reading a seller's response is the
 * classic prompt-injection shape. Only ever used to WARN the human; never to allow.
 */
function injectionFlags(rules: Rule[], req: PaymentRequest, opts: EvaluateOptions): string[] {
  const known = new Set((opts.knownRecipients ?? []).map(norm));
  for (const r of rules) if (r.kind === "allowlist") r.recipients.forEach((x) => known.add(norm(x)));
  const flags: string[] = [];
  const unknown = known.size > 0 && !known.has(norm(req.recipient));
  if (unknown && req.sourceContext) flags.push(/^after\b/i.test(req.sourceContext) ? `Requested right ${req.sourceContext}: possible injection.` : `Requested right after a seller response (${req.sourceContext}): possible injection.`);
  if (unknown && /^0x[0-9a-f]{40}$/i.test(req.recipient)) flags.push("Raw wallet address, not a known service.");
  return flags;
}

export function inWindow(rule: Extract<Rule, { kind: "timeWindow" }>, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: rule.tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  if (rule.days.length > 0 && !rule.days.includes(day)) return false;
  // endHour is exclusive. startHour > endHour wraps past midnight (e.g. 22 → 6).
  if (rule.startHour === rule.endHour) return true;
  return rule.startHour < rule.endHour ? hour >= rule.startHour && hour < rule.endHour : hour >= rule.startHour || hour < rule.endHour;
}

const periodLabel = (p: string) => ({ day: "daily", week: "weekly", month: "monthly" })[p] ?? p;

function windowLabel(r: Extract<Rule, { kind: "timeWindow" }>): string {
  const h = (n: number) => `${((n + 11) % 12) + 1}${n < 12 ? "am" : "pm"}`;
  return `${h(r.startHour)}–${h(r.endHour)} ${r.tz}`;
}

export function shortRecipient(r: string): string {
  return /^0x[0-9a-f]{40}$/i.test(r) ? `${r.slice(0, 6)}…${r.slice(-4)}` : r;
}
