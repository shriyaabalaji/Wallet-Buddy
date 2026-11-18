// Shared types for the Agent Firewall.
// All money is integer micro-USDC (6 decimals): $1.00 === 1_000_000.

export const CATEGORIES = ["data", "inference", "compute", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Period = "day" | "week" | "month";

/** What happens when a rule is violated. "hold" escalates to a human instead of blocking. */
export type Severity = "block" | "hold";

interface RuleBase {
  id: string;
  /** Overrides the default severity for this rule kind (see DEFAULT_SEVERITY). */
  onViolation?: Severity;
}

export type Rule =
  | (RuleBase & { kind: "perTxLimit"; maxMicro: number })
  | (RuleBase & { kind: "taskBudget"; taskId: string; maxMicro: number })
  | (RuleBase & { kind: "periodBudget"; period: Period; maxMicro: number })
  | (RuleBase & { kind: "categories"; allowed: Category[] })
  | (RuleBase & { kind: "allowlist"; recipients: string[] }) // addresses or x402 service ids
  | (RuleBase & { kind: "timeWindow"; days: number[]; startHour: number; endHour: number; tz: string })
  | (RuleBase & { kind: "rateLimit"; maxPerMinute: number; action: "pause" })
  | (RuleBase & { kind: "approvalThreshold"; aboveMicro: number })
  | (RuleBase & { kind: "paused" })
  /**
   * Escalate (hold by default) when the firewall's anomaly detector reports a signal at or above minSeverity.
   * Without this rule anomalies are only recorded and shown to the owner; they never change a decision.
   * Like every hold, it never overrides a block.
   */
  | (RuleBase & { kind: "anomalyGuard"; minSeverity?: AnomalySeverity; signals?: AnomalyType[] });

export type RuleKind = Rule["kind"];

export const ANOMALY_TYPES = ["AMOUNT_SPIKE", "FREQUENCY_SPIKE", "NEW_RECIPIENT", "RAPID_BUDGET_DEPLETION", "REPEATED_DENIALS", "DUPLICATE_PATTERN"] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];
export const ANOMALY_SEVERITIES = ["low", "medium", "high"] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number];

/** One explainable anomaly signal for a proposed payment, measured against the agent's own prior activity. */
export interface AnomalySignal {
  type: AnomalyType;
  severity: AnomalySeverity;
  /** Plain-English reason for the owner. */
  explanation: string;
  /** The numbers behind the explanation (micro-USDC, counts, ms, percentages). */
  measured: Record<string, number | string | boolean>;
}

export interface Policy {
  id: string;
  agentId: string;
  rules: Rule[];
  hash: `0x${string}`;
  committedTx?: string;
  createdAt: string;
}

export interface PaymentRequest {
  requestId: string;
  agentId: string;
  taskId: string;
  recipient: string;
  amountMicro: number;
  category: Category;
  /** The agent's stated reason. Logged, NEVER trusted for decisions. */
  purpose: string;
  /** e.g. "after response from sportsfeed.x402". Used only to flag possible injection. */
  sourceContext?: string;
}

export type Outcome = "allow" | "block" | "hold";

export interface Violation {
  ruleId: string;
  kind: RuleKind;
  severity: Severity;
  reason: string;
}

export interface Decision {
  requestId: string;
  outcome: Outcome;
  /** The rule that decided the outcome (first blocking violation, else first hold). */
  ruleId?: string;
  reason: string;
  violations: Violation[];
  /** True when a rateLimit rule fired and the agent must be paused. */
  triggerPause: boolean;
  /** Heuristic flags for the human (e.g. possible injection). Never used to allow. */
  flags: string[];
  /** Anomaly signals the firewall measured for this request (empty when none were computed). Never used to allow. */
  anomalies: AnomalySignal[];
  at: string;
}

/** Spend state the evaluator needs. Computed by the store inside the same transaction as the reservation. */
export interface SpendState {
  /** Micro-USDC reserved or settled for this task (excludes released). */
  taskSpentMicro: number;
  /** Micro-USDC reserved or settled in the current calendar period (UTC). */
  periodSpentMicro: Record<Period, number>;
  /** Payment requests (any outcome) from this agent in the last 60s, excluding this one. */
  requestsLastMinute: number;
  /** Whether the agent is currently paused (emergency pause or rate-limit trip). */
  paused: boolean;
  /** Anomaly signals for this request, computed by the store from the ledger (optional; absent in dry runs). */
  anomalies?: AnomalySignal[];
}
