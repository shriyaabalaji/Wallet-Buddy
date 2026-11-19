// Owner deposit from MetaMask into Circle Gateway on Arc: approve(GatewayWallet, amount), then
// GatewayWallet.depositFor(USDC, depositor, amount). Same two calls as GatewayClient.depositFor in
// @circle-fin/x402-batching, signed by the owner's browser wallet. The target comes from the firewall's
// GET /health (owner view, `deposit`); this file only talks to the wallet (EIP-1193), never to a server.
import { encodeFunctionData, formatUnits, getAddress, isAddress, numberToHex, parseUnits, type Hex } from "viem";

/** The owner view of /health → deposit (firewall src/deposit.ts). */
export type DepositInfo =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      network: "testnet" | "mainnet";
      chainId: number;
      chainName: string;
      rpcUrls: string[];
      explorerUrl: string;
      usdc: string;
      gatewayWallet: string;
      depositor: string;
      paymentMode: "local-key" | "circle-agent-wallet";
    };
export type DepositTarget = Extract<DepositInfo, { enabled: true }>;

/** Minimal EIP-1193 provider (what MetaMask injects). */
export type Eip1193 = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...args: any[]) => void): void;
  removeListener?(event: string, fn: (...args: any[]) => void): void;
  isMetaMask?: boolean;
};

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
// From GATEWAY_WALLET_ABI in @circle-fin/x402-batching (client/index.mjs).
const GATEWAY_WALLET_ABI = [
  { name: "depositFor", type: "function", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "depositor", type: "address" }, { name: "value", type: "uint256" }], outputs: [] },
  { name: "availableBalance", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }, { name: "depositor", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const addr = (a: string) => getAddress(a);
export const approveData = (spender: string, amount: bigint): Hex => encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [addr(spender), amount] });
export const allowanceData = (owner: string, spender: string): Hex => encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [addr(owner), addr(spender)] });
export const balanceOfData = (account: string): Hex => encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [addr(account)] });
export const depositForData = (token: string, depositor: string, value: bigint): Hex => encodeFunctionData({ abi: GATEWAY_WALLET_ABI, functionName: "depositFor", args: [addr(token), addr(depositor), value] });
export const availableBalanceData = (token: string, depositor: string): Hex => encodeFunctionData({ abi: GATEWAY_WALLET_ABI, functionName: "availableBalance", args: [addr(token), addr(depositor)] });

/** GatewayClient.depositFor sends depositFor with a fixed 120k gas limit; we do the same. */
export const DEPOSIT_GAS = 120_000n;
export const USDC_DECIMALS = 6;
export const MIN_DEPOSIT = parseUnits("0.01", USDC_DECIMALS);

/** "5", "5.25", "0.01" → micro-USDC. Plain decimals only (no signs, exponents, commas), at most 6 places, at least $0.01. */
export function parseUsdcAmount(input: string): { ok: true; micro: bigint } | { ok: false; error: string } {
  const s = input.trim().replace(/^\$/, "");
  if (!s) return { ok: false, error: "Enter an amount." };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return { ok: false, error: "Enter a number, like 5 or 2.50." };
  const [, frac = ""] = s.split(".");
  if (frac.length > USDC_DECIMALS) return { ok: false, error: "USDC has at most 6 decimal places." };
  const micro = parseUnits(s.startsWith(".") ? `0${s}` : s.endsWith(".") ? s.slice(0, -1) : s, USDC_DECIMALS);
  if (micro < MIN_DEPOSIT) return { ok: false, error: "The smallest deposit is $0.01." };
  return { ok: true, micro };
}

export const formatUsdc = (micro: bigint) => {
  const [whole, frac = ""] = formatUnits(micro, USDC_DECIMALS).split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
};

/** wallet_addEthereumChain params. Arc's gas token is USDC (18 decimals natively; the ERC-20 view has 6). */
export const addChainParams = (t: DepositTarget) => ({
  chainId: numberToHex(t.chainId),
  chainName: t.chainName,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: t.rpcUrls,
  blockExplorerUrls: [t.explorerUrl],
});

/** A wallet error in plain words. 4001 = the owner rejected; -32002 = a request is already open in MetaMask. */
export function walletError(e: unknown): string {
  const err = e as { code?: number; message?: string; shortMessage?: string } | null;
  if (err?.code === 4001) return "You cancelled in MetaMask.";
  if (err?.code === -32002) return "MetaMask already has a request open. Open MetaMask to finish or close it.";
  if (err?.code === 4100) return "MetaMask hasn't allowed this page to use your account on Arc. In MetaMask, open the connected-sites menu for this page, disconnect it, then reload and connect again with your account and Arc selected.";
  const m = err?.shortMessage ?? err?.message;
  return m ? m.split("\n")[0]! : "MetaMask couldn't finish that.";
}

/**
 * Find MetaMask: EIP-6963 announcement (rdns io.metamask) first, so another wallet extension holding
 * window.ethereum doesn't get the request; then window.ethereum if it says it's MetaMask.
 */
