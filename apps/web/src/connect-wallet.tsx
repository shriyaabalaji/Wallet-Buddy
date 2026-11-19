"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { useAgents } from "@/lib/agents";
import { ErrorState, Icon, shortAddr } from "@/components";

/** GET /v1/owner/wallet (firewall circle-connect.ts). */
type WalletStatus = {
  network: "testnet" | "mainnet";
  chain: string;
  paymentMode: "local-key" | "circle-agent-wallet";
  wallet: { address: string | null; depositor: string | null; source: "dashboard" | "env" };
  connected: { email: string; connectedAt: string } | null;
  cli: { installed: boolean; version: string | null };
  terms: { accepted: boolean; termsOfUseUrl: string; privacyPolicyUrl: string } | null;
  session: { signedIn: boolean; email: string | null; expired: boolean } | null;
  pending: { email: string; expiresAt: string } | null;
};

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : "Something went wrong.", 0));

/**
 * Settings → Wallet: connect the Circle Agent Wallet every agent pays from, without a terminal. The firewall runs
 * Circle's CLI on its own machine: Circle emails you a code, you type it here, and the firewall finds the wallet and
 * its Gateway account. The code is only ever typed by you.
 */
export function ConnectCircleWallet() {
  const { refreshHealth } = useAgents();
  const [st, setSt] = useState<WalletStatus | null>(null);
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otherEmail, setOtherEmail] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await api<WalletStatus>("/v1/owner/wallet"));
      setLoadErr(null);
    } catch (e) { setLoadErr(asError(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(label: string, path: string, body: unknown, after?: (s: WalletStatus | null) => void) {
    setBusy(label); setErr(null); setDone(null);
    try {
      const r = await api<WalletStatus | { email: string; expiresAt: string }>(path, { method: "POST", body });
      if ("network" in r) { setSt(r); after?.(r); } else { await load(); after?.(null); }
      await refreshHealth();
    } catch (e) {
      setErr(asError(e).message);
      await load();
    } finally { setBusy(null); }
  }

  if (loadErr && !st) return <ErrorState error={loadErr} onRetry={load} />;
  if (!st) return <p className="muted" role="status">Checking Circle…</p>;

  const net = st.network === "mainnet" ? "Arc mainnet" : "Arc testnet";
  const where = st.network === "mainnet" ? "" : " --testnet";

  let body: React.ReactNode;
  if (!st.cli.installed) {
    body = (
      <div className="callout attention">
        <strong>Circle&apos;s CLI isn&apos;t installed on the firewall&apos;s machine.</strong>
        <p className="small">Run <code>npm i -g @circle-fin/cli@1.4.0</code> there, then reload this page.</p>
      </div>
    );
  } else if (st.connected) {
    body = (
      <div className="stack">
        <p className="small">
          <Icon name="check" size={14} /> Connected as <strong>{st.connected.email}</strong> on {net}. Every agent pays from this wallet; use Add money below to fund it.
        </p>
        <div>
          <button className="btn secondary" disabled={Boolean(busy)} onClick={() => act("disconnect", "/v1/owner/wallet/disconnect", {}, () => setDone("Disconnected. The firewall is back to the wallet in its settings file."))}>
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
        <p className="muted small">Disconnecting stops paying from this wallet. Circle&apos;s CLI stays signed in on the firewall&apos;s machine (<code>circle wallet logout</code> there signs it out).</p>
      </div>
    );
  } else if (!st.terms?.accepted) {
    body = (
      <div className="stack">
        <p className="small">The firewall signs in to Circle with Circle&apos;s CLI, which needs you to accept Circle&apos;s Terms first.</p>
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>
            I&apos;ve read and accept Circle&apos;s{" "}
            <a href={st.terms?.termsOfUseUrl ?? "https://agents.circle.com/terms-of-use"} target="_blank" rel="noreferrer">Terms of Use</a> and{" "}
            <a href={st.terms?.privacyPolicyUrl ?? "https://www.circle.com/legal/privacy-policy"} target="_blank" rel="noreferrer">Privacy Policy</a>
          </span>
        </label>
        <div><button className="btn" disabled={!agree || Boolean(busy)} onClick={() => act("terms", "/v1/owner/wallet/terms", { accept: true })}>{busy === "terms" ? "Saving…" : "Continue"}</button></div>
      </div>
    );
  } else if (st.pending) {
    body = (
      <div className="stack">
        <p className="small">Circle emailed a code to <strong>{st.pending.email}</strong>. Type it here yourself; never give an AI access to your inbox.</p>
        <div className="field">
          <label htmlFor="circle-code">Code from the email</label>
          <input
            id="circle-code" type="text" inputMode="text" autoComplete="one-time-code" placeholder="B1X-123456" spellCheck={false}
            value={code} onChange={(e) => { setCode(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) void act("verify", "/v1/owner/wallet/verify", { code }, () => { setCode(""); setDone("Connected. Agents now pay from this wallet."); }); }}
          />
          <p className="small muted">Type the whole code, like B1X-123456. Circle&apos;s CLI checks that the part before the dash belongs to this sign-in.</p>
        </div>
        <div className="toolbar">
          <button className="btn" disabled={!code.trim() || Boolean(busy)} onClick={() => act("verify", "/v1/owner/wallet/verify", { code }, () => { setCode(""); setDone("Connected. Agents now pay from this wallet."); })}>
            {busy === "verify" ? "Connecting…" : "Connect wallet"}
          </button>
          <button className="btn secondary" disabled={Boolean(busy)} onClick={() => act("code", "/v1/owner/wallet/code", { email: st.pending!.email })}>{busy === "code" ? "Sending…" : "Send a new code"}</button>
        </div>
      </div>
    );
  } else if (st.session?.signedIn && !otherEmail) {
    body = (
      <div className="stack">
        <p className="small">Circle&apos;s CLI on the firewall&apos;s machine is already signed in as <strong>{st.session.email}</strong> on {net}.</p>
        <div className="toolbar">
          <button className="btn" disabled={Boolean(busy)} onClick={() => act("connect", "/v1/owner/wallet/connect", {}, () => setDone("Connected. Agents now pay from this wallet."))}>{busy === "connect" ? "Connecting…" : "Use this account"}</button>
          <button className="btn secondary" disabled={Boolean(busy)} onClick={() => setOtherEmail(true)}>Use a different email</button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="stack">
        <p className="small">
          {st.session?.expired ? "Circle's sign-in on the firewall's machine expired. " : ""}
          Circle emails you a one-time code. The first sign-in with an email also creates your Agent Wallet.
        </p>
        <div className="field">
          <label htmlFor="circle-email">Your email</label>
          <input
            id="circle-email" type="text" inputMode="email" autoComplete="email" placeholder="you@example.com" spellCheck={false}
            value={email} onChange={(e) => { setEmail(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && email.trim()) void act("code", "/v1/owner/wallet/code", { email }); }}
          />
        </div>
        <div className="toolbar">
          <button className="btn" disabled={!email.trim() || Boolean(busy)} onClick={() => act("code", "/v1/owner/wallet/code", { email })}>{busy === "code" ? "Sending…" : "Send code"}</button>
          {otherEmail && <button className="btn secondary" disabled={Boolean(busy)} onClick={() => setOtherEmail(false)}>Back</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="steps">
      <h3 className="small-h">{st.connected ? "Circle Agent Wallet" : st.wallet.address ? "Connect a different wallet" : "Connect your Circle Agent Wallet"}</h3>
      {body}
      {done && <p className="saved-note" role="status"><Icon name="check" size={16} />{done}</p>}
      {err && <p className="small warn-text" role="alert">{err}</p>}
      {st.wallet.source === "dashboard" && st.wallet.address && (
        <p className="muted small">Wallet <span className="mono" title={st.wallet.address}>{shortAddr(st.wallet.address)}</span> · Gateway account <span className="mono" title={st.wallet.depositor ?? ""}>{st.wallet.depositor ? shortAddr(st.wallet.depositor) : "unknown"}</span></p>
      )}
      <details className="advanced">
        <summary>Set it up from a terminal instead</summary>
        <div className="advanced-body">
          <ol className="small">
            <li>Install Circle&apos;s CLI: <code>npm i -g @circle-fin/cli@1.4.0</code></li>
            <li>Sign in: <code>circle wallet login &lt;email&gt;{where}</code></li>
            <li>Find the wallet: <code>circle wallet list --type agent --chain {st.chain}</code>, then set <code>CIRCLE_AGENT_WALLET_ADDRESS</code> in <code>.env.firewall</code></li>
            <li>Find its Gateway account: <code>circle gateway balance --address &lt;wallet&gt; --chain {st.chain} --output json</code>, then set <code>backingEOA</code> as <code>CIRCLE_GATEWAY_DEPOSITOR</code></li>
            <li>Restart the firewall.</li>
          </ol>
        </div>
      </details>
    </div>
  );
}
