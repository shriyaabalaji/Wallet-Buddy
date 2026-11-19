"use client";
import Link from "next/link";
import { useState } from "react";
import { formatUsd } from "@agent-firewall/policy";
import { ARC_EXPLORER, api, txUrl, type ActivityItem, type Health, type Summary } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { useNow, usePoll } from "@/lib/hooks";
import { ANOMALY_LABEL, Avatar, ErrorState, Icon, Money, NoAgents, OutcomeBadge, shortAddr, shortTime } from "@/components";

export default function Home() {
  const { agents, agentsError, refreshAgents, agentId } = useAgents();
  if (!agents) return agentsError ? <ErrorState error={agentsError} onRetry={refreshAgents} /> : <p className="muted" role="status">Loading…</p>;
  if (!agentId) return <NoAgents />;
  return <Overview agentId={agentId} />;
}

/**
 * What an owner needs at a glance: money in the agent's wallet, what it can still spend today, what is waiting for
 * approval, what got stopped, and the latest payments. Bookkeeping detail (reservations, evidence splits) lives in Activity.
 */
function Overview({ agentId }: { agentId: string }) {
  const { health, refreshAgents } = useAgents();
  const enc = encodeURIComponent(agentId);
  const { data, error, refresh } = usePoll(() => api<Summary>(`/v1/agents/${enc}/summary`), 3000, agentId);
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

  const { task, today, pending, recent, totals } = data;
  const ev = totals.evidence;
  const pct = (spent: number, cap: number | null) => (cap ? Math.min(100, (spent / cap) * 100) : 0);
  const dayLeft = today.capMicro !== null ? Math.max(0, today.capMicro - today.spentMicro) : null;
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
        <div className="callout attention alert" role="status">
          <div>
            <strong>{ev.uncertainCount === 1 ? "1 payment needs" : `${ev.uncertainCount} payments need`} checking</strong> · {formatUsd(ev.uncertainMicro)}
            <p className="muted">It failed after paying started, so money may have moved.</p>
          </div>
          <Link className="btn attention secondary" href={`/activity?agent=${enc}&status=reconcile`}>Review</Link>
        </div>
      )}

      <section className="glance" aria-label="Money">
        <BalanceCard health={health} />

        <div className="card">
          <div className="card-top">
            <h2>Can still spend today</h2>
            <Link className="round-link" href="/rules" aria-label="Change limits"><Icon name="arrow" size={16} /></Link>
          </div>
          {dayLeft !== null ? <Money micro={dayLeft} size="lg" /> : <span className="money lg">No cap</span>}
          {today.capMicro !== null && <div className="bar" aria-hidden="true"><span style={{ width: `${pct(today.spentMicro, today.capMicro)}%` }} /></div>}
          <p className="small muted">{formatUsd(today.spentMicro)}{today.capMicro !== null ? ` of ${formatUsd(today.capMicro)}` : ""} spent · resets {resetTime(now)}</p>
          {task.id && task.budgetMicro !== null && (
            <p className="small muted foot">Task <span className="mono">{task.id}</span>: {formatUsd(Math.max(0, task.budgetMicro - task.spentMicro))} left of {formatUsd(task.budgetMicro)}</p>
          )}
        </div>

        <div className="card">
          <div className="card-top">
            <h2>Stopped today</h2>
            <Link className="round-link" href={`/activity?agent=${enc}&status=blocked`} aria-label="See blocked payments"><Icon name="arrow" size={16} /></Link>
          </div>
          <Money micro={totals.stoppedMicro} size="lg" />
          <span className="tags">
            <span className={`pill ${totals.counts.blocked ? "warn" : "quiet"}`}>{totals.counts.blocked} blocked</span>
            {totals.counts.ownerApproved > 0 && <span className="pill ok">{totals.counts.ownerApproved} approved by you</span>}
          </span>
          {totals.anomalies.flaggedRequests > 0 && (
            <Link className="small foot" href={`/activity?agent=${enc}&flagged=1`}>
              {totals.anomalies.flaggedRequests === 1 ? "1 request" : `${totals.anomalies.flaggedRequests} requests`} flagged as unusual
            </Link>
          )}
        </div>
      </section>

      <section className="panel flush" aria-label="Recent payments">
        <div className="panel-bar">
          <h2>Recent payments</h2>
          <Link className="round-link" href={`/activity?agent=${enc}`} aria-label="View all activity"><Icon name="arrow" size={16} /></Link>
        </div>
        {recent.length === 0 ? (
          <p className="muted pad">Nothing yet. Payments appear here as your agent pays.</p>
        ) : (
          <div className="tx-wrap">
            <table className="tx">
              <thead><tr><th>Time</th><th>To</th><th>Status</th><th className="r">Amount</th><th className="r hide-sm">Arc tx</th></tr></thead>
              <tbody>{recent.slice(0, 5).map((a) => <TxRow key={a.requestId} a={a} />)}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ---------- balance ----------
/** Whole cents, rounded down, for balances read from chain (they carry 6 decimals): never overstate money. */
const centsMicro = (usdc: number) => Math.floor(usdc * 100 + 1e-9) * 10_000;
const cents = (usdc: number) => formatUsd(centsMicro(usdc));
/**
 * The agent's spendable money: its Circle Gateway balance, from the owner view of GET /health (buyer = funding.ts
 * fundingStatus; vault = the treasury that tops it up). Shared with the shell's health poll, so no extra request.
 */
function BalanceCard({ health }: { health: Health | null }) {
  const buyer = health?.buyer;
  const vault = health?.vault;
  const live = buyer && "gatewayAvailableUsdc" in buyer ? buyer : null;
  const addr = live?.payer ?? health?.signer ?? null;
  const treasury = vault && "treasuryUsdc" in vault ? vault : null;
  const topUpLeft = live ? Math.max(0, live.dailyCapUsdc - live.depositedTodayUsdc) : null;
  return (
    <div className="hero balance">
      <div className="row1"><h2>Balance</h2><span className="k">USDC · Arc {health?.network ?? "testnet"}</span></div>
      {!health ? (
        <p className="k" role="status">Loading…</p>
      ) : live ? (
        <div>
          <Money micro={centsMicro(live.gatewayAvailableUsdc)} size="xl" />
          <span className="k under">In Circle Gateway, ready for your agents to spend</span>
        </div>
      ) : (
        <div>
          <span className="money md">Balance unavailable</span>
          <span className="k under">{buyer && "error" in buyer ? "Couldn't read the Gateway balance." : "Gateway funding isn't set up on this firewall."}</span>
        </div>
      )}
      <div className="row3">
        {addr ? (
          <a href={`${ARC_EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer" className="mono" title={`${addr} on the Arc explorer`}>{shortAddr(addr)}</a>
        ) : <span />}
        {(treasury || topUpLeft !== null) && (
          <span className="balance-meta">
            {treasury && <span>Treasury {cents(treasury.treasuryUsdc)}{treasury.low && <span className="pill warn">Low</span>}</span>}
            {topUpLeft !== null && <span>{cents(topUpLeft)} top-up left today</span>}
          </span>
        )}
      </div>
    </div>
  );
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
