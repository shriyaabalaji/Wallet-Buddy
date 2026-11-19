"use client";
// Public onchain proof. Every row is an Arc testnet event read from the chain by the firewall's indexer
// (apps/firewall/src/proof.ts) and links to the explorer. Metrics at the top come from the firewall's ledger.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Brand } from "@/components";

type Addr = { address: string; url: string } | null;
interface Proof {
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

export default function ProofPage() {
  const [data, setData] = useState<Proof | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState("");
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

  const m = data?.metrics;
  const rows = (data?.transactions ?? []).filter((t) => !kind || t.kind === kind);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Brand />
        <Link className="btn secondary" href="/">Dashboard</Link>
      </div>
      <h1>Onchain proof</h1>
      <p className="muted">Every row below is a real Arc testnet transaction, read from the chain and linked to the explorer.{data?.indexedThroughBlock ? ` Indexed through block ${data.indexedThroughBlock.toLocaleString()}.` : ""} Updates every 15 seconds.</p>
      {err && <div className="callout attention" role="alert"><p>Can&apos;t reach the firewall right now ({err}).</p></div>}
      {!data && !err && <p className="muted" role="status">Loading…</p>}

      {m && (
        <section aria-label="Metrics" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <Stat label="Payments settled" value={String(m.paymentsSettled)} />
          <Stat label="Total spent" value={usd(m.totalSpentUsdc)} />
          <Stat label="Decisions" value={`${m.decisions}`} sub={`${m.outcomes.allow} allowed · ${m.outcomes.block} blocked · ${m.outcomes.hold} held`} />
          <Stat label="Holds" value={`${m.holds.approved + m.holds.denied + m.holds.expired + m.holds.held}`} sub={`${m.holds.approved} approved · ${m.holds.denied} denied · ${m.holds.expired} expired → refunded`} />
          <Stat label="Decision latency" value={m.decisionLatencyMs.avg == null ? "—" : `${m.decisionLatencyMs.avg} ms`} sub={m.decisionLatencyMs.samples ? `avg of ${m.decisionLatencyMs.samples} · p95 ${m.decisionLatencyMs.p95} ms` : "no samples yet"} />
          <Stat label="Worst-case loss" value={`${usd(m.worstCaseLoss.perDayUsdc)}/day`} sub="if the agent or payer key is compromised" />
        </section>
      )}
      {m && m.blockedByRule.length > 0 && (
        <p className="small muted">Blocked by rule: {m.blockedByRule.map((b) => `${b.rule} ${b.count}`).join(" · ")} · flagged as unusual: {m.flaggedRequests}. Metrics come from the firewall&apos;s ledger; the transactions below come from the chain.</p>
      )}

      {data && (
        <section className="panel" aria-labelledby="addr">
          <h2 id="addr">Contracts and wallets</h2>
          {[...Object.entries(data.contracts), ...Object.entries(data.wallets)].filter(([, a]) => a).map(([k, a]) => (
            <div className="kv" key={k}><span>{NAMES[k] ?? k}</span><a className="mono" href={a!.url} target="_blank" rel="noreferrer">{short(a!.address)}</a></div>
          ))}
        </section>
      )}

      {data && (
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
      )}
    </div>
  );
}

function detail(t: Proof["transactions"][number]) {
  const e = t.events;
  if (t.kind === "decision_log") {
    const c = { allow: 0, block: 0, hold: 0 } as Record<string, number>;
    for (const x of e) c[x.outcome ?? ""] = (c[x.outcome ?? ""] ?? 0) + 1;
    return `${e.length} decision${e.length === 1 ? "" : "s"}: ${c.allow} allow · ${c.block} block · ${c.hold} hold`;
  }
  if (t.kind === "policy_commit") return "Rule set hash committed";
  const x = e[0]!;
  const amt = x.amountUsdc != null ? usd(x.amountUsdc) : "";
  if (t.kind === "vault_hold") return `${amt} escrowed${x.purpose ? ` · ${x.purpose}` : ""}`;
  if (t.kind === "vault_release") return `${amt} released to seller after owner approval`;
  if (t.kind === "vault_refund") return `${amt} returned to treasury${x.expired ? " (expired)" : " (denied)"}`;
  if (t.kind === "gateway_deposit") return `${amt} deposited into Circle Gateway`;
  return amt;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <span className="label">{label}</span>
      <span className="big">{value}</span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}
