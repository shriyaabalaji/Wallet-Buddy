"use client";
import Link from "next/link";
import { useState } from "react";
import { formatUsd } from "@agent-firewall/policy";
import { api, txUrl, type AnomalyItem, type Health, type SeriesBucket, type Summary } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { useNow, usePoll } from "@/lib/hooks";
import { ANOMALY_LABEL, Avatar, ErrorState, Icon, Money, NoAgents, OutcomeBadge, SeverityPill, VerifyLink, shortAddr, shortTime } from "@/components";
import type { ActivityItem } from "@/lib/api";

const KIND: Record<string, string> = {
  perTxLimit: "Per payment", taskBudget: "Task budget", periodBudget: "Spending cap", categories: "Categories",
  allowlist: "Recipients", timeWindow: "Hours", rateLimit: "Rate limit", approvalThreshold: "Approval", paused: "Pause",
  anomalyGuard: "Unusual activity",
};

export default function Home() {
  const { agents, agentsError, refreshAgents, agentId } = useAgents();
  if (!agents) return agentsError ? <ErrorState error={agentsError} onRetry={refreshAgents} /> : <p className="muted" role="status">Loading…</p>;
  if (!agentId) return <NoAgents />;
  return <Overview agentId={agentId} />;
}

function Overview({ agentId }: { agentId: string }) {
  const { health, refreshAgents } = useAgents();
  const enc = encodeURIComponent(agentId);
  const { data, error, refresh } = usePoll(() => api<Summary>(`/v1/agents/${enc}/summary`), 3000, agentId);
  const { data: risk } = usePoll(() => api<{ items: AnomalyItem[] }>(`/v1/agents/${enc}/anomalies?limit=60`), 10000, agentId);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const now = useNow(1000);

  if (!data) {
    return error ? <ErrorState error={error} onRetry={refresh} /> : <p className="muted" role="status">Loading…</p>;
  }

  const paused = data.agent.status === "paused";
  async function toggle() {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/v1/agents/${enc}/${paused ? "resume" : "pause"}`, { method: "POST", body: {} });
      await Promise.all([refresh(), refreshAgents()]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't update the agent.");
    } finally {
      setBusy(false);
    }
  }

  const { task, today, pending, recent, rules, policy, totals, series } = data;
  const ev = totals.evidence;
  const pct = (spent: number, cap: number | null) => (cap ? Math.min(100, (spent / cap) * 100) : 0);
  const dayLeft = today.capMicro !== null ? Math.max(0, today.capMicro - today.spentMicro) : null;
  const policyUrl = policy ? txUrl(policy.committedTx, policy.committedTxUrl) : null;
  const name = data.agent.name.charAt(0).toUpperCase() + data.agent.name.slice(1);

  return (
    <>
      {error && <ErrorState error={error} onRetry={refresh} />}
      <section className="row" aria-label="Agent status">
        <div>
          <p className="crumbs"><Link href="/agents">Agents</Link> / <span className="mono">{data.agent.id}</span>{task.id && <> / <span className="mono">{task.id}</span></>}</p>
          <h1>{name}<span className="soft">, {paused ? "paused" : "working within your rules"}</span></h1>
        </div>
        <div className="toolbar">
          <Link className="btn secondary" href="/rules"><Icon name="edit" size={16} />Edit rules</Link>
          <button className={`btn ${paused ? "" : "attention secondary"}`} onClick={toggle} disabled={busy}>
            <Icon name={paused ? "play" : "pause"} size={16} />{paused ? "Resume agent" : "Pause agent"}
          </button>
        </div>
      </section>
      {paused && data.agent.pausedReason && <p className="muted">Paused because: {data.agent.pausedReason}</p>}
      {actionError && <p role="alert" style={{ color: "var(--orange)" }}>{actionError}</p>}

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

      {health?.mockPayments && (
        <div className="callout" role="note">
          <strong>Simulated payments.</strong> This firewall runs with mock sellers (MOCK_PAYMENTS=1): they accept any payment, so &ldquo;paid&rdquo; amounts here never moved money.
        </div>
      )}
      {ev && ev.uncertainCount > 0 && (
        <div className="callout attention" role="status">
          <div>
            <strong>{ev.uncertainCount === 1 ? "1 payment needs" : `${ev.uncertainCount} payments need`} reconciling</strong> · {formatUsd(ev.uncertainMicro)}
            <p className="muted">They failed after the payment started, so money may have moved. They stay counted against budgets until you check and mark them.</p>
          </div>
          <Link className="btn attention secondary" href={`/activity?agent=${enc}&status=reconcile`}>Review</Link>
        </div>
      )}

      <section className="cards kpis" aria-label="Today">
        <div className="card">
          <span className="label" title="The seller accepted the payment through Circle Gateway (Gateway settles on Arc in batches), or you released it from the vault. None of it is an onchain settlement we verified, except vault releases.">Paid today · via Gateway</span>
          <Money micro={totals.paidMicro} size="md" />
          {ev && <EvidenceLines lines={[
            [ev.simulatedMicro, "simulated, no money moved"],
            [ev.acceptedNoReferenceMicro, "no transaction reference"],
            [ev.acceptedWithReferenceMicro, "reference not verified onchain"],
            [ev.confirmedOnchainMicro, "vault release confirmed on Arc"],
            [ev.approvedUnrecordedMicro, "approved, release not on Arc"],
          ]} />}
        </div>
        <div className="card">
          <span className="label" title="Allowed and counted against budgets, but not confirmed paid yet.">Reserved, not confirmed</span>
          <Money micro={totals.inProgressMicro} size="md" />
          {ev && <EvidenceLines lines={[
            [ev.pendingSignatureMicro, "not paid yet"],
            [ev.awaitingOutcomeMicro, "sent, waiting for the outcome"],
            [ev.uncertainMicro, "outcome unknown, needs reconciling"],
          ]} />}
        </div>
        <div className={`card ${totals.heldMicro ? "attention" : ""}`}>
          <span className="label">Held for your OK</span>
          <Money micro={totals.heldMicro} size="md" />
        </div>
        <div className="card">
          <span className="label">Requests today</span>
          <span className="tags">
            <span className="pill ok">{totals.counts.allowed} allowed</span>
            <span className="pill warn">{totals.counts.held} held</span>
            <span className="pill warn">{totals.counts.blocked} blocked</span>
          </span>
          {totals.counts.ownerApproved > 0 && <span className="label">{totals.counts.ownerApproved} approved by you</span>}
        </div>
      </section>

      <section className="bento" aria-label="Spending">
        <div className="stack">
          <div className="card">
            <div className="card-top">
              <h2>Daily allowance</h2>
              <Link className="round-link" href="/rules" aria-label="Change limits"><Icon name="arrow" size={16} /></Link>
            </div>
            <div className="hero">
              <div className="row1"><span>USDC</span><span className="k">Arc testnet</span></div>
              <div>
                <span className="k">Can still spend today</span><br />
                {dayLeft !== null ? <Money micro={dayLeft} size="xl" /> : <span className="money xl">No cap</span>}
              </div>
              {today.capMicro !== null && <div className="hero-bar" aria-hidden="true"><span style={{ width: `${pct(today.spentMicro, today.capMicro)}%` }} /></div>}
              <div className="row3"><span>{formatUsd(today.spentMicro)}{today.capMicro !== null ? ` of ${formatUsd(today.capMicro)}` : ""} used</span><span>resets {resetTime(now)}</span></div>
            </div>
          </div>
          <div className="card">
            <div className="card-top"><h2>Task budget</h2>{task.id && <span className="mono muted small">{task.id}</span>}</div>
            {task.id ? (
              <>
                <div className="row">
                  <span><Money micro={task.spentMicro} size="md" />{task.budgetMicro !== null && <span className="muted"> / {formatUsd(task.budgetMicro)}</span>}</span>
                  {task.budgetMicro !== null && <span className="pill ok">{Math.round(pct(task.spentMicro, task.budgetMicro))}% used</span>}
                </div>
                {task.budgetMicro !== null && <div className="bar"><span style={{ width: `${pct(task.spentMicro, task.budgetMicro)}%` }} /></div>}
              </>
            ) : (
              <p className="muted">No task yet. It appears with the agent&apos;s first payment request.</p>
            )}
          </div>
        </div>

        <SpendChart series={series} />

        <div className="stack">
          <div className="card">
            <div className="card-top">
              <h2>Stopped by Wallet Buddy</h2>
              <Link className="round-link" href={`/activity?agent=${enc}&status=blocked`} aria-label="See blocked payments"><Icon name="arrow" size={16} /></Link>
            </div>
            <div className="row" style={{ marginTop: "auto" }}>
              <Money micro={totals.stoppedMicro} size="lg" />
              <span className="pill warn">{totals.counts.blocked} blocked today</span>
            </div>
          </div>
          <div className={`card ${pending.length ? "attention" : ""}`}>
            <div className="card-top"><h2>Waiting for you</h2></div>
            {pending.length === 0
              ? <p className="muted">Nothing is waiting.</p>
              : <p className="lockline" style={{ color: "var(--orange)" }}><Icon name="clock" size={16} />{pending.length} held · {fmtLeft(new Date(pending[0]!.expiresAt).getTime() - now)}</p>}
          </div>
        </div>

        <div className="panel flush span2">
          <div className="panel-bar">
            <h2>Payment history</h2>
            <Link className="round-link" href={`/activity?agent=${enc}`} aria-label="View all activity"><Icon name="arrow" size={16} /></Link>
          </div>
          {recent.length === 0 ? (
            <p className="muted" style={{ padding: "0 22px 22px" }}>Nothing yet. Payments appear here as your agent pays.</p>
          ) : (
            <div className="tx-wrap">
              <table className="tx">
                <thead><tr><th>Time</th><th>To</th><th>Status</th><th className="r">Amount</th><th className="r hide-sm">Arc tx</th></tr></thead>
                <tbody>{recent.slice(0, 6).map((a) => <TxRow key={a.requestId} a={a} />)}</tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-top">
            <h2>Your rules</h2>
            <Link className="round-link" href="/rules" aria-label="Change rules"><Icon name="edit" size={16} /></Link>
          </div>
          {rules.length === 0 ? (
            <p className="muted">No rules yet, so the agent can&apos;t spend. <Link href="/rules">Set your rules</Link></p>
          ) : (
            <ul className="pol">{rules.map((r) => <li key={r.ruleId}><span className="kind">{KIND[r.kind] ?? r.kind}</span><span>{r.sentence}</span></li>)}</ul>
          )}
          <p className="lockline" style={{ marginTop: "auto" }}>
            <Icon name="lock" size={15} />{policy ? "Locked on Arc" : "Not locked on Arc yet"}
            <VerifyLink href={policyUrl}>verify</VerifyLink>
          </p>
        </div>

        <RiskPanel agentId={agentId} items={risk?.items ?? null} />
        <PriceCheck agentId={agentId} />
        <FundingCard health={health} />
      </section>
    </>
  );
}

// ---------- spending chart ----------
type Mode = "usd" | "count";
function SpendChart({ series }: { series: SeriesBucket[] }) {
  const [mode, setMode] = useState<Mode>("usd");
  const v = (b: SeriesBucket) => (mode === "usd" ? [b.paidMicro, b.inProgressMicro, b.stoppedMicro] : [b.paid, b.inProgress, b.stopped]) as [number, number, number];
  const peak = Math.max(0, ...series.map((b) => v(b).reduce((x, y) => x + y, 0)));
  const fmt = (n: number) => (mode === "usd" ? formatUsd(n) : String(n));
  const label = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric" });
  const top = niceTop(peak, mode === "usd" ? 10_000 : 4);
  const ticks = [0, 1, 2, 3, 4].map((i) => (top / 4) * i);
  return (
    <div className="card chart-card">
      <div className="card-top">
        <h2>Spending by hour</h2>
        <div className="filters small-filters" role="group" aria-label="Chart units">
          <button className="btn secondary" aria-pressed={mode === "usd"} onClick={() => setMode("usd")}>USDC</button>
          <button className="btn secondary" aria-pressed={mode === "count"} onClick={() => setMode("count")}>Payments</button>
        </div>
      </div>
      <div className="legend"><span><i className="sw" />Paid</span><span><i className="sw pending" />Reserved or held</span><span><i className="sw stopped" />Stopped</span></div>
      {peak === 0 ? (
        <div className="chart-empty">No payments in the last 8 hours.</div>
      ) : (
        <div className="chart" role="img" aria-label={`Last 8 hours: ${series.map((b) => { const [p, i, s] = v(b); return `${label(b.start)} ${fmt(p)} paid, ${fmt(i)} reserved or held, ${fmt(s)} stopped`; }).join("; ")}`}>
          <div className="yaxis" aria-hidden="true">{ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{mode === "usd" ? compactUsd(t) : t}</span>)}</div>
          <div className="plot">
            {series.map((b) => {
              const [p, i, s] = v(b);
              return (
                <div className="col" key={b.start} tabIndex={0} aria-hidden="true">
                  {p > 0 && <span className="seg" style={{ height: `${(p / top) * 100}%` }} />}
                  {i > 0 && <span className="seg pending" style={{ height: `${(i / top) * 100}%` }} />}
                  {s > 0 && <span className="seg stopped" style={{ height: `${(s / top) * 100}%` }} />}
                  <span className="tip">{label(b.start)} · {fmt(p)} paid · {fmt(i)} reserved/held · {fmt(s)} stopped</span>
                  <span className="x">{label(b.start)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Smallest 1/2/2.5/5 × 10^k step so that four steps cover the peak (and at least `min`). */
function niceTop(peak: number, min: number) {
  const target = Math.max(peak, min) / 4;
  const pow = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= target)!;
  return step * 4;
}
const compactUsd = (micro: number) => (micro === 0 ? "0" : micro < 1_000_000 ? `${Math.round(micro / 10_000)}¢` : `$${+(micro / 1_000_000).toFixed(2)}`);

// ---------- risk ----------
const RANK = { low: 0, medium: 1, high: 2 } as const;
function RiskPanel({ agentId, items }: { agentId: string; items: AnomalyItem[] | null }) {
  const enc = encodeURIComponent(agentId);
  // One row per flagged request (a request can carry several signals), most severe signal first.
  const byRequest = new Map<string, AnomalyItem[]>();
  for (const i of items ?? []) byRequest.set(i.requestId, [...(byRequest.get(i.requestId) ?? []), i]);
  const rows = [...byRequest.values()].map((sigs) => sigs.sort((a, b) => RANK[b.severity] - RANK[a.severity])).slice(0, 6);
  return (
    <div className="panel flush span2">
      <div className="panel-bar">
        <h2>Unusual activity</h2>
        <Link className="round-link" href={`/activity?agent=${enc}&flagged=1`} aria-label="All flagged requests"><Icon name="arrow" size={16} /></Link>
      </div>
      {!items ? (
        <p className="muted pad" role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted pad">Nothing unusual compared with how this agent usually spends.</p>
      ) : (
        <ul className="risk">
          {rows.map((sigs) => {
            const top = sigs[0]!;
            return (
              <li key={top.requestId}>
                <div className="risk-head">
                  <SeverityPill severity={top.severity} />
                  <strong>{sigs.map((s) => ANOMALY_LABEL[s.type]).join(" · ")}</strong>
                  <span className="muted mono small">{shortTime(top.at)}</span>
                </div>
                <p>{top.explanation}</p>
                <div className="risk-meta">
                  <OutcomeBadge outcome={top.outcome} status={top.status} />
                  <span className="mono small">{formatUsd(top.amountMicro)} → {shortAddr(top.recipient)}</span>
                  <span className="muted small">task <span className="mono">{top.taskId}</span></span>
                  <Link className="small" href={`/activity?agent=${enc}&request=${encodeURIComponent(top.requestId)}`}>View record</Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- payment optimizer (demo providers only) ----------
interface OptCandidate { providerId: string; name: string; demo: boolean; compatible: boolean; eligible: boolean; reason: string;
  quote: { amountMicro: number; source: string; ageMs: number; fresh: boolean; latencyMs: number } | null }
interface OptRec { candidates: OptCandidate[]; recommended: { providerId: string; amountMicro: number } | null;
  baseline: { providerId: string; amountMicro: number; eligible: boolean } | null; estimatedSavingsMicro: number | null; explanation: string; demoProvidersOnly: boolean }
interface OptHistory { items: { status: string; realizedSavingsMicro: number | null }[]; realizedSavingsMicro: number }
function PriceCheck({ agentId }: { agentId: string }) {
  const [rec, setRec] = useState<OptRec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: hist, refresh } = usePoll(() => api<OptHistory>(`/v1/optimizer/recommendations?agentId=${encodeURIComponent(agentId)}`), 15000, agentId);
  async function check() {
    setBusy(true); setErr(null);
    try {
      setRec(await api<OptRec>("/v1/optimizer/recommend", { method: "POST", body: { agentId, taskId: "price-check", need: { category: "data", sku: "injury-report" }, maxAmountMicro: 1_000_000 } }));
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't check prices."); } finally { setBusy(false); }
  }
  const settled = hist?.items.filter((i) => i.realizedSavingsMicro !== null).length ?? 0;
  return (
    <div className="card">
      <div className="card-top">
        <h2>Price check</h2>
        <button className="btn secondary small" onClick={check} disabled={busy}>{busy ? "Checking…" : "Compare"}</button>
      </div>
      {err && <p className="warn-text small" role="alert">{err}</p>}
      {rec && (
        <ul className="pol">
          {rec.candidates.filter((c) => c.compatible).map((c) => (
            <li key={c.providerId}>
              <span className="kind">{c.providerId === rec.recommended?.providerId ? "Best" : c.eligible ? "Option" : "Skipped"}</span>
              <span>{c.name}: {c.quote ? formatUsd(c.quote.amountMicro) : "no quote"}{c.quote ? <span className="muted small"> · {Math.round(c.quote.ageMs / 1000)}s old · {c.quote.latencyMs}ms</span> : null}{!c.eligible && <span className="muted small"> · {c.reason}</span>}</span>
            </li>
          ))}
        </ul>
      )}
      {rec && <p className="small">{rec.estimatedSavingsMicro ? <>Estimated {formatUsd(rec.estimatedSavingsMicro)} cheaper than {rec.baseline?.providerId}, from live quotes. Not saved until a payment settles.</> : rec.recommended ? "No saving to claim." : "No eligible provider."}</p>}
      <p className="lockline" style={{ marginTop: "auto" }}>Saved so far: {hist ? formatUsd(hist.realizedSavingsMicro) : "—"}<span className="muted small">&nbsp;({settled} settled purchase{settled === 1 ? "" : "s"} that followed a recommendation)</span></p>
    </div>
  );
}

// ---------- funding ----------
const usd = (n: number) => formatUsd(Math.round(n * 1e6));
function FundingCard({ health }: { health: Health | null }) {
  const vault = health?.vault;
  const buyer = health?.buyer;
  return (
    <div className="card">
      <div className="card-top"><h2>Funding &amp; Arc</h2></div>
      {!health ? (
        <p className="muted" role="status">Loading…</p>
      ) : (
        <div className="facts">
          <div className="kv"><span>Payer</span><span>{health.paymentMode === "circle-agent-wallet" ? "Circle Agent Wallet" : health.paymentMode === "local-key" ? "Firewall key (testnet)" : "—"}</span></div>
          {health.signer && <div className="kv"><span>Address</span><span className="mono">{shortAddr(health.signer)}</span></div>}
          <div className="kv"><span>Gateway balance</span><span>{buyer && "gatewayAvailableUsdc" in buyer ? usd(buyer.gatewayAvailableUsdc) : buyer && "error" in buyer ? "Couldn't read" : "Not tracked"}</span></div>
          {buyer && "dailyCapUsdc" in buyer && <div className="kv"><span>Topped up today</span><span>{usd(buyer.depositedTodayUsdc)} of {usd(buyer.dailyCapUsdc)}</span></div>}
          <div className="kv"><span>Vault allowance</span>
            <span>{vault && "allowanceUsdc" in vault ? <>{usd(vault.allowanceUsdc)}{vault.low && <span className="pill warn"> Low</span>}</> : vault && "error" in vault ? "Couldn't read" : "Not configured"}</span>
          </div>
          {vault && "treasuryUsdc" in vault && <div className="kv"><span>Treasury</span><span>{usd(vault.treasuryUsdc)}</span></div>}
          <div className="kv"><span>Rules registry</span><span>{health.arc?.registry ? "Connected" : "Not configured"}</span></div>
          <div className="kv"><span>Approval vault</span><span>{health.arc?.vault ? "Connected" : "Not configured"}</span></div>
          <div className="kv"><span>Text messages</span><span>{health.twilio ? "Twilio" : "Dry run"}</span></div>
        </div>
      )}
    </div>
  );
}

/** Breakdown under a money tile: only the non-zero parts, so a tile never lists $0.00 lines. */
function EvidenceLines({ lines }: { lines: [number, string][] }) {
  const shown = lines.filter(([m]) => m > 0);
  if (shown.length === 0) return null;
  return <span className="label">{shown.map(([m, what]) => `${formatUsd(m)} ${what}`).join(" · ")}</span>;
}

// ---------- rows ----------
function TxRow({ a }: { a: ActivityItem }) {
  const struck = ["blocked", "released", "denied", "expired"].includes(a.status);
  const purpose = a.purpose?.trim() || a.category;
  // The address is already in the row; drop it from the reason ("0x7a3f…c91e isn't on…" → "Isn't on…").
  const why = a.reason.replace(/^0x[0-9a-f]+…[0-9a-f]+\s+(\w)/i, (_, c: string) => c.toUpperCase());
  const flagged = (a.anomalies ?? []).filter((x) => x.severity !== "low").map((x) => ANOMALY_LABEL[x.type]);
  const memo = [struck || a.status === "held" ? `${purpose} · ${why}` : purpose, ...flagged].join(" · ");
  const url = txUrl(a.arcTx, a.arcTxUrl);
  return (
    <tr>
      <td className="t-time muted mono nowrap">{shortTime(a.at)}</td>
      <td className="t-to">
        <span className="who">
          <Avatar recipient={a.recipient} />
          <span style={{ minWidth: 0 }}>
            <span className={/^0x/i.test(a.recipient) ? "mono" : ""} title={a.recipient}>{shortAddr(a.recipient)}</span>
            <span className="memo">{memo}</span>
          </span>
        </span>
      </td>
      <td className="t-status"><OutcomeBadge outcome={a.outcome} status={a.status} settlement={a.settlement} /></td>
      <td className={`t-amt r mono ${struck ? "strike" : ""}`}>{formatUsd(a.amountMicro)}</td>
      <td className="r hide-sm">{url ? <a className="mono" href={url} target="_blank" rel="noreferrer">{(a.arcTx ?? "").slice(0, 8)}…</a> : <span className="muted" title="Not yet in the batched decision log on Arc. This is the audit log, not the payment.">not logged yet</span>}</td>
    </tr>
  );
}

/** Daily budgets reset at 00:00 UTC (packages/policy periods.ts); show that moment in the viewer's time. */
function resetTime(now: number) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return new Date(next).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "");
}

function fmtLeft(ms: number) {
  if (ms <= 0) return "refunding";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `refunds in ${m}:${String(s).padStart(2, "0")}`;
}
