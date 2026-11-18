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
      <div className="toolbar" style={{ marginTop: "auto" }}>
        <Link className="btn secondary" href="/" onClick={onOpen}>Open</Link>
        <button className={`btn ${paused ? "" : "attention secondary"}`} onClick={toggle} disabled={busy}>
          <Icon name={paused ? "play" : "pause"} size={16} />{paused ? "Resume" : "Pause"}
        </button>
      </div>
    </article>
  );
}

function Register({ suggested, onDone }: { suggested: string; onDone: (id: string) => Promise<void> }) {
  const [id, setId] = useState(suggested);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Prefill the demo id once we know the firewall has no agents.
  useEffect(() => { if (suggested) setId((v) => v || suggested); }, [suggested]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api("/v1/agents", { method: "POST", body: { id: id.trim(), name: name.trim() || undefined } });
      setMsg({ ok: true, text: `Registered ${id.trim()}. Next: save rules for it, and add its token to FIREWALL_AGENT_TOKENS on the firewall.` });
      const done = id.trim();
      setId(""); setName("");
      await onDone(done);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError || err instanceof Error ? err.message : "Couldn't register the agent." });
    } finally { setBusy(false); }
  }
  return (
    <form className="panel" onSubmit={submit} aria-labelledby="reg">
      <h2 id="reg">Register an agent</h2>
      <p className="muted">This adds the agent to the firewall so you can give it rules and watch it. It doesn&apos;t create a wallet or a credential: the agent can&apos;t pay until it has rules and a token in <span className="mono">FIREWALL_AGENT_TOKENS</span>.</p>
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
      <div><button className="btn" type="submit" disabled={busy || !id.trim()}>{busy ? "Registering…" : "Register agent"}</button></div>
      {msg && <div className={`callout ${msg.ok ? "info" : "attention"}`} role="status"><p>{msg.text}</p></div>}
    </form>
  );
}
