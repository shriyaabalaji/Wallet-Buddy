"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { formatUsd } from "@agent-firewall/policy";
import type { AnomalySignal } from "@agent-firewall/policy";
import { ARC_EXPLORER, ApiError, api, txUrl, type ActivityItem, type AgentListItem, type Health, type Outcome, type Settlement, type SettlementState } from "@/lib/api";
import { AgentProvider, useAgents } from "@/lib/agents";

const NAV = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/agents", label: "Agents", icon: "users" },
  { href: "/activity", label: "Activity", icon: "list" },
  { href: "/settings", label: "Settings", icon: "gear" },
];

/** App shell: a quiet left sidebar (nav, network) next to the page. Every page is about the whole wallet; none depends on a picked agent. */
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  // The approve page (opened from a text, no login), the sign-in page and the public proof page stand alone and load no owner data.
  const standalone = path.startsWith("/a/") || path === "/login" || path === "/proof";
  if (standalone) return <main className="page">{children}</main>;
  return (
    <AgentProvider enabled>
      <ShellFrame path={path}>{children}</ShellFrame>
    </AgentProvider>
  );
}

function ShellFrame({ path, children }: { path: string; children: ReactNode }) {
  const { agents, health, agentsError } = useAgents();
  const waiting = (agents ?? []).reduce((n, a) => n + a.pendingApprovals, 0);
  const live = Boolean(health?.arc?.registry);
  const mainnet = health?.network === "mainnet";
  const online = Boolean(health) && !agentsError;
  async function signOut() {
    await fetch("/api/session", { method: "DELETE" }).catch(() => null);
    window.location.assign("/login");
  }
  const current = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Main" className="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={current(n.href) ? "page" : undefined}>
              <Icon name={n.icon} />
              {n.label}
              {n.href === "/" && waiting > 0 && <span className="count" aria-label={`${waiting} waiting for you`}>{waiting}</span>}
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <span className="status"><span className={`dot ${online ? "" : "paused"}`} aria-hidden="true" />{online ? (mainnet ? "Arc mainnet" : live ? "Arc testnet" : "Local mode") : "Wallet Buddy offline"}</span>
          <span className="muted mono">Chain {mainnet ? 5042 : 5042002} · USDC</span>
          <button className="linkish" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="page">{children}</main>
    </div>
  );
}

/** Product name with its mark. Used in the sidebar and on the sign-in page. */
export function Brand() {
  return <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true"><Icon name="wallet" size={18} /></span>Wallet Buddy</Link>;
}

/** Agent names are stored as typed (or derived from the id, e.g. "research agent"); show them capitalized. */
export const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Shown when the firewall has no agents yet. */
export function NoAgents() {
  return (
    <div className="panel" role="status">
      <h2>No agents yet</h2>
      <p className="muted">An agent shows up here when you register it, save rules for it, or it asks the firewall to pay for the first time.</p>
      <div><Link className="btn" href="/agents?add=1">Add an agent</Link></div>
    </div>
  );
}

export const ANOMALY_LABEL: Record<AnomalySignal["type"], string> = {
  AMOUNT_SPIKE: "Unusual amount", FREQUENCY_SPIKE: "Burst of requests", NEW_RECIPIENT: "New recipient",
  RAPID_BUDGET_DEPLETION: "Budget draining fast", REPEATED_DENIALS: "Repeated denials", DUPLICATE_PATTERN: "Repeat purchase",
};

/** Orange for medium/high (needs attention), neutral for low. Text always carries the meaning. */
export function SeverityPill({ severity }: { severity: AnomalySignal["severity"] }) {
  return <span className={`pill ${severity === "low" ? "quiet" : "warn"}`}>{severity === "high" ? "High risk" : severity === "medium" ? "Medium" : "Low"}</span>;
}

