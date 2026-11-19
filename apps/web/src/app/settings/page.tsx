"use client";
import { useEffect, useRef, useState } from "react";
import { ARC_EXPLORER, ApiError, api, type NotifyEvent, type Seller } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { usePoll } from "@/lib/hooks";
import { ErrorState, Icon, Money, shortAddr } from "@/components";
import { PasskeySetup } from "@/passkey";
import { AddMoney } from "@/deposit";
import { ConnectCircleWallet } from "@/connect-wallet";
import { formatPhone, normalizePhone } from "./phone";

/** Owner-wide settings: one phone for every agent, and the one wallet they all spend from. */
export default function SettingsPage() {
  const [active, go] = useActiveSection(SECTIONS.map((x) => x.id));
  return (
    <>
      <h1 className="settings-title">Settings</h1>
      <div className="settings-gh">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <a key={x.id} href={`#${x.id}`} onClick={(e) => { e.preventDefault(); go(x.id); }} className={active === x.id ? "on" : ""} aria-current={active === x.id ? "true" : undefined}>
              <Icon name={x.icon} size={16} />{x.label}
            </a>
          ))}
        </nav>
        <div className="settings-body">
          <Wallet />
          <AddMoney />
          <Sellers />
          <TextMessages />
          <PasskeySetup />
        </div>
      </div>
    </>
  );
}

const SECTIONS = [
  { id: "wallet", label: "Wallet", icon: "wallet" },
  { id: "add-money", label: "Add money", icon: "plus" },
  { id: "sellers", label: "Sellers", icon: "users" },
  { id: "sms", label: "Text messages", icon: "bolt" },
  { id: "pk", label: "Passkey", icon: "lock" },
];

/**
 * Which section the menu highlights: the one you clicked (until you scroll yourself), otherwise the last heading
 * scrolled past. The page is too short for the last sections to reach the top, so a click must win over position.
 */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0]!);
  const pinned = useRef<string | null>(null);
  useEffect(() => {
    const onScroll = () => {
      if (pinned.current) return;
      let cur = ids[0]!;
      for (const id of ids) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top < 200) cur = id; }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = ids[ids.length - 1]!;
      setActive(cur);
    };
    const unpin = () => { pinned.current = null; };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    for (const ev of ["wheel", "touchmove", "keydown"]) window.addEventListener(ev, unpin, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      for (const ev of ["wheel", "touchmove", "keydown"]) window.removeEventListener(ev, unpin);
    };
  }, [ids.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (id: string) => {
    pinned.current = id;
    setActive(id);
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    history.replaceState(null, "", `#${id}`);
  };
  return [active, go] as const;
}

/** One settings row: a label (and optional hint) on the left, the control on the right. */
function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}{hint && <span className="set-hint">{hint}</span>}</div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

const EVENT_LABEL: Record<NotifyEvent, string> = { hold: "Held for approval", budget80: "80% of budget used", paused: "Agent paused" };
const EVENTS = Object.keys(EVENT_LABEL) as NotifyEvent[];
type Settings = { phone: string | null; events: NotifyEvent[]; twilio: boolean; sms?: "textbelt" | "twilio" | "dry-run"; envPhoneSet?: boolean; textApprove?: { enabled: boolean; maxMicro: number } };

