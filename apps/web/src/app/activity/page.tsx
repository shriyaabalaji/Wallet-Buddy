"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { formatUsd } from "@agent-firewall/policy";
import { api, txUrl, type ActivityItem } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { usePoll } from "@/lib/hooks";
import { ANOMALY_LABEL, AnomalyTags, ErrorState, NoAgents, OutcomeBadge, SeverityPill, VerifyLink, displayName, shortAddr, shortTime } from "@/components";

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

/** Filters live in the URL (?agent=&status=&flagged=1&request=) so a row can be linked to. */
function readUrl(fallbackAgent: string): Filters {
  const q = new URLSearchParams(window.location.search);
  return { agent: q.get("agent") ?? fallbackAgent, status: q.get("status") ?? "", flagged: q.get("flagged") === "1", request: q.get("request") };
}
function writeUrl(f: Filters) {
  const q = new URLSearchParams();
  q.set("agent", f.agent);
  if (f.status) q.set("status", f.status);
  if (f.flagged) q.set("flagged", "1");
  if (f.request) q.set("request", f.request);
  window.history.replaceState(null, "", `/activity?${q}`);
}

export default function Activity() {
  const { agents, agentsError, refreshAgents, agentId, selectAgent } = useAgents();
  const [f, setF] = useState<Filters | null>(null);
  // Read the URL once agents are known (the fallback agent depends on them).
  useEffect(() => {
    if (agents && agentId && !f) setF(readUrl(agentId));
  }, [agents, agentId, f]);
  useEffect(() => { if (f) writeUrl(f); }, [f]);

  const query = f
    // A record link resolves whichever agent the request belongs to.
    ? new URLSearchParams({ agentId: f.request ? "all" : f.agent, limit: "200", ...(f.status ? { status: f.status } : {}), ...(f.flagged ? { anomalies: "1" } : {}), ...(f.request ? { requestId: f.request } : {}) }).toString()
    : "";
  const { data, error, refresh } = usePoll(() => (f ? api<{ items: ActivityItem[] }>(`/v1/activity?${query}`) : Promise.resolve(null)), 5000, query);

  if (!agents) return agentsError ? <ErrorState error={agentsError} onRetry={refreshAgents} /> : <p className="muted" role="status">Loading…</p>;
  if (!agentId) return <NoAgents />;
  if (!f) return <p className="muted" role="status">Loading…</p>;

  const set = (patch: Partial<Filters>) => setF({ ...f, ...patch });
  const items = data?.items ?? null;
  const record = f.request ? items?.[0] ?? null : null;
  const nameOf = (id: string) => displayName(agents.find((a) => a.id === id)?.name ?? id);
  const allAgents = f.agent === "all";

  return (
    <>
      <div className="row">
        <h1>Activity</h1>
        {f.request && <button className="btn secondary" onClick={() => set({ request: null })}>Show all activity</button>}
      </div>

      {!f.request && (
        <div className="filter-bar">
          <div className="field inline">
            <label htmlFor="f-agent" className="muted small">Agent</label>
            <select id="f-agent" value={f.agent} onChange={(e) => { set({ agent: e.target.value }); if (e.target.value !== "all") selectAgent(e.target.value); }}>
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

      {f.request && items && (record ? <Record a={record} agentName={nameOf(record.agentId)} onChange={refresh} /> : <p className="muted">No record with that id.</p>)}

      {!f.request && items && (
        <div className="table-wrap">
          <table className={`activity ${allAgents ? "wide" : ""}`}>
            <thead>
              <tr><th>Time</th><th>{allAgents ? "Agent · task" : "Task"}</th><th>Recipient · why</th><th>Amount</th><th>Decision · status</th><th>Unusual</th><th>Arc</th></tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={7} className="muted">Nothing matches these filters.</td></tr>}
              {items.map((a) => (
                <tr key={a.requestId}>
                  <td className="mono nowrap"><button className="linkish mono" onClick={() => set({ request: a.requestId })} title="Open the full record">{shortTime(a.at)}</button></td>
                  <td className="nowrap">{allAgents && <span className="under">{nameOf(a.agentId)}</span>}<span className={`mono ${allAgents ? "muted small" : ""}`}>{a.taskId}</span></td>
                  <td className="detail"><span className="mono under" title={a.recipient}>{shortAddr(a.recipient)}</span><span className="muted small under">{a.reason}</span>{a.flags.length > 0 && <span className="warn-text small under">{a.flags.join(" ")}</span>}</td>
                  <td className="mono nowrap">{formatUsd(a.amountMicro)}</td>
                  <td className="nowrap"><OutcomeBadge outcome={a.outcome} status={a.status} settlement={a.settlement} /><span className="muted small under">{DECISION[a.outcome]}{a.ruleId ? ` · ${humanize(a.ruleId)}` : ""}</span></td>
                  <td><AnomalyTags anomalies={a.anomalies} /></td>
                  <td><ArcLinks a={a} /></td>
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

function Record({ a, agentName, onChange }: { a: ActivityItem; agentName: string; onChange: () => Promise<void> }) {
  const rows: [string, ReactNode][] = [
    ["When", new Date(a.at).toLocaleString()],
    ["Agent", <>{agentName} <span className="mono muted">({a.agentId})</span></>],
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
      <div><Link className="btn secondary" href="/">Back to overview</Link></div>
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