/** Compact anomaly tags for table rows; the full explanation is in the title (and on the record view). */
export function AnomalyTags({ anomalies }: { anomalies: AnomalySignal[] | undefined }) {
  if (!anomalies?.length) return <span className="muted">—</span>;
  return (
    <span className="tags">
      {anomalies.map((a) => (
        <span key={a.type} className={`pill ${a.severity === "low" ? "quiet" : "warn"}`} title={a.explanation}>{ANOMALY_LABEL[a.type]}{a.severity === "high" ? " (high)" : ""}</span>
      ))}
    </span>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const down = error.status === 0;
  return (
    <div className="callout attention" role="alert">
      <strong>{down ? "We can't reach your firewall." : "Something went wrong."}</strong>
      <p>
        {down
          ? "Check that the firewall service is running and that this dashboard's FIREWALL_URL points at it. Your agent's rules stay in force while this page is offline."
          : error.message}
      </p>
      {onRetry && (
        <button className="btn secondary" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}

export function Callout({ title, children, tone = "info" }: { title: string; children: ReactNode; tone?: "info" | "attention" }) {
  return (
    <div className={`callout ${tone}`}>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

const OUTCOME_LABEL: Record<Outcome, string> = { allow: "Paid", hold: "Held for you", block: "Blocked" };
// What happened next matters more than the first decision (a hold can end cancelled, a reserved payment can fail).
const STATUS_LABEL: Record<string, string> = {
  reserved: "Paying", settled: "Paid", released: "Didn't go through", held: "Held for you",
  approved: "You approved", unconfirmed: "Unconfirmed", denied: "You cancelled", expired: "Refunded (no reply)", blocked: "Blocked",
};
// With settlement evidence (newer firewalls), say how much is known about the money, not just the status.
// "Paid" alone is only used where the seller accepted it; simulated and unverified money is labelled as such.
const SETTLEMENT_BADGE: Partial<Record<SettlementState, { label: string; tone: "ok" | "warn" | "muted" }>> = {
  pending_signature: { label: "Allowed, not paid yet", tone: "ok" },
  awaiting_outcome: { label: "Sent, waiting", tone: "ok" },
  uncertain: { label: "Outcome unknown", tone: "warn" },
  simulated: { label: "Simulated", tone: "muted" },
  accepted_no_reference: { label: "Paid", tone: "ok" },
  accepted_with_reference: { label: "Paid, unverified", tone: "ok" },
  confirmed_onchain: { label: "Released on Arc", tone: "ok" },
  approved_unrecorded: { label: "Approved, not on Arc", tone: "warn" },
};
export function OutcomeBadge({ outcome, status, settlement }: { outcome: Outcome; status?: string; settlement?: Settlement }) {
  // blue = allowed, orange = needs attention / blocked, grey = no real money. Text label always present (not color alone).
  const byEvidence = settlement ? SETTLEMENT_BADGE[settlement.state] : undefined;
  if (byEvidence) return <span className={`badge ${byEvidence.tone}`} title={settlement!.label}>{byEvidence.label}</span>;
  const label = (status && STATUS_LABEL[status]) ?? OUTCOME_LABEL[outcome];
  const ok = status ? ["reserved", "settled", "approved"].includes(status) : outcome === "allow";
  return <span className={`badge ${ok ? "ok" : "warn"}`}>{label}</span>;
}

export function VerifyLink({ href, children = "verify on Arc" }: { href: string | null | undefined; children?: ReactNode }) {
  if (!href) return null;
  return <a className="verify" href={href} target="_blank" rel="noreferrer">{children}</a>;
}

export function shortTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function shortAddr(s: string) {
  return s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  check: <path d="m5 12 5 5 9-10" />,
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="m7 5 12 7-12 7z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  arrow: <path d="M7 17 17 7M8 7h9v9" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  alert: <><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></>,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  back: <path d="M15 18l-6-6 6-6" />,
  undo: <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5.5 5.5 0 0 1 3.5 6" /></>,
  bolt: <path d="M13 3 5 14h6l-1 7 8-11h-6z" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  next: <path d="m9 18 6-6-6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  wallet: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><path d="M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5z" /><path d="M16 13.5h.01" /></>,
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** "$4.86" with the cents faded, like a banking balance. */
export function Money({ micro, size = "md" }: { micro: number; size?: "xl" | "lg" | "md" }) {
  const s = formatUsd(micro);
  const i = s.indexOf(".");
  return (
    <span className={`money ${size}`} aria-label={s}>
      <span aria-hidden="true">{i < 0 ? s : s.slice(0, i)}</span>
      {i >= 0 && <span className="cents" aria-hidden="true">.{s.slice(i + 1)}</span>}
    </span>
  );
}

/** Seller initials in a circle; a raw wallet address gets an amber "?" so it never looks trusted. */
export function Avatar({ recipient }: { recipient: string }) {
  const unknown = /^0x[0-9a-f]{6,}$/i.test(recipient);
  const letters = unknown ? "?" : recipient.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return <span className={`avatar ${unknown ? "unknown" : ""}`} aria-hidden="true">{letters}</span>;
}

// ---------- shared by Overview and Agents ----------

/** Whole cents, rounded down, for balances read from chain (they carry 6 decimals): never overstate money. */
const centsMicro = (usdc: number) => Math.floor(usdc * 100 + 1e-9) * 10_000;
export const cents = (usdc: number) => formatUsd(centsMicro(usdc));

/**
 * The one wallet every agent spends from: its Circle Gateway balance, from the owner view of GET /health (buyer =
 * funding.ts fundingStatus; vault = the treasury that tops it up). Shared with the shell's health poll, so no extra request.
 */
export function BalanceCard({ health }: { health: Health | null }) {
  const buyer = health?.buyer;
  const vault = health?.vault;
  const live = buyer && "gatewayAvailableUsdc" in buyer ? buyer : null;
  // Without automatic top-ups (no treasury key), the firewall still reads the payer's balance from Circle.
  const gw = health?.gateway && "availableUsdc" in health.gateway ? health.gateway : null;
  const available = live?.gatewayAvailableUsdc ?? gw?.availableUsdc ?? null;
  const readError = (buyer && "error" in buyer) || (health?.gateway && "error" in health.gateway);
  const addr = live?.payer ?? gw?.depositor ?? health?.signer ?? null;
  const treasury = vault && "treasuryUsdc" in vault ? vault : null;
  const topUpLeft = live ? Math.max(0, live.dailyCapUsdc - live.depositedTodayUsdc) : null;
  return (
    <div className="hero balance">
      <div className="row1"><h2>Balance</h2><span className="k">USDC · Arc {health?.network ?? "testnet"}</span></div>
      {!health ? (
        <p className="k" role="status">Loading…</p>
      ) : available !== null ? (
        <div>
          <Money micro={centsMicro(available)} size="xl" />
          <span className="k under">In Circle Gateway, shared by all your agents</span>
        </div>
      ) : (
        <div>
          <span className="money md">Balance unavailable</span>
          <span className="k under">
            {health.mockPayments ? "Payments are simulated on this firewall, so there's no real balance."
              : readError ? "Couldn't read the Gateway balance."
              : "Set up the wallet in Settings to see its balance."}
          </span>
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

/** One payment as a bank-statement row. `agentName` adds which agent paid (for lists that mix agents). */
export function TxRow({ a, agentName }: { a: ActivityItem; agentName?: string }) {
  const struck = ["blocked", "released", "denied", "expired"].includes(a.status);
  const purpose = a.purpose?.trim() || a.category;
  // The address is already in the row; drop it from the reason ("0x7a3f…c91e isn't on…" → "Isn't on…").
  const why = a.reason.replace(/^0x[0-9a-f]+…[0-9a-f]+\s+(\w)/i, (_, c: string) => c.toUpperCase());
  const flagged = (a.anomalies ?? []).filter((x) => x.severity !== "low").map((x) => ANOMALY_LABEL[x.type]);
  const memo = [agentName, struck || a.status === "held" ? `${purpose} · ${why}` : purpose, ...flagged].filter(Boolean).join(" · ");
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
export function resetTime(now: number) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return new Date(next).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "");
}

/** Time left on a held payment before the vault refunds it. */
export function fmtLeft(ms: number) {
  if (ms <= 0) return "refunding";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `refunds in ${m}:${String(s).padStart(2, "0")}`;
}

/** Pause or resume one agent. The other agents keep spending from the shared wallet. */
export function PauseButton({ agent, onChanged, compact = false }: { agent: Pick<AgentListItem, "id" | "name" | "status">; onChanged: () => Promise<unknown>; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const paused = agent.status === "paused";
  async function toggle() {
    setBusy(true); setErr(null);
    try {
      await api(`/v1/agents/${encodeURIComponent(agent.id)}/${paused ? "resume" : "pause"}`, { method: "POST", body: {} });
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't update the agent.");
    } finally { setBusy(false); }
  }
  const label = compact ? (paused ? "Resume" : "Pause") : paused ? "Resume agent" : "Pause agent";
  return (
    <>
      <button
        type="button" className={`btn ${paused ? "" : "attention secondary"} ${compact ? "sm" : ""}`} onClick={toggle} disabled={busy}
        aria-label={compact ? `${label} ${displayName(agent.name)}` : undefined}
      >
        <Icon name={paused ? "play" : "pause"} size={compact ? 14 : 16} />{label}
      </button>
      {err && <span role="alert" className="field-err">{err}</span>}
    </>
  );
}
