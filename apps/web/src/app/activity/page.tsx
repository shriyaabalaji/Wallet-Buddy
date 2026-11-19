"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { formatUsd } from "@agent-firewall/policy";
import { api, txUrl, type ActivityItem } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { usePoll } from "@/lib/hooks";
import { ANOMALY_LABEL, AnomalyTags, ErrorState, OutcomeBadge, SeverityPill, VerifyLink, displayName, shortAddr, shortTime } from "@/components";
import { ProofAddresses, ProofMetrics, ProofTransactions, useProof } from "@/proof";

const STATUS = [
  { id: "", label: "All" },
  { id: "paid", label: "Paid" },
  { id: "pending", label: "Reserved" },
  { id: "held", label: "Held" },
  { id: "blocked", label: "Blocked" },
  { id: "returned", label: "Returned" },
  { id: "reconcile", label: "Needs reconciling" },
] as const;
const DECISION = { allow: "Allowed", hold: "Held", block: "Blocked" } as const;

type Filters = { agent: string; status: string; flagged: boolean; request: string | null };

export default function ActivityPage() {
  return <Suspense fallback={<p className="muted" role="status">Loading…</p>}><Activity /></Suspense>;
}

/**
 * Everything every agent did, across the one shared wallet. Two tabs: Payments (each decision, filterable by agent)
 * and Onchain (the Arc proof: contracts, wallets, transactions). Tab and filters live in the URL
 * (?tab=onchain, ?agent=&status=&flagged=1&request=) so any view can be linked to.
 */
function Activity() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const onchain = params.get("tab") === "onchain";
  const f: Filters = { agent: params.get("agent") ?? "all", status: params.get("status") ?? "", flagged: params.get("flagged") === "1", request: params.get("request") };
  const set = (patch: Partial<Filters> & { tab?: string | null }) => {
    const n = { ...f, ...patch };
    const q = new URLSearchParams();
    if (patch.tab === "onchain") q.set("tab", "onchain");
    else {
      if (n.agent !== "all") q.set("agent", n.agent);
      if (n.status) q.set("status", n.status);
      if (n.flagged) q.set("flagged", "1");
      if (n.request) q.set("request", n.request);
    }
    router.replace(`${path}${q.size ? `?${q}` : ""}`, { scroll: false });
  };
  return (
    <>
      <div className="row page-head">
        <h1>Activity</h1>
        {!onchain && f.request && <button className="btn secondary" onClick={() => set({ request: null })}>Show all activity</button>}
      </div>
      <div className="tabs" role="tablist" aria-label="Activity views">
        <button type="button" role="tab" id="tab-payments" aria-selected={!onchain} aria-controls="panel-activity" onClick={() => set({ tab: null })}>Payments</button>
        <button type="button" role="tab" id="tab-onchain" aria-selected={onchain} aria-controls="panel-activity" onClick={() => set({ tab: "onchain" })}>Onchain</button>
      </div>
      <div role="tabpanel" id="panel-activity" aria-labelledby={onchain ? "tab-onchain" : "tab-payments"} className="tab-panel">
        {onchain ? <Onchain /> : <Payments f={f} set={set} />}
      </div>
    </>
  );
}

function Onchain() {
  const { data, err } = useProof();
  return (
    <>
      <p className="muted small">Every transaction below is a real Arc testnet transaction, read from the chain and linked to the explorer.{data?.indexedThroughBlock ? ` Indexed through block ${data.indexedThroughBlock.toLocaleString()}.` : ""}</p>
      {err && <div className="callout attention" role="alert"><p>Can&apos;t reach the firewall right now ({err}).</p></div>}
      {!data && !err && <p className="muted" role="status">Loading…</p>}
      {data && <ProofMetrics m={data.metrics} />}
      {data && <ProofAddresses data={data} />}
      {data && <ProofTransactions data={data} />}
    </>
  );
}

