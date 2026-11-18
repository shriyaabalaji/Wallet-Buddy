import type { AnomalySignal, Rule } from "@agent-firewall/policy";

// The browser talks only to this dashboard's server-side proxy (app/api/fw), which holds the owner token.
// Never call the firewall directly from the browser, and never put a firewall token in NEXT_PUBLIC_*.
const PROXY = "/api/fw";
/** The demo agent id; only used to prefill "Register an agent". Pages use the selected agent (lib/agents.tsx). */
export const DEFAULT_AGENT_ID = "research-agent";
// TODO(verify): Arc explorer base URL (HANDOFF §10). Only used if the API returns a tx hash without a URL.
export const ARC_EXPLORER = (process.env.NEXT_PUBLIC_ARC_EXPLORER ?? "https://explorer.testnet.arc.io").replace(/\/$/, "");

export type Outcome = "allow" | "block" | "hold";

export type ActivityItem = {
  requestId: string;
  agentId: string;
  at: string;
  outcome: Outcome;
  status: string;
  amountMicro: number;
  recipient: string;
  category: string;
  taskId: string;
  ruleId: string | null;
  reason: string;
  sentence: string;
  purpose: string;
  flags: string[];
  anomalies: AnomalySignal[];
  /** Arc tx from our own contracts: the vault hold if there was one, else the batched decision log. */
  arcTx: string | null;
  arcTxUrl: string | null;
  /** Vault refund or release tx for a held payment. */
  resolveTx?: string | null;
  resolveTxUrl?: string | null;
  /** What is actually known about the money (firewall overview.ts settlementOf). Missing from older firewalls. */
  settlement?: Settlement;
};

export type SettlementState =
  | "pending_signature" | "awaiting_outcome" | "uncertain" | "simulated" | "accepted_no_reference" | "accepted_with_reference"
  | "confirmed_onchain" | "approved_unrecorded" | "held" | "not_paid";
export type Settlement = {
  state: SettlementState;
  label: string;
  reference: string | null;
  /** True only for a transaction the firewall itself sent and saw succeed on Arc (a vault release). */
  verifiedOnchain: boolean;
  simulated: boolean;
  needsReconciliation: boolean;
  reconciledByOwner: boolean;
};

/** Today's money by state (UTC day). "paid" = Gateway accepted or vault released; never an onchain settlement claim. */
export type Totals = {
  paidMicro: number;
  inProgressMicro: number;
  heldMicro: number;
  stoppedMicro: number;
  counts: { requests: number; allowed: number; held: number; blocked: number; ownerApproved: number };
  anomalies: { flaggedRequests: number; high: number };
  /** paidMicro / inProgressMicro split by evidence. Only confirmedOnchainMicro is verified; simulatedMicro is no money. */
  evidence?: {
    simulatedMicro: number; acceptedNoReferenceMicro: number; acceptedWithReferenceMicro: number; confirmedOnchainMicro: number; approvedUnrecordedMicro: number;
    pendingSignatureMicro: number; awaitingOutcomeMicro: number; uncertainMicro: number; uncertainCount: number;
  };
};
export type SeriesBucket = { start: string; paidMicro: number; inProgressMicro: number; stoppedMicro: number; paid: number; inProgress: number; stopped: number };

export type AgentListItem = {
  id: string;
  name: string;
  status: "active" | "paused";
  pausedReason: string | null;
  currentTask: string | null;
  createdAt: string;
  hasPolicy: boolean;
  policyHash: string | null;
  credentialConfigured: boolean;
  today: Totals;
  budget: { daySpentMicro: number; dayCapMicro: number | null; dayAvailableMicro: number | null; taskSpentMicro: number; taskBudgetMicro: number | null; taskAvailableMicro: number | null };
  pendingApprovals: number;
  anomalies24h: { requests: number; high: number };
};

export type AnomalyItem = {
  requestId: string; agentId: string; type: AnomalySignal["type"]; severity: AnomalySignal["severity"]; explanation: string; at: string;
  measured: AnomalySignal["measured"]; outcome: Outcome; status: string; amountMicro: number; recipient: string; taskId: string;
};

/** The owner view of GET /health. Every field may be missing or null when that integration isn't configured. */
export type Health = {
  ok: boolean;
  signer?: string | null;
  paymentMode?: "local-key" | "circle-agent-wallet";
  network?: "testnet" | "mainnet";
  arc?: { registry: boolean; vault: boolean; ownerKey: boolean };
  vault?: { allowanceUsdc: number; treasuryUsdc: number; low: boolean } | { error: string } | null;
  buyer?: { enabled: false } | { enabled: true; error: string } | { enabled: true; payer: string; dailyCapUsdc: number; depositedTodayUsdc: number; gatewayAvailableUsdc: number; buyerWalletUsdc: number; gasReserveUsdc: number };
  twilio?: boolean;
  llm?: boolean;
  passkey?: boolean;
  /** Sellers accept any payment header: "paid" rows are simulated, no money moves. */
  mockPayments?: boolean;
  reservationTtlMinutes?: number;
};

export type HeldPayment = {
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
  holdTxUrl: string | null;
  /** Why the Arc escrow failed; null when it succeeded or Arc isn't configured. */
  holdError?: string | null;
  resolveTx?: string | null;
  resolveTxUrl?: string | null;
};

export type RuleView = { ruleId: string; kind: string; sentence: string; enforcedBy: string };
export type Ambiguity = { phrase: string; question: string };
export type DryRunResult = { label: string; request: unknown; outcome: Outcome; reason: string };
export type NotifyEvent = "hold" | "budget80" | "paused";

export type PolicyInfo = {
  hash: string;
  committedTx?: string | null;
  committedTxUrl?: string | null;
  createdAt?: string;
};

export type Summary = {
  agent: { id: string; name: string; status: "active" | "paused"; pausedReason: string | null };
  task: { id: string | null; spentMicro: number; budgetMicro: number | null };
  today: { spentMicro: number; capMicro: number | null };
  pending: HeldPayment[];
  recent: ActivityItem[];
  rules: RuleView[];
  policy: PolicyInfo | null;
  totals: Totals;
  series: SeriesBucket[];
};

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Fetch JSON from the firewall. Network failures become ApiError(status 0) so the UI can show a friendly state. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(PROXY + path, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Can't reach the firewall right now.", 0);
  }
  const data = await res.json().catch(() => null);
  // Session missing or expired: go sign in, then come back here.
  if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  if (res.status === 502) throw new ApiError("Can't reach the firewall right now.", 0);
  if (!res.ok) {
    throw new ApiError((data && typeof data.error === "string" && data.error) || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export function txUrl(tx: string | null | undefined, url?: string | null): string | null {
  if (url) return url;
  return tx ? `${ARC_EXPLORER}/tx/${tx}` : null;
}

export type { Rule };
