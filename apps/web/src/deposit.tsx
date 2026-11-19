"use client";

import { useCallback, useEffect, useState } from "react";
import { useAgents } from "@/lib/agents";
import { Icon, shortAddr } from "@/components";
import {
  chainId as readChainId, deposit, findMetaMask, formatUsdc, gatewayBalance, parseUsdcAmount, switchToArc, usdcBalance, walletError,
  type DepositStep, type DepositTarget, type Eip1193,
} from "@/lib/deposit";

const GAS_HINT = 50_000n; // $0.05: Arc gas is paid in USDC from the same balance.

/**
 * Settings → Add money: the owner deposits USDC from MetaMask into the Gateway balance every agent spends from.
 * Where the money goes comes from the firewall (GET /health → deposit); the browser wallet signs both transactions.
 */
export function AddMoney() {
  const { health } = useAgents();
  const info = health?.deposit;
  const target = info?.enabled ? info : null;

  const [mm, setMm] = useState<Eip1193 | null | undefined>(undefined); // undefined while looking
  const [account, setAccount] = useState<string | null>(null);
  const [chain, setChain] = useState<number | null>(null);
  const [balances, setBalances] = useState<{ wallet: bigint; gateway: bigint } | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [amountErr, setAmountErr] = useState<string | null>(null);
  const [review, setReview] = useState<{ micro: bigint; target: DepositTarget; account: string } | null>(null);
  const [step, setStep] = useState<DepositStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ micro: bigint; url: string } | null>(null);

  // Find MetaMask once, pick up an already-connected account without prompting, and follow account/network switches.
  useEffect(() => {
    let p: Eip1193 | null = null;
    let live = true;
    const onAccounts = (a: string[]) => { setAccount(a?.[0] ?? null); setReview(null); setBalances(null); };
    const onChain = (c: string) => { setChain(Number(BigInt(c))); setReview(null); setBalances(null); };
    findMetaMask().then(async (found) => {
      if (!live) return;
      p = found;
      setMm(found);
      if (!found) return;
      found.on?.("accountsChanged", onAccounts);
      found.on?.("chainChanged", onChain);
      try {
        const a = (await found.request({ method: "eth_accounts" })) as string[];
        if (live) setAccount(a[0] ?? null);
        const c = await readChainId(found);
        if (live) setChain(c);
      } catch { /* not connected yet */ }
    });
    return () => {
      live = false;
      p?.removeListener?.("accountsChanged", onAccounts);
      p?.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const onTarget = Boolean(target && chain === target.chainId);
  const refresh = useCallback(async () => {
    if (!mm || !account || !target || chain !== target.chainId) return;
    try {
      const [wallet, gateway] = await Promise.all([usdcBalance(mm, target, account), gatewayBalance(mm, target)]);
      setBalances({ wallet, gateway });
      setReadErr(null);
    } catch (e) {
      setReadErr(walletError(e));
    }
  }, [mm, account, target, chain]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function connect() {
    if (!mm) return;
    setError(null); setBusy(true);
    try {
      const a = (await mm.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(a[0] ?? null);
      setChain(await readChainId(mm));
    } catch (e) { setError(walletError(e)); } finally { setBusy(false); }
  }

  async function switchNetwork() {
    if (!mm || !target) return;
    setError(null); setBusy(true);
    try {
      await switchToArc(mm, target);
      setChain(await readChainId(mm));
    } catch (e) { setError(walletError(e)); } finally { setBusy(false); }
  }

  function startReview() {
    setError(null); setDone(null);
    const r = parseUsdcAmount(amount);
    if (!r.ok) { setAmountErr(r.error); return; }
    if (balances && r.micro > balances.wallet) { setAmountErr(`MetaMask has ${formatUsdc(balances.wallet)} USDC on Arc.`); return; }
    if (!target || !account) return;
    setAmountErr(null);
    setReview({ micro: r.micro, target, account });
  }

  async function confirm() {
    if (!mm || !review) return;
    setError(null); setBusy(true);
    let last: DepositStep | null = null;
    try {
      const tx = await deposit(mm, review.target, review.account, review.micro, (s) => { last = s; setStep(s); });
      setDone({ micro: review.micro, url: `${review.target.explorerUrl.replace(/\/$/, "")}/tx/${tx}` });
      setReview(null); setAmount("");
      await refresh();
    } catch (e) {
      setError(`${failedAt(last)}${walletError(e)}`);
      await refresh();
    } finally { setBusy(false); setStep(null); }
  }

  const failedAt = (s: DepositStep | null) =>
    s === "approve" || s === "approving" ? "The approval didn't go through. "
      : s === "deposit" || s === "depositing" ? "The deposit didn't go through. "
      : "Couldn't start the deposit. ";

  const stepLabel = (s: DepositStep | null, micro: bigint) => {
    const usd = `$${formatUsdc(micro)}`;
    switch (s) {
      case "checking": return "Checking your balance…";
      case "approve": return `Confirm in MetaMask: let Circle Gateway take ${usd}`;
      case "approving": return "Waiting for Arc to confirm…";
      case "deposit": return `Confirm in MetaMask: deposit ${usd}`;
      case "depositing": return "Waiting for Arc to confirm the deposit…";
      default: return "Working…";
    }
  };

  const mainnet = target?.network === "mainnet";
  return (
    <section className="panel" aria-labelledby="add-money">
      <div className="panel-head">
        <h2 id="add-money">Add money</h2>
      </div>

      {!health ? <p className="muted" role="status">Loading…</p>
        : !info ? <p className="muted">This firewall doesn&apos;t report where deposits go. Update it to the latest version.</p>
        : !info.enabled ? <p className="muted">{info.reason}</p>
        : (
          <>
            <div className="facts">
              <div className="kv">
                <span>Goes to</span>
                <a className="mono" href={`${info.explorerUrl}/address/${info.depositor}`} target="_blank" rel="noreferrer" title={info.depositor}>
                  {shortAddr(info.depositor)}
                </a>
              </div>
              {balances && <div className="kv"><span>Gateway balance</span><span>{formatUsdc(balances.gateway)} USDC</span></div>}
              {account && <div className="kv"><span>MetaMask</span><span className="mono" title={account}>{shortAddr(account)}</span></div>}
              {balances && <div className="kv"><span>USDC in MetaMask</span><span>{formatUsdc(balances.wallet)} USDC</span></div>}
            </div>
            {readErr && <p className="small warn-text" role="alert">Couldn&apos;t read balances: {readErr}</p>}

            {mm === undefined ? <p className="muted" role="status">Looking for MetaMask…</p>
              : mm === null ? (
                <div className="callout info">
                  <strong>MetaMask isn&apos;t installed in this browser.</strong>
                  <p className="small">Install it, then reload this page.</p>
                  <a className="btn secondary sm" href="https://metamask.io/download/" target="_blank" rel="noreferrer">Get MetaMask</a>
                </div>
              )
              : !account ? <div><button className="btn" onClick={connect} disabled={busy}>{busy ? "Waiting for MetaMask…" : "Connect MetaMask"}</button></div>
              : !onTarget ? (
                <div className="stack">
                  <p className="small muted">MetaMask is on a different network.</p>
                  <div><button className="btn" onClick={switchNetwork} disabled={busy}>{busy ? "Waiting for MetaMask…" : `Switch to ${info.chainName}`}</button></div>
                </div>
              )
              : review ? (
                <div className={`callout ${mainnet ? "attention" : "info"}`}>
                  <strong>Deposit ${formatUsdc(review.micro)} USDC</strong>
                  <p className="small">
                    From <span className="mono">{shortAddr(review.account)}</span> to the Gateway balance of{" "}
                    <span className="mono">{shortAddr(review.target.depositor)}</span> on {review.target.chainName}.
                    MetaMask asks you to confirm up to twice: first to let Circle Gateway take exactly ${formatUsdc(review.micro)}, then the deposit.
                  </p>
                  {mainnet && <p className="small"><strong>This is real money.</strong> It stays in Circle Gateway until your agents spend it.</p>}
                  {balances && review.micro + GAS_HINT > balances.wallet && <p className="small">Arc charges gas in USDC, so leave a few cents in MetaMask or the deposit may fail.</p>}
                  <div className="toolbar">
                    <button className="btn" onClick={confirm} disabled={busy}>{busy ? "Depositing…" : "Deposit"}</button>
                    <button className="btn secondary" onClick={() => { setReview(null); setError(null); }} disabled={busy}>Back</button>
                  </div>
                  {busy && <p className="small" role="status">{stepLabel(step, review.micro)}</p>}
                </div>
              )
              : (
                <div className="stack">
                  <div className="field">
                    <label htmlFor="deposit-amount">Amount (USDC)</label>
                    <input
                      id="deposit-amount" type="text" inputMode="decimal" autoComplete="off" placeholder="5.00"
                      value={amount} onChange={(e) => { setAmount(e.target.value); setAmountErr(null); setDone(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") startReview(); }}
                      aria-invalid={amountErr ? true : undefined} aria-describedby={amountErr ? "deposit-err" : undefined}
                    />
                    {amountErr && <p id="deposit-err" role="alert" className="field-err">{amountErr}</p>}
                  </div>
                  <div><button className="btn" onClick={startReview} disabled={!amount.trim()}>Review deposit</button></div>
                </div>
              )}

            {done && (
              <p className="saved-note" role="status">
                <Icon name="check" size={16} />Deposited ${formatUsdc(done.micro)}.{" "}
                <a href={done.url} target="_blank" rel="noreferrer" className="verify">View on Arc</a> It can take a minute to show up.
              </p>
            )}
            {error && <p className="small warn-text" role="alert">{error}</p>}
          </>
        )}
    </section>
  );
}
