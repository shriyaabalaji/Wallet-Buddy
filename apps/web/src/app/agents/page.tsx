"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { formatUsd } from "@agent-firewall/policy";
import { ApiError, DEFAULT_AGENT_ID, api, type AgentListItem } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { ErrorState, Icon, Money, displayName } from "@/components";

export default function AgentsPage() {
  const { agents, agentsError, refreshAgents, agentId, selectAgent } = useAgents();
  return (
    <>
      <h1>Agents</h1>
      {agentsError && <ErrorState error={agentsError} onRetry={refreshAgents} />}
      {!agents && !agentsError && <p className="muted" role="status">Loading…</p>}
      {agents && agents.length === 0 && <p className="muted">No agents are registered yet. Register one below, then give it rules.</p>}
      {agents && agents.length > 0 && (
        <section className="agent-grid" aria-label="Registered agents">
          {agents.map((a) => <AgentCard key={a.id} a={a} selected={a.id === agentId} onOpen={() => selectAgent(a.id)} onChanged={refreshAgents} />)}
        </section>
      )}
      <Register suggested={agents && agents.length === 0 ? DEFAULT_AGENT_ID : ""} onDone={async (id) => { await refreshAgents(); selectAgent(id); }} />
    </>
  );
}

function AgentCard({ a, selected, onOpen, onChanged }: { a: AgentListItem; selected: boolean; onOpen: () => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const paused = a.status === "paused";
  async function toggle() {
    setBusy(true); setErr(null);
    try {
      await api(`/v1/agents/${encodeURIComponent(a.id)}/${paused ? "resume" : "pause"}`, { method: "POST", body: {} });
      await onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't update the agent."); } finally { setBusy(false); }
  }
  const [newKey, setNewKey] = useState<string | null>(null);
  async function rotate() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ key: string }>(`/v1/agents/${encodeURIComponent(a.id)}/key`, { method: "POST", body: {} });
      setNewKey(r.key);
      await onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't create a key."); } finally { setBusy(false); }
  }
  const { budget, today } = a;
  return (
    <article className={`card ${a.pendingApprovals ? "attention" : ""}`} aria-label={displayName(a.name)}>
      <div className="card-top">
        <div className="name-id">
          <h2>{displayName(a.name)}</h2>
          <span className="mono muted small">{a.id}</span>
        </div>
        <span className="status small"><span className={`dot ${paused ? "paused" : ""}`} aria-hidden="true" />{paused ? "Paused" : "Active"}{selected ? " · selected" : ""}</span>
      </div>
      <div className="row">
        <span><span className="label">Can still spend today</span><br />{budget.dayAvailableMicro !== null ? <Money micro={budget.dayAvailableMicro} size="md" /> : <span className="money md">No cap</span>}</span>
        {budget.dayCapMicro !== null && <span className="muted small">{formatUsd(budget.daySpentMicro)} of {formatUsd(budget.dayCapMicro)} used</span>}
      </div>
      <div className="facts">
        <div className="kv"><span>Paid today</span><span>{formatUsd(today.paidMicro)}</span></div>
        <div className="kv"><span>Reserved · held</span><span>{formatUsd(today.inProgressMicro)} · {formatUsd(today.heldMicro)}</span></div>
        <div className="kv"><span>Task</span><span className="mono">{a.currentTask ?? "none yet"}{a.currentTask && budget.taskAvailableMicro !== null ? ` · ${formatUsd(budget.taskAvailableMicro)} left` : ""}</span></div>
        <div className="kv"><span>Waiting for you</span><span>{a.pendingApprovals}</span></div>
        <div className="kv"><span>Unusual (24h)</span><span>{a.anomalies24h.requests}{a.anomalies24h.high ? ` · ${a.anomalies24h.high} high` : ""}</span></div>
        <div className="kv"><span>Rules</span><span>{a.hasPolicy ? "Saved" : "None: can't spend"}</span></div>
        <div className="kv"><span>Agent token</span><span>{a.credentialConfigured ? "Configured" : "Not configured"}</span></div>
      </div>
      {err && <p role="alert" style={{ color: "var(--orange)" }}>{err}</p>}
      {newKey && <div className="callout info" role="status"><p className="small">New key (shown once; the old one no longer works):</p><p className="mono small" style={{ wordBreak: "break-all", userSelect: "all" }}>{newKey}</p></div>}
      <div className="toolbar" style={{ marginTop: "auto" }}>
        <Link className="btn secondary" href="/" onClick={onOpen}>Open</Link>
        <button className={`btn ${paused ? "" : "attention secondary"}`} onClick={toggle} disabled={busy}>
          <Icon name={paused ? "play" : "pause"} size={16} />{paused ? "Resume" : "Pause"}
        </button>
        <button className="btn secondary" onClick={rotate} disabled={busy}>New key</button>
      </div>
    </article>
  );
}

