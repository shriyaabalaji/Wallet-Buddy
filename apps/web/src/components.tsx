"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { formatUsd } from "@agent-firewall/policy";
import type { AnomalySignal } from "@agent-firewall/policy";
import { ApiError, type Outcome, type Settlement, type SettlementState } from "@/lib/api";
import { AgentProvider, useAgents } from "@/lib/agents";

const NAV = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/agents", label: "Agents", icon: "users" },
  { href: "/rules", label: "Rules", icon: "shield" },
  { href: "/activity", label: "Activity", icon: "list" },
];

/** App shell: a quiet left sidebar (nav, agent, network) next to the page. */
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  // The approve page (opened from a text, no login) and the sign-in page stand alone and load no owner data.
  const standalone = path.startsWith("/a/") || path === "/login";
  if (standalone) return <main className="page">{children}</main>;
  return (
    <AgentProvider enabled>
      <ShellFrame path={path}>{children}</ShellFrame>
    </AgentProvider>
  );
}

function ShellFrame({ path, children }: { path: string; children: ReactNode }) {
  const { agent, health, agentsError } = useAgents();
  const waiting = agent?.pendingApprovals ?? 0;
  const paused = agent?.status === "paused";
  const live = Boolean(health?.arc?.registry);
  const online = Boolean(health) && !agentsError;
  async function signOut() {
    await fetch("/api/session", { method: "DELETE" }).catch(() => null);
    window.location.assign("/login");
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true"><Icon name="shield" size={18} /></span>Agent Firewall</Link>
        <nav aria-label="Main" className="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>
              <Icon name={n.icon} />
              {n.label}
              {n.href === "/" && waiting > 0 && <span className="count" aria-label={`${waiting} waiting for you`}>{waiting}</span>}
            </Link>
          ))}
        </nav>
        <AgentPicker />
        {agent && (
          <div className="side-box">
            <span className="status"><span className={`dot ${paused ? "paused" : ""}`} aria-hidden="true" /><span className="cap">{paused ? "Paused" : "Active"}</span></span>
            <div className="kv"><span>Task</span><span className="mono">{agent.currentTask ?? "none yet"}</span></div>
            <div className="kv"><span>Rules</span><span>{agent.hasPolicy ? "Locked on Arc" : "Not saved"}</span></div>
          </div>
        )}
        <div className="side-foot">
          <span className="status"><span className={`dot ${online ? "" : "paused"}`} aria-hidden="true" />{online ? (live ? "Arc testnet" : "Local mode") : "Firewall offline"}</span>
          <span className="muted mono">Chain 5042002 · USDC</span>
          <button className="linkish" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="page">{children}</main>
    </div>
  );
}

/** Which agent every page shows. Hidden until agents load; nothing to pick when none are registered. */
export function AgentPicker() {
  const { agents, agentId, selectAgent } = useAgents();
  if (!agents || agents.length === 0 || !agentId) return null;
  return (
    <div className="agent-pick">
      <label htmlFor="agent-pick" className="side-label">Agent</label>
      <select id="agent-pick" value={agentId} onChange={(e) => selectAgent(e.target.value)}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>{displayName(a.name)}{a.status === "paused" ? " (paused)" : ""}</option>
        ))}
      </select>
    </div>
  );
}

/** Agent names are stored as typed (or derived from the id, e.g. "research agent"); show them capitalized. */
export const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Shown when the firewall has no agents yet. */
export function NoAgents() {
  return (
    <div className="panel" role="status">
      <h2>No agents yet</h2>
      <p className="muted">An agent shows up here when you register it, save rules for it, or it asks the firewall to pay for the first time.</p>
      <div><Link className="btn" href="/agents">Register an agent</Link></div>
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
        <span key={a.type} className={`pill ${a.severity === "low" ? "quiet" : "warn"}`} title={a.explanation}>{ANOMALY_LABEL[a.type]}{a.severity === "high" ? " · high" : ""}</span>
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
  accepted_no_reference: { label: "Paid · no reference", tone: "ok" },
  accepted_with_reference: { label: "Paid · unverified ref", tone: "ok" },
  confirmed_onchain: { label: "Released on Arc", tone: "ok" },
  approved_unrecorded: { label: "Approved · not on Arc", tone: "warn" },
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
