"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { formatUsd } from "@agent-firewall/policy";
import { ApiError, DEFAULT_AGENT_ID, api, type AgentListItem, type NotifyEvent, type Summary } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { useNow, usePoll } from "@/lib/hooks";
import { ErrorState, Icon, Money, PauseButton, TxRow, displayName, fmtLeft, resetTime, shortAddr } from "@/components";
import { formatPhone, normalizePhone } from "../settings/phone";
import { AgentRules } from "./rules";

const ADD = "__add";
type Tab = "overview" | "rules";

export default function AgentsPage() {
  return <Suspense fallback={<p className="muted" role="status">Loading…</p>}><Agents /></Suspense>;
}

/** One agent at a time, picked from the dropdown. The choice lives in the URL (?id=, ?tab=rules, ?add=1) so it can be linked to. */
function Agents() {
  const { agents, agentsError, refreshAgents } = useAgents();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) (v === null ? q.delete(k) : q.set(k, v));
    router.replace(`${path}${q.size ? `?${q}` : ""}`, { scroll: false });
  };

  if (!agents) return agentsError ? <ErrorState error={agentsError} onRetry={refreshAgents} /> : <p className="muted" role="status">Loading…</p>;

  const adding = params.get("add") === "1" || agents.length === 0;
  const wanted = params.get("id");
  const agent = agents.find((a) => a.id === wanted) ?? agents[0] ?? null;
  const tab: Tab = params.get("tab") === "rules" ? "rules" : "overview";

  return (
    <>
      <div className="row page-head">
        <h1>Agents</h1>
        {agents.length > 0 && (
          <div className="toolbar">
            <div className="field inline">
              <label htmlFor="agent-select" className="muted small">Agent</label>
              <select id="agent-select" value={adding ? ADD : agent?.id ?? ""} onChange={(e) => (e.target.value === ADD ? go({ add: "1" }) : go({ id: e.target.value, add: null }))}>
                {agents.map((a) => <option key={a.id} value={a.id}>{displayName(a.name)}{a.status === "paused" ? " (paused)" : ""}</option>)}
                <option value={ADD}>+ Add agent</option>
              </select>
            </div>
            {!adding && <button type="button" className="btn secondary" onClick={() => go({ add: "1" })}><Icon name="plus" size={16} />Add agent</button>}
          </div>
        )}
      </div>

      {adding ? (
        <Register
          suggested={agents.length === 0 ? DEFAULT_AGENT_ID : ""}
          onCancel={agents.length > 0 ? () => go({ add: null }) : undefined}
          onDone={async (id) => { await refreshAgents(); }}
          open={(id, t) => go({ id, add: null, tab: t === "rules" ? "rules" : null })}
        />
      ) : agent ? (
        <AgentView key={agent.id} agent={agent} tab={tab} setTab={(t) => go({ id: agent.id, tab: t === "rules" ? "rules" : null })} onChanged={refreshAgents} />
      ) : null}
    </>
  );
}

