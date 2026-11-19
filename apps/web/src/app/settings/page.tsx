"use client";
import { useEffect, useState } from "react";
import { ARC_EXPLORER, ApiError, api, type NotifyEvent } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { usePoll } from "@/lib/hooks";
import { ErrorState, Icon, cents, shortAddr } from "@/components";
import { PasskeySetup } from "@/passkey";
import { AddMoney } from "@/deposit";
import { ConnectCircleWallet } from "@/connect-wallet";
import { formatPhone, normalizePhone } from "./phone";

/** Owner-wide settings: one phone for every agent, and the one wallet they all spend from. */
export default function SettingsPage() {
  return (
    <>
      <h1>Settings</h1>
      <div className="settings-split">
        <div className="rules-col">
          <TextMessages />
          <PasskeySetup />
        </div>
        <div className="rules-col">
          <Wallet />
          <AddMoney />
        </div>
      </div>
    </>
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
      setDone(events.length ? `Saved. Texts go to ${formatPhone(normalized)}.` : "Saved. No texts will be sent.");
      await cur.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : "Couldn't save.", 0));
    } finally { setBusy(false); }
  }

  return (
    <section className="panel" aria-labelledby="sms">
      <h2 id="sms">Text messages</h2>
      {cur.error && !cur.data && <ErrorState error={cur.error} onRetry={cur.refresh} />}
      <div className="field">
        <label htmlFor="phone">Your phone number</label>
        <input
          id="phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+1 604 555 0100"
          value={phone} onChange={(e) => { setPhone(e.target.value); setPhoneErr(null); setDone(null); }}
          aria-invalid={phoneErr ? true : undefined} aria-describedby={phoneErr ? "phone-err" : "phone-note"}
        />
        {phoneErr && <p id="phone-err" role="alert" className="field-err">{phoneErr}</p>}
        <p id="phone-note" className="small muted">One number for every agent.</p>
      </div>
      <fieldset className="checks">
        <legend className="muted small">Text me when</legend>
        {EVENTS.map((e) => (
          <label key={e} className="check"><input type="checkbox" checked={events.includes(e)} onChange={(ev) => toggle(e, ev.target.checked)} /> {EVENT_LABEL[e]}</label>
        ))}
      </fieldset>
      <div className="field">
        <label className="check"><input type="checkbox" checked={textOk} onChange={(e) => { setTextOk(e.target.checked); setDone(null); }} /> Let me approve by text</label>
        {textOk && (
          <div className="row" style={{ gap: 8, alignItems: "center", justifyContent: "flex-start" }}>
            <label htmlFor="cap" className="small muted">Up to $</label>
            <input id="cap" type="number" min={0} max={100} step={0.5} value={capUsd} onChange={(e) => { setCapUsd(e.target.value); setDone(null); }} style={{ width: 90 }} />
            <span className="small muted">per payment; bigger ones need your passkey</span>
          </div>
        )}
      </div>
      <div className="toolbar sms-actions">
        <button className="btn" onClick={save} disabled={busy || !loaded || !phone.trim()}>{busy ? "Saving…" : "Save"}</button>
        {done && <span className="saved-note" role="status"><Icon name="check" size={16} />{done}</span>}
      </div>
      {error && <ErrorState error={error} />}
      <p className="muted small">
        Each held payment&apos;s text has its own 6-digit code: reply <strong>YES 123456</strong> to approve it{textOk ? "" : " (turned off above)"}, <strong>NO</strong> to cancel, or <strong>PAUSE</strong> to stop all your agents. Only replies from this number count.
        {cur.data?.sms === "textbelt" && <><br />Texts are sent with Textbelt.</>}
        {cur.data?.twilio === false && <><br />Texting isn&apos;t set up on the firewall, so texts are written to its log instead of sent.</>}
      </p>
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
        {health && (
          circle && addr
            ? <span className="badge ok">Circle Agent Wallet connected</span>
            : <span className="badge warn">{circle ? "No wallet address" : "Local test key"}</span>
        )}
      </div>
      {!health ? <p className="muted" role="status">Loading…</p> : (
        <div className="facts">
          <div className="kv"><span>Address</span>{addr ? <a className="mono" href={`${ARC_EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer" title={addr}>{shortAddr(addr)}</a> : <span>Not set</span>}</div>
          <div className="kv"><span>Pays with</span><span>{circle ? "Circle Agent Wallet" : "Local key (testnet only)"}</span></div>
          <div className="kv"><span>Network</span><span>Arc {health.network ?? "testnet"}</span></div>
          <div className="kv"><span>Gateway balance</span><span>{available !== null ? `${cents(available)} USDC` : readError ? "Couldn't read it" : health.mockPayments ? "Simulated" : "Not set up"}</span></div>
          {depositor && depositor !== addr && <div className="kv"><span>Gateway depositor</span><a className="mono" href={`${ARC_EXPLORER}/address/${depositor}`} target="_blank" rel="noreferrer" title={depositor}>{shortAddr(depositor)}</a></div>}
        </div>
      )}
      <ConnectCircleWallet />
    </section>
  );
}
