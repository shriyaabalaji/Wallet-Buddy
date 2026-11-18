"use client";
import { PasskeySetup } from "@/passkey";
import { useState } from "react";
import { describeRule, usdToMicro, type AnomalySeverity, type Rule } from "@agent-firewall/policy";
import {
  api, txUrl,
  type Ambiguity, type DryRunResult, type NotifyEvent, type PolicyInfo, type RuleView,
} from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { usePoll } from "@/lib/hooks";
import { ErrorState, Icon, NoAgents, VerifyLink } from "@/components";
import { ApiError } from "@/lib/api";

const DEMO_TEXT = "Up to $10 for this task, $5 a day. Text me before anything over $1. Only pay sportsfeed and oddsapi.";
const OUTCOME_TEXT = { allow: "Pays", hold: "Texts you first", block: "Blocked" } as const;

// Which numeric field / list field each rule kind exposes for editing.
function editable(rule: Rule): { kind: "usd" | "number" | "list" | "severity"; value: string; label: string } | null {
  switch (rule.kind) {
    case "perTxLimit": case "taskBudget": case "periodBudget":
      return { kind: "usd", value: String(rule.maxMicro / 1_000_000), label: "Amount in dollars" };
    case "approvalThreshold":
      return { kind: "usd", value: String(rule.aboveMicro / 1_000_000), label: "Amount in dollars" };
    case "rateLimit":
      return { kind: "number", value: String(rule.maxPerMinute), label: "Payments per minute" };
    case "allowlist":
      return { kind: "list", value: rule.recipients.join(", "), label: "Allowed recipients (comma separated)" };
    case "categories":
      return { kind: "list", value: rule.allowed.join(", "), label: "Allowed categories (comma separated)" };
    case "anomalyGuard":
      return { kind: "severity", value: rule.minSeverity ?? "high", label: "Ask me when activity is at least" };
    default:
      return null;
  }
}

function applyEdit(rule: Rule, raw: string): Rule {
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  switch (rule.kind) {
    case "perTxLimit": case "taskBudget": case "periodBudget": return { ...rule, maxMicro: usdToMicro(raw) };
    case "approvalThreshold": return { ...rule, aboveMicro: usdToMicro(raw) };
    case "rateLimit": {
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n) || n < 1) throw new Error("Enter a whole number, 1 or more.");
      return { ...rule, maxPerMinute: n };
    }
    case "allowlist":
      if (!list.length) throw new Error("Add at least one recipient.");
      return { ...rule, recipients: list };
    case "categories":
      if (!list.length) throw new Error("Add at least one category.");
      return { ...rule, allowed: list as Extract<Rule, { kind: "categories" }>["allowed"] };
    case "anomalyGuard":
      if (!["low", "medium", "high"].includes(raw)) throw new Error("Pick low, medium or high.");
      return { ...rule, minSeverity: raw as AnomalySeverity };
    default: return rule;
  }
}

function sentenceFor(rule: Rule, views: RuleView[]) {
  return views.find((v) => v.ruleId === rule.id)?.sentence ?? describeRule(rule);
}

type SavedPolicy = { policy: (PolicyInfo & { rules: Rule[] }) | null; views: RuleView[]; notify: { phone: string | null; events: NotifyEvent[] } | null };

export default function RulesPage() {
  const { agents, agentsError, refreshAgents, agentId } = useAgents();
  if (!agents) return agentsError ? <ErrorState error={agentsError} onRetry={refreshAgents} /> : <p className="muted" role="status">Loading…</p>;
  if (!agentId) return <NoAgents />;
  // Keyed by agent: switching agents starts a fresh draft, so rules can't be saved to the wrong agent.
  return <RulesFor key={agentId} agentId={agentId} />;
}