// Starter rules for a new agent (editable on the Rules page): $1 per task, $5 per day, ask me above $0.50,
// only the demo sellers. Saving them commits the policy hash on Arc like any other rule change.
const STARTER_RULES = [
  { id: "task-budget", kind: "taskBudget", taskId: "*", maxMicro: 1_000_000 },
  { id: "day-budget", kind: "periodBudget", period: "day", maxMicro: 5_000_000 },
  { id: "ask-first", kind: "approvalThreshold", aboveMicro: 500_000 },
  { id: "approved-sellers", kind: "allowlist", recipients: ["sportsfeed", "statline", "oddsapi"], onViolation: "block" },
];

interface Created { id: string; key: string; wallet: { address: string | null; mode: string } | null; rulesSaved: boolean }

function Register({ suggested, onDone }: { suggested: string; onDone: (id: string) => Promise<void> }) {
  const [id, setId] = useState(suggested);
  const [name, setName] = useState("");
  const [starter, setStarter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (suggested) setId((v) => v || suggested); }, [suggested]);
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
    <form className="panel" onSubmit={submit} aria-labelledby="reg">
      <h2 id="reg">Add an agent</h2>
      <div className="two">
        <div className="field">
          <label htmlFor="reg-id">Agent id</label>
          <input id="reg-id" type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder="research-agent" pattern="[A-Za-z0-9_.:\-]{1,100}" required />
        </div>
        <div className="field">
          <label htmlFor="reg-name">Display name (optional)</label>
          <input id="reg-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Research agent" maxLength={60} />
        </div>
      </div>
      <label className="small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
        Start with safe rules: $1 per task, $5 a day, ask me above $0.50, demo sellers only
      </label>
      <div><button className="btn" type="submit" disabled={busy || !id.trim()}>{busy ? "Adding…" : "Add agent"}</button></div>
      {err && <div className="callout attention" role="alert"><p>{err}</p></div>}
      {created && (
        <div className="callout info" role="status">
          <p><strong>{created.id}</strong> is ready{created.rulesSaved ? " with starter rules" : "; it can't spend until you save rules"}. Copy its key now: it won&apos;t be shown again.</p>
          <p className="mono small" style={{ wordBreak: "break-all", userSelect: "all" }}>{created.key}</p>
          <div className="toolbar">
            <button type="button" className="btn secondary" onClick={copy}>{copied ? "Copied" : "Copy key"}</button>
            <Link className="btn secondary" href="/rules">Edit rules</Link>
          </div>
          <p className="small muted">Give it to your agent as <span className="mono">FIREWALL_AGENT_TOKEN</span>. It pays from your Circle Agent Wallet{created.wallet?.address ? <> (<span className="mono">{created.wallet.address.slice(0, 6)}…{created.wallet.address.slice(-4)}</span>)</> : null}; Wallet Buddy checks this agent&apos;s own rules before every payment.</p>
        </div>
      )}
    </form>
  );
}