export function findMetaMask(timeoutMs = 300): Promise<Eip1193 | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const onAnnounce = (ev: Event) => {
      const d = (ev as CustomEvent<{ info?: { rdns?: string }; provider?: Eip1193 }>).detail;
      if (!done && d?.info?.rdns?.startsWith("io.metamask") && d.provider) finish(d.provider);
    };
    const finish = (p: Eip1193 | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve(p);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      const injected = (window as unknown as { ethereum?: Eip1193 }).ethereum;
      finish(injected?.isMetaMask ? injected : null);
    }, timeoutMs);
  });
}

/** eth_call returning a uint256. "0x" means no contract there (wrong network or address). */
async function readUint(p: Eip1193, to: string, data: Hex): Promise<bigint> {
  const r = (await p.request({ method: "eth_call", params: [{ to, data }, "latest"] })) as string;
  if (!r || r === "0x") throw new Error("No contract answered on this network.");
  return BigInt(r);
}

export const usdcBalance = (p: Eip1193, t: DepositTarget, account: string) => readUint(p, t.usdc, balanceOfData(account));
export const gatewayBalance = (p: Eip1193, t: DepositTarget) => readUint(p, t.gatewayWallet, availableBalanceData(t.usdc, t.depositor));
export const allowance = (p: Eip1193, t: DepositTarget, account: string) => readUint(p, t.usdc, allowanceData(account, t.gatewayWallet));

export async function chainId(p: Eip1193): Promise<number> {
  return Number(BigInt((await p.request({ method: "eth_chainId" })) as string));
}

/** Switch MetaMask to the target Arc network, adding it first if MetaMask doesn't know it (4902). */
export async function switchToArc(p: Eip1193, t: DepositTarget): Promise<void> {
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(t.chainId) }] });
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } })?.code ?? (e as any)?.data?.originalError?.code;
    if (code !== 4902) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [addChainParams(t)] });
    // Some MetaMask versions add the network without switching to it.
    if ((await chainId(p)) !== t.chainId) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(t.chainId) }] });
  }
}

const errCode = (e: unknown) => (e as { code?: number })?.code ?? (e as any)?.data?.originalError?.code;

/**
 * eth_sendTransaction, recovering once from 4100 ("account and/or method has not been authorized"): MetaMask has no
 * permission for this account or network on this page, e.g. a stale connection for the same localhost origin from
 * another project. Ask MetaMask to reconnect (the owner picks accounts and networks), switch to Arc again, re-run the
 * safety checks, then retry. A second 4100 is returned to the owner.
 */
async function sendTx(p: Eip1193, t: DepositTarget, guard: () => Promise<void>, tx: Record<string, string>): Promise<string> {
  try {
    return (await p.request({ method: "eth_sendTransaction", params: [tx] })) as string;
  } catch (e) {
    if (errCode(e) !== 4100) throw e;
    await p.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    await switchToArc(p, t);
    await guard();
    return (await p.request({ method: "eth_sendTransaction", params: [tx] })) as string;
  }
}

/** Poll for a receipt; throws if the transaction reverted or nothing comes back in time. */
export async function waitForReceipt(p: Eip1193, hash: string, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
    if (r?.status) {
      if (r.status !== "0x1") throw new Error("The transaction failed on Arc. No USDC was deposited by it.");
      return;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("Arc hasn't confirmed the transaction yet. Check MetaMask's activity tab before trying again.");
}

export type DepositStep = "checking" | "approve" | "approving" | "deposit" | "depositing";

/**
 * approve (only if the current allowance is short; exact amount, never unlimited) → depositFor.
 * Before each signature, re-checks that MetaMask is still on the target chain and account, so a network or account
 * switch mid-flow can't send the transaction somewhere else. Returns the deposit tx hash.
 */
export async function deposit(p: Eip1193, t: DepositTarget, account: string, micro: bigint, onStep: (s: DepositStep) => void): Promise<string> {
  if (!isAddress(t.depositor) || !isAddress(t.gatewayWallet) || !isAddress(t.usdc)) throw new Error("The firewall reported an invalid deposit address.");
  const guard = async () => {
    if ((await chainId(p)) !== t.chainId) throw new Error(`MetaMask isn't on ${t.chainName} any more. Switch back and try again.`);
    const accounts = (await p.request({ method: "eth_accounts" })) as string[];
    if (!accounts[0] || getAddress(accounts[0]) !== getAddress(account)) throw new Error("The MetaMask account changed. Review the deposit again.");
  };
  onStep("checking");
  await guard();
  if ((await usdcBalance(p, t, account)) < micro) throw new Error("This MetaMask account doesn't have that much USDC on Arc.");
  if ((await allowance(p, t, account)) < micro) {
    onStep("approve");
    await guard();
    const approveTx = await sendTx(p, t, guard, { from: account, to: t.usdc, data: approveData(t.gatewayWallet, micro) });
    onStep("approving");
    await waitForReceipt(p, approveTx);
  }
  onStep("deposit");
  await guard();
  const tx = await sendTx(p, t, guard, { from: account, to: t.gatewayWallet, data: depositForData(t.usdc, t.depositor, micro), gas: numberToHex(DEPOSIT_GAS) });
  onStep("depositing");
  await waitForReceipt(p, tx);
  return tx;
}
