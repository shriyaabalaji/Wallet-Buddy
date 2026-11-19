"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatUsd } from "@agent-firewall/policy";
import { api, type ActivityItem, type AgentListItem, type Seller } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { BuddyGlyph, displayName, shortAddr } from "@/components";

/**
 * Live payment flow for the Overview: agents on the left (bubble size = what they spent today), Wallet Buddy in the
 * middle, sellers on the right. Every dot is a real payment from GET /v1/activity: blue goes through to the seller,
 * gold stops at Wallet Buddy to wait for you, orange bounces off. With nothing new it replays the most recent payments
 * and says so; a new payment plays as soon as the poll sees it.
 */

const W = 1000, H = 280;
const AX = 210, FX = 500, SX = 790; // agent, firewall, seller columns (viewBox units)
const FW_W = 160, FW_H = 92;
const MAX_AGENTS = 6, MAX_SELLERS = 5;
const REPLAY = 14;

type Kind = "paid" | "held" | "blocked";
type Dot = { key: string; kind: Kind; a: number; s: number; amount: string; t0: number };

const kindOf = (x: ActivityItem): Kind => (x.outcome === "block" ? "blocked" : x.outcome === "hold" ? "held" : "paid");
const rowsY = (n: number) => Array.from({ length: n }, (_, i) => (n === 1 ? H / 2 : 36 + (i * (H - 72)) / (n - 1)));
const curve = (x1: number, y1: number, x2: number, y2: number) => { const m = (x1 + x2) / 2; return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`; };

export function PaymentFlow({ agents }: { agents: AgentListItem[] }) {
  const router = useRouter();
  const feed = usePoll(() => api<{ items: ActivityItem[] }>("/v1/activity?agentId=all&limit=60"), 4000);
  const items = feed.data?.items ?? null;
  const reg = usePoll(() => api<{ items: Seller[] }>("/v1/sellers"), 60000);
  const registered = new Set((reg.data?.items ?? []).map((x) => x.name));

  // Columns: the agents and sellers in recent activity, busiest first.
  const { cols, sellers } = useMemo(() => {
    const recent = items ?? [];
    const score = new Map<string, number>();
    for (const x of recent) score.set(x.agentId, (score.get(x.agentId) ?? 0) + 1);
    const ranked = [...agents].sort((p, q) => (score.get(q.id) ?? 0) - (score.get(p.id) ?? 0) || q.today.paidMicro - p.today.paidMicro).slice(0, MAX_AGENTS);
    const sc = new Map<string, number>();
    for (const x of recent) if (ranked.some((a) => a.id === x.agentId)) sc.set(x.recipient, (sc.get(x.recipient) ?? 0) + 1);
    const top = [...sc.entries()].sort((p, q) => q[1] - p[1]).map(([r]) => r);
    const sellers = top.length > MAX_SELLERS ? [...top.slice(0, MAX_SELLERS - 1), "__other"] : top;
    return { cols: ranked, sellers };
  }, [agents, items]);

  const ay = rowsY(cols.length), sy = rowsY(sellers.length);
  const maxSpend = Math.max(1, ...cols.map((a) => a.today.paidMicro));
  const radius = (a: AgentListItem) => 9 + 15 * Math.sqrt(a.today.paidMicro / maxSpend);

  // Path elements are read each frame to place the dots.
  const inPaths = useRef<(SVGPathElement | null)[]>([]);
  const outPaths = useRef<(SVGPathElement | null)[]>([]);
  const dotEls = useRef(new Map<string, SVGGElement>());
  const fwRef = useRef<SVGRectElement>(null);
  const buddyRef = useRef<SVGGElement>(null);
  const [dots, setDots] = useState<Dot[]>([]);
  const [live, setLive] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const reduced = useRef(false);
  useEffect(() => { reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches; }, []);

  // Queue: new payments from the poll play right away; otherwise the most recent ones replay, spaced out.
  const seen = useRef<Set<string> | null>(null);
  const queue = useRef<{ x: ActivityItem; live: boolean }[]>([]);
  useEffect(() => {
    if (!items) return;
    if (!seen.current) { seen.current = new Set(items.map((x) => x.requestId)); return; }
    const fresh = items.filter((x) => !seen.current!.has(x.requestId)).reverse();
    for (const x of fresh) { seen.current.add(x.requestId); queue.current.unshift({ x, live: true }); }
  }, [items]);

  const latest = useRef({ items, cols, sellers });
  latest.current = { items, cols, sellers };
  useEffect(() => {
    let replayAt = 0;
    const tick = setInterval(() => {
      if (reduced.current || document.hidden) return;
      const { items, cols } = latest.current;
      if (!items) return;
      if (queue.current.length === 0 && Date.now() > replayAt) {
        const pool = items.filter((x) => cols.some((a) => a.id === x.agentId)).slice(0, REPLAY).reverse();
        queue.current = pool.map((x) => ({ x, live: false }));
        replayAt = Date.now() + pool.length * 900 + 2500;
      }
      const next = queue.current.shift();
      if (!next) return;
      const a = cols.findIndex((c) => c.id === next.x.agentId);
      if (a < 0) return;
      if (next.live) { setLive(true); setTimeout(() => setLive(false), 8000); }
      const ss = latest.current.sellers; const si = ss.indexOf(next.x.recipient);
      const d: Dot = { key: `${next.x.requestId}-${Date.now()}`, kind: kindOf(next.x), a, s: si >= 0 ? si : ss.indexOf("__other"), amount: formatUsd(next.x.amountMicro), t0: performance.now() };
      setDots((cur) => [...cur.slice(-12), d]);
    }, 900);
    return () => clearInterval(tick);
  }, []);

  // One animation loop moves every dot: 0.9 s to Wallet Buddy, then 0.9 s to the seller / a bounce / a wait.
  const dotsRef = useRef(dots);
  dotsRef.current = dots;
  useEffect(() => {
    let raf = 0;
    const IN = 900, OUT = 900, HOLD = 1400;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const frame = (now: number) => {
      const done: string[] = [];
      for (const d of dotsRef.current) {
        const el = dotEls.current.get(d.key);
        const pin = inPaths.current[d.a], pout = d.s >= 0 ? outPaths.current[d.s] : null;
        if (!el || !pin) continue;
        const t = now - d.t0;
        let p: DOMPoint, op = 1;
        if (t < IN) p = pin.getPointAtLength(pin.getTotalLength() * ease(t / IN));
        else if (d.kind === "paid" && pout) {
          const u = Math.min(1, (t - IN) / OUT);
          p = pout.getPointAtLength(pout.getTotalLength() * ease(u));
          if (u >= 1) { op = Math.max(0, 1 - (t - IN - OUT) / 300); if (op === 0) done.push(d.key); }
        } else if (d.kind === "blocked") {
          const u = Math.min(1, (t - IN) / 600);
          const L = pin.getTotalLength();
          p = pin.getPointAtLength(L * (1 - 0.18 * Math.sin(u * Math.PI / 2)));
          op = 1 - u;
          if (u >= 1) done.push(d.key);
          if (t - IN < 30) flash("hit-block");
        } else {
          const u = (t - IN) / HOLD;
          p = pin.getPointAtLength(pin.getTotalLength());
          op = u < 0.7 ? 1 : Math.max(0, 1 - (u - 0.7) / 0.3);
          if (u >= 1) done.push(d.key);
          if (t - IN < 30) flash("hit-hold");
        }
        el.setAttribute("transform", `translate(${p.x},${p.y})`);
        el.style.opacity = String(op);
      }
      if (done.length) setDots((cur) => cur.filter((d) => !done.includes(d.key)));
      raf = requestAnimationFrame(frame);
    };
    const flash = (cls: string) => {
      const fw = fwRef.current, buddy = buddyRef.current;
      if (!fw || fw.classList.contains(cls)) return;
      fw.classList.add(cls); buddy?.classList.add(cls);
      setTimeout(() => { fw.classList.remove(cls); buddy?.classList.remove(cls); }, 450);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const hovered = hover !== null ? cols[hover] : null;
  const count = (a: AgentListItem) => a.today.counts.requests;

  return (
    <section className="panel flow" aria-labelledby="flow-h">
      <div className="panel-head">
        <h2 id="flow-h">Payments through Wallet Buddy</h2>
        {items && cols.length > 0 && (
          <span className={`badge ${live ? "ok live" : "quiet"}`} role="status">{live ? "New payment" : "Replaying recent payments"}</span>
        )}
      </div>
      {!items ? <p className="muted" role="status">Loading…</p> : cols.length === 0 || sellers.length === 0 ? (
        <p className="muted">When your agents pay, each payment shows up here as it happens.</p>
      ) : (
        <div className="flow-stage">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${cols.length} agents paying ${sellers.length} sellers through Wallet Buddy. Blue payments went through, gold ones wait for you, orange ones were blocked.`}>
            {/* lanes */}
            {cols.map((a, i) => (
              <path key={a.id} ref={(el) => { inPaths.current[i] = el; }} d={curve(AX + 30, ay[i]!, FX - FW_W / 2, H / 2)} className={`lane ${hover === i ? "on" : ""}`} />
            ))}
            {sellers.map((s, j) => (
              <path key={s} ref={(el) => { outPaths.current[j] = el; }} d={curve(FX + FW_W / 2, H / 2, SX - 14, sy[j]!)} className="lane" />
            ))}

            {/* Wallet Buddy */}
            <g className="fw">
              <rect ref={fwRef} className="fw-box" x={FX - FW_W / 2} y={H / 2 - FW_H / 2} width={FW_W} height={FW_H} rx={20} />
              <g ref={buddyRef} transform={`translate(${FX - 21},${H / 2 - 40}) scale(1.3)`} className="fw-buddy"><BuddyGlyph clasp="#005b9e" /></g>
              <text x={FX} y={H / 2 + 30} textAnchor="middle" className="fw-label">Wallet Buddy</text>
            </g>

            {/* agents */}
            {cols.map((a, i) => (
              <g
                key={a.id} className={`agent ${a.status === "paused" ? "paused" : ""} ${hover === i ? "on" : ""}`}
                transform={`translate(${AX},${ay[i]})`} tabIndex={0} role="link" aria-label={`${displayName(a.name)}: ${formatUsd(a.today.paidMicro)} today`}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                onClick={() => router.push(`/agents?id=${encodeURIComponent(a.id)}`)}
                onKeyDown={(e) => { if (e.key === "Enter") router.push(`/agents?id=${encodeURIComponent(a.id)}`); }}
              >
                <circle r={radius(a) + 8} className="halo" />
                <circle r={radius(a)} className="body" />
                <text x={-radius(a) - 12} y={5} textAnchor="end" className="agent-label">{displayName(a.name)}</text>
              </g>
            ))}

            {/* sellers */}
            {sellers.map((s, j) => {
              const raw = /^0x[0-9a-f]{6,}$/i.test(s);
              // Anything that isn't a registered seller (a raw address, or a name nobody registered) is marked unknown.
              const unknown = s !== "__other" && (raw || (reg.data !== null && !registered.has(s.toLowerCase())));
              return (
                <g key={s} transform={`translate(${SX},${sy[j]})`} className={`seller ${unknown ? "unknown" : ""}`}>
                  <rect x={-14} y={-14} width={28} height={28} rx={9} />
                  <text x={24} y={5} className="seller-label">{s === "__other" ? "Other sellers" : raw ? `Unknown wallet ${s.slice(0, 6)}…${s.slice(-4)}` : unknown ? `${s} (not registered)` : s}</text>
                </g>
              );
            })}

            {/* payments */}
            {dots.map((d) => (
              <g key={d.key} ref={(el) => { if (el) dotEls.current.set(d.key, el); else dotEls.current.delete(d.key); }} className={`pay ${d.kind}`} style={{ opacity: 0 }}>
                <circle r={7} />
                <text y={-13} textAnchor="middle">{d.amount}</text>
              </g>
            ))}
          </svg>

          {hovered && hover !== null && (
            <div className="flow-tip" style={{ left: `${((AX + radius(hovered) + 14) / W) * 100}%`, top: `${(ay[hover]! / H) * 100}%` }}>
              <strong>{displayName(hovered.name)}</strong>
              <span>{formatUsd(hovered.today.paidMicro)} spent today</span>
              <span>{count(hovered)} payment{count(hovered) === 1 ? "" : "s"} today, {hovered.today.counts.blocked} blocked</span>
              <span className={hovered.status === "paused" ? "warn-text" : ""}>{hovered.status === "paused" ? "Paused" : "Active"}</span>
            </div>
          )}
        </div>
      )}
      {items && cols.length > 0 && sellers.length > 0 && (
        <div className="flow-legend" aria-hidden="true">
          <span><i className="paid" />Paid</span>
          <span><i className="held" />Waiting for you</span>
          <span><i className="blocked" />Blocked</span>
          <span className="muted">Bigger bubble, more spent today</span>
        </div>
      )}
    </section>
  );
}
