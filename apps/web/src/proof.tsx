"use client";
// Onchain proof, shared by the public /proof page (judges, no login) and the Activity page's "Onchain" tab.
// Every transaction row is an Arc testnet event read from the chain by the firewall's indexer
// (apps/firewall/src/proof.ts) and links to the explorer. The metrics come from the firewall's ledger.
import { useEffect, useState } from "react";

type Addr = { address: string; url: string } | null;
export interface Proof {
  network: string;
  indexedThroughBlock: number | null;
  contracts: Record<string, Addr>;
  wallets: Record<string, Addr>;
  onchainCounts: Record<string, { txs: number; events: number }>;
  transactions: { tx: string; url: string; block: number; at: string | null; kind: string; label: string; agent: string | null; events: { requestId: string | null; amountUsdc: number | null; outcome?: string; purpose: string | null; recipient: string | null; expired?: boolean }[] }[];
  metrics: {
    paymentsSettled: number; totalSpentUsdc: number; decisions: number;
    outcomes: { allow: number; block: number; hold: number };
    blockedByRule: { rule: string; count: number }[];
    holds: { held: number; approved: number; denied: number; expired: number };
    flaggedRequests: number;
    decisionLatencyMs: { samples: number; avg: number | null; p95: number | null; max: number | null };
    worstCaseLoss: { perDayUsdc: number; explanation: string };
  };
}

const KINDS: [string, string][] = [
  ["", "All"], ["policy_commit", "Policy commits"], ["decision_log", "Decision logs"], ["vault_hold", "Vault holds"],
  ["vault_release", "Releases"], ["vault_refund", "Refunds"], ["gateway_deposit", "Gateway deposits"],
];
const NAMES: Record<string, string> = { policyRegistry: "PolicyRegistry", approvalVault: "ApprovalVault", usdc: "USDC", gatewayWallet: "Circle Gateway Wallet", circleAgentWallet: "Circle Agent Wallet", gatewayDepositor: "Agent Wallet backing EOA (Gateway balance)", treasury: "Treasury" };
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const usd = (n: number) => `$${n.toFixed(n < 1 && n > 0 ? 3 : 2)}`;

/** GET /v1/proof (public route), refreshed every 15 seconds. */
export function useProof() {
  const [data, setData] = useState<Proof | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/fw/v1/proof", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Proof;
        if (alive) { setData(j); setErr(null); }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "unreachable");
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { data, err };
}

export function ProofMetrics({ m }: { m: Proof["metrics"] }) {
  return (
    <>
      <section aria-label="Metrics" className="proof-stats">
        <Stat label="Payments settled" value={String(m.paymentsSettled)} />
        <Stat label="Total spent" value={usd(m.totalSpentUsdc)} />
        <Stat label="Decisions" value={`${m.decisions}`} sub={`${m.outcomes.allow} allowed, ${m.outcomes.block} blocked, ${m.outcomes.hold} held`} />
        <Stat label="Holds" value={`${m.holds.approved + m.holds.denied + m.holds.expired + m.holds.held}`} sub={`${m.holds.approved} approved, ${m.holds.denied} denied, ${m.holds.expired} expired and refunded`} />
        <Stat label="Decision latency" value={m.decisionLatencyMs.avg == null ? "—" : `${m.decisionLatencyMs.avg} ms`} sub={m.decisionLatencyMs.samples ? `avg of ${m.decisionLatencyMs.samples}, p95 ${m.decisionLatencyMs.p95} ms` : "no samples yet"} />
        <Stat label="Worst-case loss" value={`${usd(m.worstCaseLoss.perDayUsdc)}/day`} sub="if the agent or payer key is compromised" />
      </section>
    </>
  );
}

export function ProofAddresses({ data }: { data: Proof }) {
  return (
    <section className="panel" aria-labelledby="addr">
      <h2 id="addr">Contracts and wallets</h2>
      {[...Object.entries(data.contracts), ...Object.entries(data.wallets)].filter(([, a]) => a).map(([k, a]) => (
        <div className="kv" key={k}><span>{NAMES[k] ?? k}</span><a className="mono" href={a!.url} target="_blank" rel="noreferrer">{short(a!.address)}</a></div>
      ))}
    </section>
  );
}

export function ProofTransactions({ data }: { data: Proof }) {
  const [kind, setKind] = useState("");
  const rows = data.transactions.filter((t) => !kind || t.kind === kind);
  return (
    <section aria-labelledby="txs" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id="txs">Transactions</h2>
      <div className="toolbar" role="group" aria-label="Filter by type" style={{ flexWrap: "wrap" }}>
        {KINDS.map(([k, label]) => {
          const n = k ? data.onchainCounts[k]?.txs ?? 0 : Object.values(data.onchainCounts).reduce((s, c) => s + c.txs, 0);
          return <button key={k} type="button" className={`btn secondary ${kind === k ? "active" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{label} ({n})</button>;
        })}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>What</th><th>Agent</th><th>Details</th><th>Transaction</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="muted">No transactions of this type yet.</td></tr>}
            {rows.map((t) => (
              <tr key={`${t.tx}:${t.kind}`}>
                <td className="small">{t.at ? new Date(t.at).toLocaleString() : `block ${t.block}`}</td>
                <td>{t.label}</td>
                <td className="mono small">{t.agent ?? "—"}</td>
                <td className="small">{detail(t)}</td>
                <td><a className="mono small" href={t.url} target="_blank" rel="noreferrer">{short(t.tx)}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function detail(t: Proof["transactions"][number]) {
  const e = t.events;
  if (t.kind === "decision_log") {
    const c = { allow: 0, block: 0, hold: 0 } as Record<string, number>;
    for (const x of e) c[x.outcome ?? ""] = (c[x.outcome ?? ""] ?? 0) + 1;
    return `${e.length} decision${e.length === 1 ? "" : "s"}: ${c.allow} allow, ${c.block} block, ${c.hold} hold`;
  }
  if (t.kind === "policy_commit") return "Rule set hash committed";
  const x = e[0]!;
  const amt = x.amountUsdc != null ? usd(x.amountUsdc) : "";
  if (t.kind === "vault_hold") return `${amt} escrowed${x.purpose ? ` for ${x.purpose}` : ""}`;
  if (t.kind === "vault_release") return `${amt} released to seller after owner approval`;
  if (t.kind === "vault_refund") return `${amt} returned to treasury${x.expired ? " (expired)" : " (denied)"}`;
  if (t.kind === "gateway_deposit") return `${amt} deposited into Circle Gateway`;
  return amt;
}

/** A metric that flips over on hover (or tap / Enter) to show its breakdown. Without a breakdown it's a plain card. */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const [flipped, setFlipped] = useState(false);
  if (!sub) return (
    <div className="card">
      <span className="label">{label}</span>
      <span className="big">{value}</span>
    </div>
  );
  return (
    <button type="button" className={`stat-flip ${flipped ? "flipped" : ""}`} aria-pressed={flipped} aria-label={`${label}: ${value}. ${sub}`} onClick={() => setFlipped((f) => !f)}>
      <span className="flip-inner" aria-hidden="true">
        <span className="card flip-face">
          <span className="label">{label}</span>
          <span className="big">{value}</span>
        </span>
        <span className="card flip-face flip-back">
          <span className="label">{label}</span>
          <span className="flip-detail">{sub}</span>
        </span>
      </span>
    </button>
  );
}
