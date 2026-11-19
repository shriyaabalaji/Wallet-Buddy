// Where the owner's own browser wallet (MetaMask) deposits USDC so agents can spend it: Circle Gateway's GatewayWallet
// contract on Arc, credited to the payer's Gateway balance with depositFor(token, depositor, value). This is the same
// call the treasury top-up makes (funding.ts), signed by the owner's wallet instead of the service key.
// The firewall only reports these facts (GET /health, owner view); it never sees or signs the deposit.
// Addresses per @circle-fin/x402-batching CHAIN_CONFIGS (2.0.4 `arcTestnet`, 3.5.0 `arc`); test/deposit.test.ts
// checks them against both installed packages.
import "./network";
import { getAddress, isAddress } from "viem";
import { arc, arcTestnet } from "viem/chains";
import { network, type Network } from "./network";
import { circleWallet, paymentMode, type PaymentMode } from "./wallet";
import { signerAddress } from "./signer";

export const GATEWAY_ON_ARC = {
  testnet: { chain: arcTestnet, domain: 26, usdc: "0x3600000000000000000000000000000000000000", gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9", api: "https://gateway-api-testnet.circle.com/v1" },
  mainnet: { chain: arc, domain: 26, usdc: "0x3600000000000000000000000000000000000000", gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE", api: "https://gateway-api.circle.com/v1" },
} as const;

export type DepositInfo =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      network: Network;
      chainId: number;
      chainName: string;
      rpcUrls: string[];
      explorerUrl: string;
      usdc: string;
      gatewayWallet: string;
      /** Whose Gateway balance the deposit credits: the Agent Wallet's backing EOA, or the local buyer key. */
      depositor: string;
      paymentMode: PaymentMode;
    };

export type DepositInputs = {
  network: Network;
  paymentMode: PaymentMode;
  mockPayments: boolean;
  /** CIRCLE_GATEWAY_DEPOSITOR: an Agent Wallet's Gateway balance belongs to its backing EOA, not the wallet address. */
  circleDepositor?: string;
  /** The local buyer key's address (PAYMENT_MODE=local-key). */
  localSigner?: string | null;
};

export function depositInfo(o: DepositInputs): DepositInfo {
  if (o.mockPayments) {
    return { enabled: false, reason: "Payments on this firewall are simulated (MOCK_PAYMENTS=1), so agents don't spend from Circle Gateway. Deposits are off so real money can't go into a test setup." };
  }
  let depositor: string | null = null;
  if (o.paymentMode === "circle-agent-wallet") {
    if (!o.circleDepositor || !isAddress(o.circleDepositor)) {
      return { enabled: false, reason: "Connect your Circle Agent Wallet first (Settings → Wallet), so deposits know where to go. Or set CIRCLE_GATEWAY_DEPOSITOR on the firewall." };
    }
    depositor = getAddress(o.circleDepositor);
  } else {
    if (o.network === "mainnet") return { enabled: false, reason: "Mainnet pays only from a Circle Agent Wallet." };
    if (!o.localSigner || !isAddress(o.localSigner)) return { enabled: false, reason: "No payer is configured on the firewall." };
    depositor = getAddress(o.localSigner);
  }
  const g = GATEWAY_ON_ARC[o.network];
  return {
    enabled: true,
    network: o.network,
    chainId: g.chain.id,
    chainName: g.chain.name,
    rpcUrls: [...g.chain.rpcUrls.default.http],
    explorerUrl: g.chain.blockExplorers.default.url,
    usdc: getAddress(g.usdc),
    gatewayWallet: getAddress(g.gatewayWallet),
    depositor,
    paymentMode: o.paymentMode,
  };
}

/** The deposit target for this firewall process, from its environment. */
export const currentDepositInfo = (): DepositInfo =>
  depositInfo({
    network,
    paymentMode: paymentMode(),
    mockPayments: process.env.MOCK_PAYMENTS === "1",
    circleDepositor: circleWallet().depositor ?? undefined,
    localSigner: signerAddress(),
  });

export type GatewayBalance = { depositor: string; availableUsdc: number } | { depositor: string; error: string };

const balanceCache = new Map<string, { at: number; value: GatewayBalance }>();

/**
 * The payer's Circle Gateway balance (what agents spend from), from Circle's public Gateway API: the same
 * POST /balances call GatewayClient.getGatewayBalance makes, which needs no key. Independent of automatic top-ups
 * (funding.ts needs the treasury key), so the dashboard shows the balance however it was funded, e.g. from MetaMask.
 * Cached briefly: the dashboard polls /health every 15 s per open tab.
 */
export async function payerGatewayBalance(info: DepositInfo, opts: { fetchImpl?: typeof fetch; cacheMs?: number } = {}): Promise<GatewayBalance | null> {
  if (!info.enabled) return null;
  const { fetchImpl = fetch, cacheMs = 10_000 } = opts;
  const key = `${info.network}:${info.depositor}`;
  const hit = balanceCache.get(key);
  if (hit && Date.now() - hit.at < cacheMs) return hit.value;
  const g = GATEWAY_ON_ARC[info.network];
  let value: GatewayBalance;
  try {
    const res = await fetchImpl(`${g.api}/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "USDC", sources: [{ depositor: info.depositor, domain: g.domain }] }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => null)) as { balances?: { balance?: string }[]; message?: string } | null;
    if (!res.ok) throw new Error(data?.message ?? `Circle Gateway answered ${res.status}`);
    const raw = data?.balances?.[0]?.balance;
    const n = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(n)) throw new Error("Circle Gateway returned no balance for this address.");
    value = { depositor: info.depositor, availableUsdc: n };
  } catch (e) {
    value = { depositor: info.depositor, error: e instanceof Error ? e.message.split("\n")[0]! : "unreadable" };
  }
  balanceCache.set(key, { at: Date.now(), value });
  return value;
}