/** GET/POST /v1/settings. A number set on one agent's page (advanced) overrides this for that agent only. */
function TextMessages() {
  const cur = usePoll(() => api<Settings>("/v1/settings"), 60000);
  const [phone, setPhone] = useState("");
  const [events, setEvents] = useState<NotifyEvent[]>(["hold"]);
  const [textOk, setTextOk] = useState(true);
  const [capUsd, setCapUsd] = useState("5");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Fill the form once from what the firewall has stored; later polls don't overwrite what the owner is typing.
  useEffect(() => {
    if (loaded || !cur.data) return;
    setPhone(cur.data.phone ? formatPhone(cur.data.phone) : "");
    setEvents(cur.data.events);
    if (cur.data.textApprove) { setTextOk(cur.data.textApprove.enabled); setCapUsd(String(cur.data.textApprove.maxMicro / 1e6)); }
    setLoaded(true);
  }, [cur.data, loaded]);

  const toggle = (e: NotifyEvent, on: boolean) => {
    setDone(null);
    setEvents((c) => (on ? (c.includes(e) ? c : [...c, e]) : c.filter((x) => x !== e)));
  };

  async function save() {
    setError(null); setDone(null);
    const normalized = normalizePhone(phone);
    if (!normalized) { setPhoneErr("Include the country code, like +1 604 555 0100."); return; }
    const cap = Number(capUsd);
    if (!Number.isFinite(cap) || cap < 0 || cap > 100) { setError(new ApiError("Text-approval limit must be between $0 and $100.", 400)); return; }
    setPhoneErr(null); setBusy(true);
    try {
      await api("/v1/settings", { method: "POST", body: { phone: normalized, events: EVENTS.filter((e) => events.includes(e)), textApprove: { enabled: textOk, maxMicro: Math.round(cap * 1e6) } } });
      setPhone(formatPhone(normalized));
      setDone(events.length ? "Saved" : "Saved. No texts will be sent.");
      await cur.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : "Couldn't save.", 0));
    } finally { setBusy(false); }
  }

  return (
    <section className="panel" aria-labelledby="sms">
      <div className="panel-head">
        <h2 id="sms">Text messages</h2>
      </div>
      {cur.error && !cur.data && <ErrorState error={cur.error} onRetry={cur.refresh} />}
      <Row label="Phone" hint="One number for every agent" htmlFor="phone">
        <input
          id="phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+1 604 555 0100"
          value={phone} onChange={(e) => { setPhone(e.target.value); setPhoneErr(null); setDone(null); }}
          aria-invalid={phoneErr ? true : undefined} aria-describedby={phoneErr ? "phone-err" : undefined}
        />
        {phoneErr && <p id="phone-err" role="alert" className="field-err">{phoneErr}</p>}
      </Row>
      <Row label="Text me when">
        <div className="chips" role="group" aria-label="Text me when">
          {EVENTS.map((e) => (
            <label key={e} className="chip-toggle"><input type="checkbox" checked={events.includes(e)} onChange={(ev) => toggle(e, ev.target.checked)} /><span>{EVENT_LABEL[e]}</span></label>
          ))}
        </div>
      </Row>
      <Row label="Approve by text" hint="Bigger payments need your passkey">
        <div className="inline-ctl">
          <label className="switch" htmlFor="text-ok">
            <span className="sr">Approve by text</span>
            <input id="text-ok" type="checkbox" role="switch" checked={textOk} onChange={(e) => { setTextOk(e.target.checked); setDone(null); }} />
            <span className="track" aria-hidden="true" />
          </label>
          {textOk && (
            <span className="cap">
              <label htmlFor="cap">up to $</label>
              <input id="cap" type="number" min={0} max={100} step={0.5} value={capUsd} onChange={(e) => { setCapUsd(e.target.value); setDone(null); }} />
              <span>each</span>
            </span>
          )}
        </div>
      </Row>
      <Row label="Reply with">
        <div className="replies">
          {textOk && <span><code>YES 123456</code>approve</span>}
          <span><code>NO</code>cancel</span>
          <span><code>PAUSE</code>stop all agents</span>
        </div>
      </Row>
      <div className="set-row">
        <div className="set-label" />
        <div className="set-ctl toolbar sms-actions">
          <button className="btn" onClick={save} disabled={busy || !loaded || !phone.trim()}>{busy ? "Saving…" : "Save"}</button>
          {done && <span className="saved-note" role="status"><Icon name="check" size={16} />{done}</span>}
        </div>
      </div>
      {error && <ErrorState error={error} />}
    </section>
  );
}

/**
 * Settings → Sellers (GET/POST/DELETE /v1/sellers): the names your agents can pay and the wallet each must be paid at.
 * A payment to a name only goes out if the seller's own payment request asks to be paid at this address.
 */