function RulesFor({ agentId }: { agentId: string }) {
  const { agent, refreshAgents } = useAgents();
  const enc = encodeURIComponent(agentId);
  const current = usePoll(() => api<SavedPolicy>(`/v1/policy/${enc}`), 30000, agentId);
  const [text, setText] = useState(DEMO_TEXT);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [views, setViews] = useState<RuleView[]>([]);
  const [ambiguities, setAmbiguities] = useState<Ambiguity[]>([]);
  const [tests, setTests] = useState<DryRunResult[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editErr, setEditErr] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<NotifyEvent, boolean>>({ hold: true, budget80: false, paused: true });
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<"compile" | "save" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<PolicyInfo | null>(null);
  const [pausing, setPausing] = useState(false);

  const fail = (e: unknown) => setError(e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : "Something went wrong.", 0));

  async function runTests(r: Rule[]) {
    try {
      const res = await api<{ results: DryRunResult[] }>("/v1/rules/dry-run", { method: "POST", body: { agentId, rules: r } });
      setTests(res.results);
    } catch (e) { fail(e); }
  }

  async function compile() {
    setBusy("compile"); setError(null); setSaved(null); setEditing(null);
    try {
      const res = await api<{ rules: Rule[]; views: RuleView[]; ambiguities: Ambiguity[] }>("/v1/rules/compile", { method: "POST", body: { text } });
      setRules(res.rules); setViews(res.views); setAmbiguities(res.ambiguities); setTests(null);
      await runTests(res.rules);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }

  function startEdit(rule: Rule) {
    setEditing(rule.id); setEditErr(null); setDraft(editable(rule)?.value ?? "");
  }

  async function commitEdit(rule: Rule) {
    try {
      const updated = applyEdit(rule, draft);
      const next = (rules ?? []).map((r) => (r.id === rule.id ? updated : r));
      setRules(next);
      // The compiler's sentence is stale after an edit, so regenerate it locally.
      setViews((vs) => vs.map((v) => (v.ruleId === rule.id ? { ...v, sentence: describeRule(updated) } : v)));
      setEditing(null); setSaved(null);
      await runTests(next);
    } catch (e) { setEditErr(e instanceof Error ? e.message : "That value doesn't look right."); }
  }

  async function save() {
    if (!rules) return;
    setBusy("save"); setError(null);
    try {
      const notify = phone.trim()
        ? { phone: phone.trim(), events: (Object.keys(events) as NotifyEvent[]).filter((k) => events[k]) }
        : undefined;
      const res = await api<{ policy: PolicyInfo }>("/v1/policy", { method: "POST", body: { agentId, rules, notify, confirmed: true } });
      setSaved(res.policy);
      await Promise.all([current.refresh(), refreshAgents()]);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }

  /** Load the saved rules into the editor; they go through the same review → quick test → confirm path. */
  async function editCurrent() {
    const p = current.data;
    if (!p?.policy) return;
    setError(null); setSaved(null); setEditing(null); setAmbiguities([]); setTests(null);
    setRules(p.policy.rules); setViews(p.views);
    if (p.notify?.phone) {
      setPhone(p.notify.phone);
      setEvents({ hold: p.notify.events.includes("hold"), budget80: p.notify.events.includes("budget80"), paused: p.notify.events.includes("paused") });
    }
    await runTests(p.policy.rules);
  }

  const paused = agent?.status === "paused";
  async function togglePause() {
    setPausing(true); setError(null);
    try {
      await api(`/v1/agents/${enc}/${paused ? "resume" : "pause"}`, { method: "POST", body: paused ? {} : { reason: "Paused from the Rules page" } });
      await refreshAgents();
    } catch (e) { fail(e); } finally { setPausing(false); }
  }

  return (
    <>
      <section className="row" aria-label="Agent">
        <div>
          <p className="crumbs">Rules for <span className="mono">{agentId}</span></p>
          <h1>Your rules</h1>
        </div>
        <div className="toolbar">
          <button className={`btn ${paused ? "" : "attention secondary"}`} onClick={togglePause} disabled={pausing || !agent}>
            <Icon name={paused ? "play" : "pause"} size={16} />{paused ? "Resume agent" : "Pause agent"}
          </button>
        </div>
      </section>
      {paused && <div className="callout attention" role="status"><strong>This agent is paused</strong><p>It can&apos;t spend anything until you resume it{agent?.pausedReason ? `. Reason: ${agent.pausedReason}` : ""}.</p></div>}

      <section className="panel" aria-labelledby="s0">
        <div className="panel-head">
          <h2 id="s0">Rules in force now</h2>
          {current.data?.policy && <button className="btn secondary" onClick={editCurrent} disabled={busy !== null}><Icon name="edit" size={16} />Edit these rules</button>}
        </div>
        {current.error && !current.data ? <ErrorState error={current.error} onRetry={current.refresh} /> : !current.data ? (
          <p className="muted" role="status">Loading…</p>
        ) : !current.data.policy ? (
          <p className="muted">No rules saved for this agent, so it can&apos;t spend anything. Describe them below.</p>
        ) : (
          <>
            <ul className="pol">{current.data.views.map((v) => <li key={v.ruleId}><span className="kind">Enforced by {v.enforcedBy}</span><span>{v.sentence}</span></li>)}</ul>
            <p className="lockline"><Icon name="lock" size={15} />Fingerprint <span className="mono">{current.data.policy.hash.slice(0, 10)}…</span><VerifyLink href={txUrl(current.data.policy.committedTx, current.data.policy.committedTxUrl)}>verify</VerifyLink></p>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="s1">
        <h2 id="s1"><span className="step-n" aria-hidden="true">1</span>{current.data?.policy ? "Or describe new rules" : "Tell us"}</h2>
        <div className="field">
          <label htmlFor="rules-text">Describe what your agent may spend, in your own words.</label>
          <textarea id="rules-text" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div><button className="btn" onClick={compile} disabled={busy !== null || !text.trim()}>{busy === "compile" ? "Reading…" : "Compile"}</button></div>
      </section>

      {error && <ErrorState error={error} />}

      <PasskeySetup />

      {rules && (
        <>
          <section className="panel" aria-labelledby="s2">
            <h2 id="s2"><span className="step-n" aria-hidden="true">2</span>Here&apos;s what will apply to <span className="mono">{agentId}</span></h2>
            {ambiguities.map((a) => (
              <div key={a.phrase} className="callout attention" role="note">
                <strong>Not sure about &ldquo;{a.phrase}&rdquo;</strong>
                <p>{a.question}</p>
              </div>
            ))}
            {rules.length === 0 && <p className="muted">We couldn&apos;t find any rules in that. Try adding amounts, like &ldquo;$5 a day&rdquo;.</p>}
            {rules.map((rule) => {
              const view = views.find((v) => v.ruleId === rule.id);
              const ed = editable(rule);
              const fid = `edit-${rule.id}`;
              return (
                <div className="rule" key={rule.id}>
                  <p className="sentence">{sentenceFor(rule, views)}</p>
                  <p className="meta">Enforced by: {view?.enforcedBy ?? "the firewall"}</p>
                  {editing === rule.id && ed ? (
                    <div>
                      <label htmlFor={fid} className="muted">{ed.label}</label>
                      <div className="edit-row">
                        {ed.kind === "severity" ? (
                          <select id={fid} value={draft} onChange={(e) => setDraft(e.target.value)}>
                            <option value="low">Slightly unusual</option><option value="medium">Unusual</option><option value="high">Highly unusual</option>
                          </select>
                        ) : (
                          <input id={fid} type="text" value={draft} onChange={(e) => setDraft(e.target.value)} inputMode={ed.kind === "list" ? "text" : "decimal"} />
                        )}
                        <button className="btn" onClick={() => commitEdit(rule)}>Apply</button>
                        <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                      {editErr && <p role="alert" style={{ color: "var(--orange)" }}>{editErr}</p>}
                    </div>
                  ) : ed ? (
                    <div><button className="btn secondary" onClick={() => startEdit(rule)} aria-label={`Edit: ${sentenceFor(rule, views)}`}>Edit</button></div>
                  ) : null}
                </div>
              );
            })}
          </section>

          <section className="panel" aria-labelledby="s3">
            <h2 id="s3"><span className="step-n" aria-hidden="true">3</span>Quick test</h2>
            <p className="muted">Sample payments run against these rules. Nothing is spent.</p>
            {!tests ? <p className="muted" role="status">Running…</p> : (
              <ul className="tests">
                {tests.map((t) => (
                  <li key={t.label}>
                    <span className={`badge ${t.outcome === "allow" ? "ok" : "warn"}`}>{OUTCOME_TEXT[t.outcome]}</span>
                    <strong>{t.label}</strong>
                    <span className="muted">{t.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="s4">
            <h2 id="s4">Text me when</h2>
            <div>
              <label className="check"><input type="checkbox" checked={events.hold} onChange={(e) => setEvents({ ...events, hold: e.target.checked })} /> A payment needs my approval</label>
              <label className="check"><input type="checkbox" checked={events.budget80} onChange={(e) => setEvents({ ...events, budget80: e.target.checked })} /> 80% of the budget is used</label>
              <label className="check"><input type="checkbox" checked={events.paused} onChange={(e) => setEvents({ ...events, paused: e.target.checked })} /> My agent gets paused</label>
            </div>
            <div className="field">
              <label htmlFor="phone">Your phone number</label>
              <input id="phone" type="tel" autoComplete="tel" placeholder="+1 555 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <p className="muted">Saving replaces the rules for <span className="mono">{agentId}</span> and locks a fingerprint on Arc (about 1¢). Nothing changes until you press the button.</p>
            <div><button className="btn" onClick={save} disabled={busy !== null || rules.length === 0}>{busy === "save" ? "Saving…" : "Save rules"}</button></div>
            {saved && (
              <div className="callout info" role="status">
                <strong>Rules saved{saved.committedTx || saved.committedTxUrl ? " and locked on Arc" : ""}</strong>
                <p className="mono" style={{ wordBreak: "break-all" }}>{saved.hash}</p>
                <VerifyLink href={txUrl(saved.committedTx, saved.committedTxUrl)} />
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
