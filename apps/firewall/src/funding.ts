// Testnet buyer exposure cap. Circle Agent Wallet policies are mainnet-only (docs/RESEARCH.md Q9/Q10), so on
// testnet we cap what the payer can spend at all ourselves. The payer is the Circle Agent Wallet (default) or the
// local buyer key (PAYMENT_MODE=local-key); either way its Gateway balance only holds a small amount:
//   - Its Gateway balance is topped up from the TREASURY with depositFor(), at most DAILY_CAP per UTC day
//     (ledger in gateway_topups; the ledger, not the observed balance, is what bounds the daily total).
//   - local-key only: USDC in the buyer wallet above a small gas reserve is swept back to the treasury.
// Off on mainnet, where Circle's own policy is the outer wall.
// A leaked buyer key therefore exposes at most ~DAILY_CAP + the gas reserve, independent of the firewall's rules.
// API per @circle-fin/x402-batching@2.0.4 typings: GatewayClient.getBalances(), depositFor(amount, depositor).
import "./network";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import type { DB } from "./db";
import { arcPublicClient, arcTestnet, serialized, usdcAddress } from "./arc";
import { network } from "./network";
import { circleWallet, envPaymentMode, paymentMode } from "./wallet";

const DAILY_CAP = Math.round(Number(process.env.GATEWAY_DAILY_TOPUP_USDC ?? 5) * 1e6);
const GAS_RESERVE = Math.round(Number(process.env.BUYER_GAS_RESERVE_USDC ?? 0.5) * 1e6);
const MIN_MOVE = 10_000; // ignore dust under $0.01

const buyerKey = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
const treasuryKey = config.arc.servicePrivateKey;
const buyerAccount = buyerKey ? privateKeyToAccount(buyerKey) : null;
/** Whose Gateway balance we top up: the Circle Agent Wallet, or the local buyer key's address. */
// An Agent Wallet's Gateway balance belongs to its "backing EOA", not the SCA address. `circle gateway balance
// --output json` reports it as backingEOA; depositing for the SCA would fund a balance the CLI never spends.
// The payer can change at runtime (a Circle Agent Wallet connected from the dashboard, wallet.ts), so it's read per call.
const currentPayer = () => {
  if (paymentMode() === "circle-agent-wallet") {
    const w = circleWallet();
    return w.address ? w.depositor : null;
  }
  return buyerAccount?.address ?? null;
};
if (envPaymentMode === "circle-agent-wallet" && circleWallet().address && !circleWallet().depositor) console.warn("[funding] CIRCLE_GATEWAY_DEPOSITOR (the wallet's backingEOA) is not set: automatic Gateway top-ups are off.");
const enabled = network === "testnet" && Boolean(treasuryKey) && process.env.MOCK_PAYMENTS !== "1" && process.env.FUNDING !== "off";

const treasury = enabled ? new GatewayClient({ chain: "arcTestnet", privateKey: treasuryKey!, rpcUrl: config.arc.rpcUrl }) : null;
const treasuryAddress = treasuryKey ? privateKeyToAccount(treasuryKey).address : null;

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const toUsd = (micro: number | bigint) => (Number(micro) / 1e6).toFixed(2);

export function depositedToday(db: DB): number {
  const r = db.prepare("SELECT COALESCE(SUM(amount_micro),0) AS s FROM gateway_topups WHERE day=?").get(utcDay()) as { s: number };
  return r.s;
}

export async function fundingStatus(db: DB) {
  const payer = currentPayer();
  if (!treasury || !payer) return { enabled: false as const };
  const b = await treasury.getBalances(payer);
  return {
    enabled: true as const,
    payer,
    dailyCapUsdc: DAILY_CAP / 1e6,
    depositedTodayUsdc: depositedToday(db) / 1e6,
    gatewayAvailableUsdc: Number(b.gateway.available) / 1e6,
    buyerWalletUsdc: Number(b.wallet.balance) / 1e6,
    gasReserveUsdc: GAS_RESERVE / 1e6,
  };
}

/** Bring the buyer's Gateway balance up toward DAILY_CAP, never depositing more than DAILY_CAP per UTC day. */
export async function topUpGateway(db: DB): Promise<{ deposited: number; tx: string | null }> {
  const payer = currentPayer();
  if (!treasury || !payer) return { deposited: 0, tx: null };
  const available = Number((await treasury.getBalances(payer)).gateway.available);
  const room = DAILY_CAP - depositedToday(db);
  const amount = Math.min(DAILY_CAP - available, room);
  if (amount < MIN_MOVE) return { deposited: 0, tx: null };
  // Record first (pessimistic): a failed deposit removes its row; a crash mid-deposit can only under-fund, never over-fund.
  const row = db.prepare("INSERT INTO gateway_topups (day, amount_micro, created_at) VALUES (?,?,?)").run(utcDay(), amount, new Date().toISOString());
  try {
    // Same queue as the vault/registry txs: the treasury is the service key.
    const res = await serialized(treasuryAddress!, () => treasury.depositFor(toUsd(amount), payer));
    db.prepare("UPDATE gateway_topups SET tx=? WHERE id=?").run(res.depositTxHash, row.lastInsertRowid);
    console.log(`[funding] topped up payer ${payer} Gateway by $${toUsd(amount)} (tx ${res.depositTxHash})`);
    return { deposited: amount, tx: res.depositTxHash };
  } catch (e) {
    db.prepare("DELETE FROM gateway_topups WHERE id=?").run(row.lastInsertRowid);
    throw e;
  }
}

const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

/** Move buyer-wallet USDC above the gas reserve back to the treasury, so the buyer key can't reach it. */
export async function sweepBuyerWallet(): Promise<{ swept: number; tx: string | null }> {
  if (!enabled || paymentMode() !== "local-key" || !buyerAccount || !treasuryAddress) return { swept: 0, tx: null };
  const usdc = await usdcAddress();
  if (!usdc) return { swept: 0, tx: null };
  const bal = Number(await arcPublicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [buyerAccount.address] }));
  const amount = bal - GAS_RESERVE;
  if (amount < MIN_MOVE) return { swept: 0, tx: null };
  const wallet = createWalletClient({ chain: arcTestnet, transport: http(config.arc.rpcUrl), account: buyerAccount });
  const hash = await serialized(buyerAccount.address, () =>
    wallet.writeContract({ address: usdc, abi: erc20, functionName: "transfer", args: [treasuryAddress, BigInt(amount)], chain: arcTestnet, account: buyerAccount }),
  );
  const receipt = await arcPublicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`sweep reverted: ${hash}`);
  console.log(`[funding] swept $${toUsd(amount)} from buyer wallet to treasury (tx ${hash})`);
  return { swept: amount, tx: hash };
}