function Sellers() {
  const list = usePoll(() => api<{ items: Seller[] }>("/v1/sellers"), 30000);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function add() {
    setErr(null); setDone(null); setBusy("add");
    try {
      const s = await api<Seller>("/v1/sellers", { method: "POST", body: { name, address, url } });
      setName(""); setAddress(""); setUrl("");
      setDone(`Added ${s.name}`);
      await list.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't add the seller."); } finally { setBusy(null); }
  }
  async function remove(n: string) {
    setErr(null); setDone(null); setBusy(n);
    try { await api(`/v1/sellers/${encodeURIComponent(n)}`, { method: "DELETE" }); await list.refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't remove the seller."); } finally { setBusy(null); }
  }

  const items = list.data?.items;
  return (
    <section className="panel" aria-labelledby="sellers">
      <div className="panel-head"><h2 id="sellers">Sellers</h2></div>
      {list.error && !items && <ErrorState error={list.error} onRetry={list.refresh} />}
      {!items && !list.error && <p className="muted" role="status">Loading…</p>}
      {items?.length === 0 && <Row label="No sellers yet"><span className="muted">Add one below so your agents can pay it by name.</span></Row>}
      {items?.map((s) => (
        <Row key={s.name} label={s.name} hint={s.url ? s.url.replace(/^https?:\/\//, "") : undefined}>
          <div className="seller-ctl">
            <a className="mono" href={`${ARC_EXPLORER}/address/${s.address}`} target="_blank" rel="noreferrer" title={s.address}>{shortAddr(s.address)}</a>
            <button type="button" className="btn secondary sm" onClick={() => remove(s.name)} disabled={busy !== null} aria-label={`Remove ${s.name}`}>{busy === s.name ? "Removing…" : "Remove"}</button>
          </div>
        </Row>
      ))}
      <Row label="Add a seller" hint="The name your agents use, and the wallet it must be paid at">
        <div className="seller-form">
          <input type="text" aria-label="Seller name" placeholder="name, like sportsfeed" value={name} spellCheck={false} autoCapitalize="none" onChange={(e) => { setName(e.target.value); setErr(null); setDone(null); }} />
          <input type="text" aria-label="Wallet address" className="mono" placeholder="0x…" value={address} spellCheck={false} onChange={(e) => { setAddress(e.target.value); setErr(null); setDone(null); }} />
          <input type="text" inputMode="url" aria-label="Website (optional)" placeholder="https://… (optional)" value={url} spellCheck={false} onChange={(e) => { setUrl(e.target.value); setErr(null); setDone(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && address.trim()) void add(); }} />
          <div className="toolbar">
            <button type="button" className="btn" onClick={add} disabled={!name.trim() || !address.trim() || busy !== null}>{busy === "add" ? "Adding…" : "Add seller"}</button>
            {done && <span className="saved-note" role="status"><Icon name="check" size={16} />{done}</span>}
          </div>
          {err && <p className="field-err" role="alert">{err}</p>}
        </div>
      </Row>
    </section>
  );
}

/** The Circle Agent Wallet every agent pays from, read from GET /health. Connecting one happens on the firewall host, not here. */
function Wallet() {
  const { health } = useAgents();
  const buyer = health?.buyer;
  const live = buyer && "gatewayAvailableUsdc" in buyer ? buyer : null;
  const gw = health?.gateway && "availableUsdc" in health.gateway ? health.gateway : null;
  const available = live?.gatewayAvailableUsdc ?? gw?.availableUsdc ?? null;
  const depositor = live?.payer ?? gw?.depositor ?? null;
  const readError = (buyer && "error" in buyer) || (health?.gateway && "error" in health.gateway);
  const circle = health?.paymentMode === "circle-agent-wallet";
  const addr = health?.signer ?? null;
  return (
    <section className="panel" aria-labelledby="wallet">
      <div className="panel-head">
        <h2 id="wallet">Wallet</h2>
      </div>
      {!health ? <p className="muted" role="status">Loading…</p> : (
        <>
          <Row label="Balance" hint={`${circle ? "Circle Agent Wallet" : "Local key"}, Arc ${health.network ?? "testnet"}`}>
            {available !== null ? <Money micro={Math.floor(available * 100 + 1e-9) * 10_000} size="lg" /> : <span>{readError ? "Couldn't read it" : health.mockPayments ? "Simulated" : "Not set up"}</span>}
          </Row>
          <Row label="Wallet address">{addr ? <a className="mono" href={`${ARC_EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer" title={addr}>{shortAddr(addr)}</a> : <span>Not set</span>}</Row>
          {depositor && depositor !== addr && <Row label="Gateway account" hint="Holds the balance agents spend"><a className="mono" href={`${ARC_EXPLORER}/address/${depositor}`} target="_blank" rel="noreferrer" title={depositor}>{shortAddr(depositor)}</a></Row>}
        </>
      )}
      <ConnectCircleWallet />
    </section>
  );
}
