"use client";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { formatUsd } from "@agent-firewall/policy";
import { api, type AgentListItem, type HeldPayment } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { useNow, usePoll } from "@/lib/hooks";
import { BalanceCard, ErrorState, Icon, Money, PauseButton, PopCard, displayName, fmtLeft, shortAddr } from "@/components";

type Hold = HeldPayment & { agentId: string; agentName?: string };

/**
 * The whole wallet at a glance. All agents spend from one Circle Agent Wallet, so nothing here depends on a picked
 * agent: the balance, what all agents spent and had stopped today, every payment waiting for you, then the agents.
 */
export default function Home() {
  const { agents, agentsError, refreshAgents, health } = useAgents();
  const holds = usePoll(() => api<{ items: Hold[] }>("/v1/holds"), 4000);
  const now = useNow(1000);

  if (!agents) return agentsError ? <ErrorState error={agentsError} onRetry={refreshAgents} /> : <p className="muted" role="status">Loading…</p>;

  const sum = (f: (a: AgentListItem) => number) => agents.reduce((n, a) => n + f(a), 0);
  const spent = sum((a) => a.today.paidMicro);
  const stopped = sum((a) => a.today.stoppedMicro);
  const blocked = sum((a) => a.today.counts.blocked);
  const flagged = sum((a) => a.today.anomalies.flaggedRequests);
  const uncertain = sum((a) => a.today.evidence?.uncertainCount ?? 0);
  const waitingList = holds.data?.items ?? null;
  const waiting = waitingList?.length ?? sum((a) => a.pendingApprovals);
  const nameOf = (h: Hold) => displayName(h.agentName ?? agents.find((a) => a.id === h.agentId)?.name ?? h.agentId);
  const spenders = agents.filter((a) => a.today.paidMicro > 0).length;

  return (
    <>
      <h1>Overview</h1>
      {health?.mockPayments && (
        <p className="callout" role="note"><span><strong>Simulated payments.</strong> Sellers accept any payment (MOCK_PAYMENTS=1), so &ldquo;paid&rdquo; amounts never moved money.</span></p>
      )}
      {uncertain > 0 && (
        <div className="callout attention alert" role="status">
          <div>
            <strong>{uncertain === 1 ? "1 payment needs" : `${uncertain} payments need`} checking</strong>
            <p className="muted">It failed after paying started, so money may have moved.</p>
          </div>
          <Link className="btn attention secondary" href="/activity?status=reconcile">Review</Link>
        </div>
      )}

      <section className="glance4" aria-label="Wallet">
        <BalanceCard health={health} />
        <PopCard
          title="Spent today"
          front={<>
            <div className="card-top"><h2>Spent today</h2><Link className="round-link" href="/activity?status=paid" aria-label="See payments"><Icon name="arrow" size={16} /></Link></div>
            <Money micro={spent} size="lg" />
          </>}
          details={<>
            <Money micro={spent} size="xl" />
            <p className="muted">{agents.length === 0 ? "No agents yet." : `${spenders} of ${agents.length} agent${agents.length === 1 ? "" : "s"} paid today.`}</p>
            <PerAgent rows={agents.filter((a) => a.today.paidMicro > 0).map((a) => [displayName(a.name), formatUsd(a.today.paidMicro)])} />
            <Link className="btn secondary" href="/activity?status=paid">See payments</Link>
          </>}
        />
        <PopCard
          title="Stopped today"
          front={<>
            <div className="card-top"><h2>Stopped today</h2><Link className="round-link" href="/activity?status=blocked" aria-label="See blocked payments"><Icon name="arrow" size={16} /></Link></div>
            <Money micro={stopped} size="lg" />
            <span className="tags foot">
              <span className={`pill ${blocked ? "warn" : "quiet"}`}>{blocked} blocked</span>
              {flagged > 0 && <Link className="pill warn" href="/activity?flagged=1">{flagged} unusual</Link>}
            </span>
          </>}
          details={<>
            <Money micro={stopped} size="xl" />
            <p className="muted">{blocked} payment{blocked === 1 ? "" : "s"} blocked by your rules{flagged ? `, ${flagged} flagged as unusual` : ""}.</p>
            <PerAgent rows={agents.filter((a) => a.today.stoppedMicro > 0).map((a) => [displayName(a.name), `${formatUsd(a.today.stoppedMicro)} (${a.today.counts.blocked} blocked)`])} />
            <Link className="btn secondary" href="/activity?status=blocked">See blocked payments</Link>
          </>}
        />
        <PopCard
          title="Waiting for you"
          className={waiting ? "attention" : ""}
          front={<>
            <div className="card-top"><h2>Waiting for you</h2></div>
            <span className="money lg">{waiting}</span>
          </>}
          details={<>
            <span className="money xl">{waiting}</span>
            <p className="muted">{waiting ? `Payment${waiting === 1 ? "" : "s"} held for your approval.` : "Nothing to approve."}</p>
            <PerAgent rows={(waitingList ?? []).map((h) => [`${nameOf(h)} to ${shortAddr(h.recipient)}`, formatUsd(h.amountMicro)])} />
          </>}
        />
      </section>

      {waitingList && waitingList.length > 0 && (
        <section className="panel flush" aria-labelledby="w">
          <div className="panel-bar"><h2 id="w">Waiting for your approval</h2></div>
          <ul className="holds">
            {waitingList.map((h) => (
              <li key={h.requestId}>
                <span className="hold-main">
                  <strong>{formatUsd(h.amountMicro)}</strong> to <span className="mono" title={h.recipient}>{shortAddr(h.recipient)}</span>
                  <span className="muted small under">{nameOf(h)} · {h.reason}</span>
                </span>
                <span className="countdown small">{fmtLeft(new Date(h.expiresAt).getTime() - now)}</span>
                {h.token
                  ? <Link className="btn attention sm" href={`/a/${h.token}`}>Review</Link>
                  : <Link className="btn attention secondary sm" href={`/activity?request=${encodeURIComponent(h.requestId)}`}>Details</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {holds.error && !holds.data && <ErrorState error={holds.error} onRetry={holds.refresh} />}

      <AgentCarousel agents={agents} onChanged={refreshAgents} />
    </>
  );
}

/** Horizontally scrolling agent cards with arrows and a search box. The page itself never scrolls sideways. */
function AgentCarousel({ agents, onChanged }: { agents: AgentListItem[]; onChanged: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const track = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? agents.filter((a) => a.name.toLowerCase().includes(s) || a.id.toLowerCase().includes(s)) : agents;
  }, [agents, q]);
  const scroll = (dir: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: "smooth" });
  };
  return (
    <section className="carousel" aria-labelledby="ya">
      <div className="carousel-bar">
        <h2 id="ya">Your agents <span className="muted small">({agents.length})</span></h2>
        <div className="carousel-tools">
          <label className="search">
            <span className="sr">Search agents</span>
            <Icon name="search" size={16} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents" />
          </label>
          <button type="button" className="round-link" onClick={() => scroll(-1)} aria-label="Previous agents"><span className="flip"><Icon name="next" size={16} /></span></button>
          <button type="button" className="round-link" onClick={() => scroll(1)} aria-label="Next agents"><Icon name="next" size={16} /></button>
        </div>
      </div>
      <ul className="carousel-track" ref={track} tabIndex={0} aria-label="Agents">
        {shown.map((a) => <AgentTile key={a.id} a={a} onChanged={onChanged} />)}
        {shown.length === 0 && q && <li className="tile empty muted">No agent matches &ldquo;{q}&rdquo;.</li>}
        <li className="tile add">
          <Link href="/agents?add=1" className="add-link"><span className="add-mark" aria-hidden="true"><Icon name="plus" size={20} /></span>Add agent</Link>
        </li>
      </ul>
    </section>
  );
}

function AgentTile({ a, onChanged }: { a: AgentListItem; onChanged: () => Promise<void> }) {
  const paused = a.status === "paused";
  const { daySpentMicro: spent, dayCapMicro: cap } = a.budget;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
  return (
    <li className={`tile ${a.pendingApprovals ? "attention" : ""}`}>
      <div className="card-top">
        <span className="name-id">
          <Link className="tile-link" href={`/agents?id=${encodeURIComponent(a.id)}`}>{displayName(a.name)}</Link>
          <span className="mono muted small">{a.id}</span>
        </span>
        <span className="status small"><span className={`dot ${paused ? "paused" : ""}`} aria-hidden="true" />{paused ? "Paused" : "Active"}</span>
      </div>
      <div>
        <p className="small"><strong>{formatUsd(spent)}</strong><span className="muted">{cap !== null ? ` of ${formatUsd(cap)} today` : " today · no daily cap"}</span></p>
        <div className="bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="tile-foot">
        {a.pendingApprovals > 0
          ? <span className="pill warn">{a.pendingApprovals} waiting</span>
          : <span className="pill quiet">None waiting</span>}
        <PauseButton agent={a} onChanged={onChanged} compact />
      </div>
    </li>
  );
}

/** Name / amount rows inside an Overview pop-up. */
function PerAgent({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="pop-rows">
      {rows.map(([k, v], i) => <li key={i}><span>{k}</span><span className="mono">{v}</span></li>)}
    </ul>
  );
}