function Payments({ f, set }: { f: Filters; set: (patch: Partial<Filters>) => void }) {
  const { agents, agentsError, refreshAgents } = useAgents();
  const query = new URLSearchParams({
    // A record link resolves whichever agent the request belongs to.
    agentId: f.request ? "all" : f.agent, limit: "200",
    ...(f.status ? { status: f.status } : {}), ...(f.flagged ? { anomalies: "1" } : {}), ...(f.request ? { requestId: f.request } : {}),
  }).toString();
  const { data, error, refresh } = usePoll(() => api<{ items: ActivityItem[] }>(`/v1/activity?${query}`), 5000, query);

  if (!agents) return agentsError ? <ErrorState error={agentsError} onRetry={refreshAgents} /> : <p className="muted" role="status">Loading…</p>;

  const items = data?.items ?? null;
  const record = f.request ? items?.[0] ?? null : null;
  const nameOf = (id: string) => displayName(agents.find((a) => a.id === id)?.name ?? id);
  const allAgents = f.agent === "all";

  return (
    <>
      {!f.request && (
        <div className="filter-bar">
          <div className="field inline">
            <label htmlFor="f-agent" className="muted small">Agent</label>
            <select id="f-agent" value={f.agent} onChange={(e) => set({ agent: e.target.value })}>
              <option value="all">All agents</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{displayName(a.name)}</option>)}
            </select>
          </div>
          <div className="filters" role="group" aria-label="Status">
            {STATUS.map((s) => <button key={s.id} className="btn secondary" aria-pressed={f.status === s.id} onClick={() => set({ status: s.id })}>{s.label}</button>)}
          </div>
          <label className="check"><input type="checkbox" checked={f.flagged} onChange={(e) => set({ flagged: e.target.checked })} /> Unusual activity only</label>
        </div>
      )}

      {error && <ErrorState error={error} onRetry={refresh} />}
      {!items && !error && <p className="muted" role="status">Loading…</p>}

      {f.request && items && (record ? <Record a={record} agentName={nameOf(record.agentId)} onChange={refresh} onBack={() => set({ request: null })} /> : <p className="muted">No record with that id.</p>)}

      {!f.request && items && (
        <div className="table-wrap">
          <table className={`activity ${allAgents ? "wide" : ""}`}>
            <thead>
              <tr><th>Time</th><th>{allAgents ? "Agent · task" : "Task"}</th><th>Recipient · why</th><th>Amount</th><th>Decision · status</th><th>Arc</th><th>Unusual</th></tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={7} className="muted">Nothing matches these filters.</td></tr>}
              {items.map((a) => (
                <tr key={a.requestId}>
                  <td className="mono nowrap"><button className="linkish mono" onClick={() => set({ request: a.requestId })} title="Open the full record">{shortTime(a.at)}</button></td>
                  <td className="nowrap">{allAgents && <Link className="under" href={`/agents?id=${encodeURIComponent(a.agentId)}`}>{nameOf(a.agentId)}</Link>}<span className={`mono ${allAgents ? "muted small" : ""}`}>{a.taskId}</span></td>
                  <td className="detail"><span className="mono under" title={a.recipient}>{shortAddr(a.recipient)}</span><span className="muted small under">{a.reason}</span>{a.flags.length > 0 && <span className="warn-text small under">{a.flags.join(" ")}</span>}</td>
                  <td className="mono nowrap">{formatUsd(a.amountMicro)}</td>
                  <td className="nowrap"><OutcomeBadge outcome={a.outcome} status={a.status} settlement={a.settlement} /><span className="muted small under">{DECISION[a.outcome]}{a.ruleId ? ` · ${humanize(a.ruleId)}` : ""}</span></td>
                  <td><ArcLinks a={a} /></td>
                  <td><AnomalyTags anomalies={a.anomalies} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Only hashes the firewall got back from our own Arc contracts; a Gateway payment reference is never shown as one. */
function ArcLinks({ a }: { a: ActivityItem }) {
  const main = txUrl(a.arcTx, a.arcTxUrl);
  const resolve = txUrl(a.resolveTx, a.resolveTxUrl);
  if (!main && !resolve) return <span className="muted">—</span>;
  return (
    <span className="table-verify tags">
      <VerifyLink href={main}>{a.outcome === "hold" ? "held" : "logged"}</VerifyLink>
      <VerifyLink href={resolve}>{a.status === "approved" ? "released" : "refunded"}</VerifyLink>
    </span>
  );
}

function Record({ a, agentName, onChange, onBack }: { a: ActivityItem; agentName: string; onChange: () => Promise<void>; onBack: () => void }) {
  const rows: [string, ReactNode][] = [
    ["When", new Date(a.at).toLocaleString()],
    ["Agent", <><Link href={`/agents?id=${encodeURIComponent(a.agentId)}`}>{agentName}</Link> <span className="mono muted">({a.agentId})</span></>],
    ["Task", <span className="mono">{a.taskId}</span>],
    ["Recipient", <span className="mono" style={{ overflowWrap: "anywhere" }}>{a.recipient}</span>],
    ["Amount", <span className="mono">{formatUsd(a.amountMicro)}</span>],
    ["Category", a.category],
    ["Agent's stated purpose", a.purpose || "—"],
    ["Decision", <>{DECISION[a.outcome]}{a.ruleId ? <span className="muted"> · rule {humanize(a.ruleId)}</span> : null}</>],
    ["Status", <OutcomeBadge outcome={a.outcome} status={a.status} settlement={a.settlement} />],
    ...(a.settlement ? [["Money", <MoneyEvidence s={a.settlement} />] as [string, ReactNode]] : []),
    ["Why", a.reason],
    ["Request id", <span className="mono" style={{ overflowWrap: "anywhere" }}>{a.requestId}</span>],
  ];
  return (
    <section className="panel" aria-label="Payment record">
      <h2>{a.sentence}</h2>
      <dl className="receipt">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {a.flags.length > 0 && (
        <div className="callout attention"><strong>Possible injection</strong>{a.flags.map((x) => <p key={x}>{x}</p>)}</div>
      )}
      <div>
        <h3 className="small-h">Unusual activity</h3>
        {a.anomalies.length === 0 ? <p className="muted">Nothing unusual compared with this agent&apos;s history.</p> : (
          <ul className="risk">
            {a.anomalies.map((x) => (
              <li key={x.type}>
                <div className="risk-head"><SeverityPill severity={x.severity} /><strong>{ANOMALY_LABEL[x.type]}</strong></div>
                <p>{x.explanation}</p>
                <p className="muted small mono">{Object.entries(x.measured).map(([k, v]) => `${k}=${v}`).join(" · ")}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      {a.settlement?.needsReconciliation && <Reconcile a={a} onDone={onChange} />}
      {(a.arcTx || a.arcTxUrl || a.resolveTx || a.resolveTxUrl) && <p className="lockline">Verified on Arc: <ArcLinks a={a} /></p>}
      <div><button type="button" className="btn secondary" onClick={onBack}>Back to activity</button></div>
    </section>
  );
}

function MoneyEvidence({ s }: { s: NonNullable<ActivityItem["settlement"]> }) {
  return (
    <>
      {s.label}
      {s.reference && <span className="mono muted" style={{ overflowWrap: "anywhere" }}> · {s.verifiedOnchain ? "tx" : "reference (not verified)"} {s.reference}</span>}
      {s.reconciledByOwner && <span className="muted"> · marked by you</span>}
    </>
  );
}

/**
 * Owner resolves an uncertain outcome. The firewall can't tell whether money moved, so this asks the owner to check the
 * payer's history first. "Not paid" returns the budget; "Paid" keeps it counted.
 */
function Reconcile({ a, onDone }: { a: ActivityItem; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function mark(outcome: "paid" | "not_paid") {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/v1/payments/${encodeURIComponent(a.requestId)}/reconcile`, { method: "POST", body: { outcome } });
      await onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't update this payment.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="callout attention">
      <div>
        <strong>Did this payment go through?</strong>
        <p className="muted">It failed after the payment started, so money may have moved. Check the payer&apos;s Gateway history (README &ldquo;Where to see the Agent Wallets&rdquo;) before you mark it. Until then it stays counted against budgets.</p>
        {msg && <p role="alert">{msg}</p>}
      </div>
      <div className="toolbar">
        <button className="btn secondary" disabled={busy} onClick={() => mark("paid")}>It was paid</button>
        <button className="btn attention secondary" disabled={busy} onClick={() => mark("not_paid")}>It wasn&apos;t paid</button>
      </div>
    </div>
  );
}

function humanize(id: string) {
  const s = id.replace(/[-_]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