function AgentView({ agent, tab, setTab, onChanged }: { agent: AgentListItem; tab: Tab; setTab: (t: Tab) => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const paused = agent.status === "paused";
  async function rotate() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ key: string }>(`/v1/agents/${encodeURIComponent(agent.id)}/key`, { method: "POST", body: {} });
      setNewKey(r.key);
      await onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't create a key."); } finally { setBusy(false); }
  }
  return (
    <>
      <section className="agent-head" aria-label="Agent">
        <div className="name-id">
          <h2 className="agent-name">{displayName(agent.name)}</h2>
          <span className="small muted">
            <span className="status"><span className={`dot ${paused ? "paused" : ""}`} aria-hidden="true" />{paused ? "Paused" : "Active"}</span>
            {" · "}<span className="mono">{agent.id}</span>
            {" · "}{agent.hasPolicy ? "Rules locked on Arc" : "No rules: can't spend"}
            {" · "}{agent.credentialConfigured ? "Key configured" : "No key yet"}
          </span>
        </div>
        <div className="toolbar">
          <button type="button" className="btn secondary" onClick={rotate} disabled={busy}><Icon name="lock" size={16} />New key</button>
          <PauseButton agent={agent} onChanged={onChanged} />
        </div>
      </section>
      {paused && agent.pausedReason && <p className="muted small">Paused because: {agent.pausedReason}</p>}
      {err && <p role="alert" className="field-err">{err}</p>}
      {newKey && (
        <div className="callout info" role="status">
          <strong>New key, shown once</strong>
          <p className="small">The old key no longer works. Give this one to the agent as <span className="mono">FIREWALL_AGENT_TOKEN</span>.</p>
          <p className="mono small" style={{ wordBreak: "break-all", userSelect: "all" }}>{newKey}</p>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Agent sections">
        {(["overview", "rules"] as const).map((t) => (
          <button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls={`panel-${t}`} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : "Rules"}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
        {tab === "overview" ? <AgentOverview agentId={agent.id} /> : <AgentRules key={agent.id} agentId={agent.id} />}
      </div>
    </>
  );
}

/** One agent's money today: what it can still spend, its task budget, what got stopped, and its latest payments. */
function AgentOverview({ agentId }: { agentId: string }) {
  const enc = encodeURIComponent(agentId);
  const { data, error, refresh } = usePoll(() => api<Summary>(`/v1/agents/${enc}/summary`), 3000, agentId);
  const now = useNow(1000);
  if (!data) return error ? <ErrorState error={error} onRetry={refresh} /> : <p className="muted" role="status">Loading…</p>;

  const { task, today, pending, recent, totals } = data;
  const pct = (spent: number, cap: number | null) => (cap ? Math.min(100, (spent / cap) * 100) : 0);
  const dayLeft = today.capMicro !== null ? Math.max(0, today.capMicro - today.spentMicro) : null;
  const taskLeft = task.budgetMicro !== null ? Math.max(0, task.budgetMicro - task.spentMicro) : null;
  return (
    <>
      {error && <ErrorState error={error} onRetry={refresh} />}
      {pending.map((h) => (
        <div className="callout attention alert" key={h.requestId} role="status" aria-live="polite">
          <div>
            <strong>{formatUsd(h.amountMicro)} held for your approval</strong> · to <span className="mono">{shortAddr(h.recipient)}</span>
            <p className="muted">{h.reason}</p>
          </div>
          <div className="alert-right">
            <span className="countdown">{fmtLeft(new Date(h.expiresAt).getTime() - now)}</span>
            {h.token ? <Link className="btn attention" href={`/a/${h.token}`}>Review</Link> : <span className="muted">Open the link we texted you.</span>}
          </div>
        </div>
      ))}

      <section className="glance even" aria-label="Budgets">
        <div className="card">
          <div className="card-top"><h2>Can still spend today</h2></div>
          {dayLeft !== null ? <Money micro={dayLeft} size="lg" /> : <span className="money lg">No cap</span>}
          {today.capMicro !== null && <div className="bar" aria-hidden="true"><span style={{ width: `${pct(today.spentMicro, today.capMicro)}%` }} /></div>}
          <p className="small muted foot">{formatUsd(today.spentMicro)}{today.capMicro !== null ? ` of ${formatUsd(today.capMicro)}` : ""} used · resets {resetTime(now)}</p>
        </div>
        <div className="card">
          <div className="card-top"><h2>Task budget</h2></div>
          {taskLeft !== null ? <Money micro={taskLeft} size="lg" /> : <span className="money lg">No cap</span>}
          {task.budgetMicro !== null && <div className="bar" aria-hidden="true"><span style={{ width: `${pct(task.spentMicro, task.budgetMicro)}%` }} /></div>}
          <p className="small muted foot">{task.id ? <>Task <span className="mono">{task.id}</span>{task.budgetMicro !== null ? ` · ${formatUsd(task.spentMicro)} of ${formatUsd(task.budgetMicro)} used` : ""}</> : "No task yet"}</p>
        </div>
        <div className="card">
          <div className="card-top"><h2>Stopped today</h2></div>
          <Money micro={totals.stoppedMicro} size="lg" />
          <span className="tags foot">
            <Link className={`pill ${totals.counts.blocked ? "warn" : "quiet"}`} href={`/activity?agent=${enc}&status=blocked`}>{totals.counts.blocked} blocked</Link>
            {totals.counts.ownerApproved > 0 && <span className="pill ok">{totals.counts.ownerApproved} approved by you</span>}
            {totals.anomalies.flaggedRequests > 0 && <Link className="pill warn" href={`/activity?agent=${enc}&flagged=1`}>{totals.anomalies.flaggedRequests} unusual</Link>}
          </span>
        </div>
      </section>

      <section className="panel flush" aria-label="Recent payments">
        <div className="panel-bar">
          <h2>Recent payments</h2>
          <Link className="round-link" href={`/activity?agent=${enc}`} aria-label="All of this agent's activity"><Icon name="arrow" size={16} /></Link>
        </div>
        {recent.length === 0 ? (
          <p className="muted pad">Nothing yet. Payments appear here as this agent pays.</p>
        ) : (
          <div className="tx-wrap">
            <table className="tx">
              <thead><tr><th>Time</th><th>To</th><th>Status</th><th className="r">Amount</th><th className="r hide-sm">Arc tx</th></tr></thead>
              <tbody>{recent.slice(0, 5).map((a) => <TxRow key={a.requestId} a={a} />)}</tbody>
            </table>
          </div>
        )}
      </section>

      <TextOverride agentId={agentId} />
    </>
  );
}

/**
 * Advanced: a different phone for this agent's texts (POST /v1/agents/:id/notify). Without one, the agent uses the
 * number in Settings. Clearing it (empty phone) falls back to Settings.
 */
function TextOverride({ agentId }: { agentId: string }) {
  const enc = encodeURIComponent(agentId);
  const cur = usePoll(() => api<{ notify: { phone: string | null; events: NotifyEvent[] } | null }>(`/v1/policy/${enc}`), 60000, agentId);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const override = cur.data?.notify?.phone ?? null;
  async function save(raw: string) {
    const normalized = raw ? normalizePhone(raw) : "";
    if (normalized === null) { setMsg("Include the country code, like +1 604 555 0100."); return; }
    setBusy(true); setMsg(null);
    try {
      await api(`/v1/agents/${enc}/notify`, { method: "POST", body: { phone: normalized, events: cur.data?.notify?.events ?? ["hold"] } });
      setPhone("");
      setMsg(normalized ? `Saved. This agent texts ${formatPhone(normalized)}.` : "Saved. This agent uses the number in Settings.");
      await cur.refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Couldn't save."); } finally { setBusy(false); }
  }
  return (
    <details className="advanced">
      <summary>Text messages for this agent</summary>
      <div className="advanced-body">
        <p className="small muted">
          {override ? <>This agent texts <span className="mono">{formatPhone(override)}</span> instead of the number in <Link href="/settings">Settings</Link>.</> : <>This agent texts the number in <Link href="/settings">Settings</Link>, like every agent.</>}
        </p>
        <form className="edit-row" onSubmit={(e: FormEvent) => { e.preventDefault(); void save(phone); }}>
          <label htmlFor="ov-phone" className="sr">A different number for this agent</label>
          <input id="ov-phone" type="tel" inputMode="tel" placeholder="Different number, e.g. +1 604 555 0100" value={phone} onChange={(e) => { setPhone(e.target.value); setMsg(null); }} />
          <button className="btn secondary" type="submit" disabled={busy || !phone.trim()}>Use this number</button>
          {override && <button className="btn secondary" type="button" disabled={busy} onClick={() => save("")}>Use Settings number</button>}
        </form>
        {msg && <p className="small" role="status">{msg}</p>}
      </div>
    </details>
  );
}

// Starter rules for a new agent (editable on its Rules tab): $1 per task, $5 per day, ask me above $0.50,
// only the demo sellers. Saving them commits the policy hash on Arc like any other rule change.
const STARTER_RULES = [
  { id: "task-budget", kind: "taskBudget", taskId: "*", maxMicro: 1_000_000 },
  { id: "day-budget", kind: "periodBudget", period: "day", maxMicro: 5_000_000 },
  { id: "ask-first", kind: "approvalThreshold", aboveMicro: 500_000 },
  { id: "approved-sellers", kind: "allowlist", recipients: ["sportsfeed", "statline", "oddsapi"], onViolation: "block" },
];

interface Created { id: string; key: string; wallet: { address: string | null; mode: string } | null; rulesSaved: boolean }

/** Add an agent: issues its one-time key and (optionally) saves starter rules. It pays from the shared wallet. */
function Register({ suggested, onDone, onCancel, open }: { suggested: string; onDone: (id: string) => Promise<void>; onCancel?: () => void; open: (id: string, tab?: Tab) => void }) {
  const [id, setId] = useState(suggested);
  const [name, setName] = useState("");
  const [starter, setStarter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (suggested) setId((v) => v || suggested); }, [suggested]);
  useEffect(() => { first.current?.focus(); }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setCreated(null); setCopied(false);
    const agentId = id.trim();
    try {
      const r = await api<{ key: string; wallet: Created["wallet"] }>("/v1/agents", { method: "POST", body: { id: agentId, name: name.trim() || undefined, issueKey: true } });
      let rulesSaved = false;
      if (starter) {
        try { await api("/v1/policy", { method: "POST", body: { agentId, rules: STARTER_RULES, confirmed: true } }); rulesSaved = true; } catch { /* shown below */ }
      }
      setCreated({ id: agentId, key: r.key, wallet: r.wallet, rulesSaved });
      setId(""); setName("");
      await onDone(agentId);
    } catch (e2) {
      setErr(e2 instanceof ApiError || e2 instanceof Error ? e2.message : "Couldn't add the agent.");
    } finally { setBusy(false); }
  }
  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.key); setCopied(true); } catch { /* user can select it */ }
  }
  return (
    <form className="panel add-form" onSubmit={submit} aria-labelledby="reg">
      <h2 id="reg">Add an agent</h2>
      <div className="two">
        <div className="field">
          <label htmlFor="reg-id">Agent id</label>
          <input ref={first} id="reg-id" type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder="research-agent" pattern="[A-Za-z0-9_.:\-]{1,100}" required />
        </div>
        <div className="field">
          <label htmlFor="reg-name">Display name (optional)</label>
          <input id="reg-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Research agent" maxLength={60} />
        </div>
      </div>
      <label className="check small">
        <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
        Start with safe rules: $1 per task, $5 a day, ask me above $0.50, demo sellers only
      </label>
      <div className="toolbar">
        <button className="btn" type="submit" disabled={busy || !id.trim()}>{busy ? "Adding…" : "Add agent"}</button>
        {onCancel && <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>}
      </div>
      {err && <div className="callout attention" role="alert"><p>{err}</p></div>}
      {created && (
        <div className="callout info" role="status">
          <p><strong>{created.id}</strong> is ready{created.rulesSaved ? " with starter rules" : "; it can't spend until you save rules"}. Copy its key now: it won&apos;t be shown again.</p>
          <p className="mono small" style={{ wordBreak: "break-all", userSelect: "all" }}>{created.key}</p>
          <div className="toolbar">
            <button type="button" className="btn secondary" onClick={copy}>{copied ? "Copied" : "Copy key"}</button>
            <button type="button" className="btn secondary" onClick={() => open(created.id)}>Open agent</button>
            <button type="button" className="btn secondary" onClick={() => open(created.id, "rules")}>Edit rules</button>
          </div>
          <p className="small muted">Give it to your agent as <span className="mono">FIREWALL_AGENT_TOKEN</span>. It pays from your Circle Agent Wallet{created.wallet?.address ? <> (<span className="mono">{created.wallet.address.slice(0, 6)}…{created.wallet.address.slice(-4)}</span>)</> : null}; Wallet Buddy checks this agent&apos;s own rules before every payment.</p>
        </div>
      )}
    </form>
  );
}
