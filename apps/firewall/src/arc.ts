// Arc testnet adapter (viem). Every function is a no-op returning null when Arc isn't configured,
// so the firewall runs locally without keys. Contract ABIs match /contracts/src.
import { sellerAddress } from "./sellers";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseGwei, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { idToBytes32, microToErc20 } from "@agent-firewall/policy";
import { config } from "./config";

export const arcTestnet = defineChain({
  id: config.arc.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [config.arc.rpcUrl] } },
  blockExplorers: { default: { name: "Arc Explorer", url: config.arc.explorerUrl } },
  testnet: true,
});

const registryAbi = parseAbi([
  "function commitPolicy(bytes32 agentId, bytes32 policyHash)",
  "function logDecision(bytes32 agentId, bytes32 requestId, uint8 outcome, bytes32 ruleId, uint256 amount)",
  "function logDecisions(bytes32 agentId, bytes32[] requestIds, uint8[] outcomes, bytes32[] ruleIds, uint256[] amounts)",
]);
const vaultAbi = parseAbi([
  "function hold(bytes32 requestId, address recipient, uint256 amount, uint64 expiresAt)",
  "function approve(bytes32 requestId)",
  "function deny(bytes32 requestId)",
  "function refundExpired(bytes32 requestId)",
]);

const vaultReadAbi = parseAbi(["function usdc() view returns (address)", "function treasury() view returns (address)"]);
const erc20Abi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const service = config.arc.servicePrivateKey ? createWalletClient({ chain: arcTestnet, transport: http(), account: privateKeyToAccount(config.arc.servicePrivateKey) }) : null;
const owner = config.arc.ownerPrivateKey ? createWalletClient({ chain: arcTestnet, transport: http(), account: privateKeyToAccount(config.arc.ownerPrivateKey) }) : null;

export const arcStatus = () => ({
  registry: Boolean(service && config.arc.registryAddress),
  vault: Boolean(service && config.arc.vaultAddress),
  ownerKey: Boolean(owner),
});

const MIN_FEE = parseGwei("20"); // Arc testnet rejects low fees (docs/RESEARCH.md)

// One queue per signing account: two txs from the same key at once collide on the nonce
// ("replacement transaction underpriced"; seen live when a Gateway top-up overlapped a vault hold).
const queues = new Map<string, Promise<unknown>>();
export function serialized<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(account) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(account, next.catch(() => {}));
  return next;
}
const TRANSIENT = /replacement transaction underpriced|nonce too low|nonce has already been used|already known/i;

async function send(wallet: typeof service, address: Hex, abi: any, functionName: string, args: unknown[]): Promise<Hex> {
  if (!wallet) throw new Error("wallet not configured");
  return serialized(wallet.account!.address, async () => {
    try {
      return await sendNow(wallet, address, abi, functionName, args);
    } catch (e) {
      if (!TRANSIENT.test(String((e as Error)?.message))) throw e;
      await new Promise((r) => setTimeout(r, 1500)); // let the other tx land, then retry once with a fresh nonce
      return sendNow(wallet, address, abi, functionName, args);
    }
  });
}

async function sendNow(wallet: NonNullable<typeof service>, address: Hex, abi: any, functionName: string, args: unknown[]): Promise<Hex> {
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  try {
    const est = await publicClient.estimateFeesPerGas();
    fees = { maxFeePerGas: est.maxFeePerGas > MIN_FEE ? est.maxFeePerGas : MIN_FEE, maxPriorityFeePerGas: est.maxPriorityFeePerGas };
  } catch {
    fees = { maxFeePerGas: MIN_FEE * 2n, maxPriorityFeePerGas: parseGwei("1") };
  }
  const hash = await wallet.writeContract({ address, abi, functionName, args, chain: arcTestnet, account: wallet.account!, ...fees } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return hash;
}

const OUTCOME = { allow: 0, block: 1, hold: 2 } as const;

export async function commitPolicyOnArc(agentId: string, policyHash: Hex): Promise<Hex | null> {
  // NOTE: commitPolicy is onlyOwner. Deploy with owner = service key for the hackathon (see README Safety limits).
  if (!arcStatus().registry) return null;
  return send(service, config.arc.registryAddress!, registryAbi, "commitPolicy", [idToBytes32(agentId), policyHash]);
}

export async function logDecisionsOnArc(
  agentId: string,
  items: { requestId: string; outcome: keyof typeof OUTCOME; ruleId: string | null; amountMicro: number }[],
): Promise<Hex | null> {
  if (!arcStatus().registry || items.length === 0) return null;
  return send(service, config.arc.registryAddress!, registryAbi, "logDecisions", [
    idToBytes32(agentId),
    items.map((i) => idToBytes32(i.requestId)),
    items.map((i) => OUTCOME[i.outcome]),
    items.map((i) => idToBytes32(i.ruleId ?? "")),
    items.map((i) => microToErc20(i.amountMicro)),
  ]);
}

/** Vault holds need a real 0x recipient. Seller names (e.g. "sportsfeed") come from the seller registry (sellers.ts). */
export function resolveRecipient(recipient: string): Hex | null {
  return sellerAddress(recipient);
}

/** How much USDC the vault may still pull from the treasury (hold() uses transferFrom), plus the treasury balance. 6-decimal micro units. */
export async function vaultFunding(): Promise<{ treasury: Hex; allowanceMicro: number; balanceMicro: number } | null> {
  if (!arcStatus().vault) return null;
  const vault = config.arc.vaultAddress!;
  const [usdc, treasury] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultReadAbi, functionName: "usdc" }),
    publicClient.readContract({ address: vault, abi: vaultReadAbi, functionName: "treasury" }),
  ]);
  const [allowance, balance] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [treasury, vault] }),
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [treasury] }),
  ]);
  return { treasury, allowanceMicro: Number(allowance), balanceMicro: Number(balance) };
}

/** USDC token address (read from the vault so it can't drift from what the vault uses). */
export async function usdcAddress(): Promise<Hex | null> {
  if (!config.arc.vaultAddress) return (process.env.USDC_ADDRESS as Hex | undefined) ?? null;
  return publicClient.readContract({ address: config.arc.vaultAddress, abi: vaultReadAbi, functionName: "usdc" });
}

export { publicClient as arcPublicClient };

export async function vaultHold(requestId: string, recipient: string, amountMicro: number, expiresAt: Date): Promise<Hex | null> {
  const to = resolveRecipient(recipient);
  if (!arcStatus().vault || !to) return null;
  // Fail with a readable reason instead of an ERC20 revert (seen live: allowance ran out after earlier holds).
  const f = await vaultFunding();
  if (f && f.allowanceMicro < amountMicro) throw new Error(`Treasury allowance for the vault is too low (${f.allowanceMicro / 1e6} USDC left, need ${amountMicro / 1e6}).`);
  if (f && f.balanceMicro < amountMicro) throw new Error(`Treasury balance is too low (${f.balanceMicro / 1e6} USDC, need ${amountMicro / 1e6}).`);
  return send(service, config.arc.vaultAddress!, vaultAbi, "hold", [idToBytes32(requestId), to, microToErc20(amountMicro), BigInt(Math.floor(expiresAt.getTime() / 1000))]);
}

export async function vaultDeny(requestId: string): Promise<Hex | null> {
  if (!arcStatus().vault) return null;
  return send(service, config.arc.vaultAddress!, vaultAbi, "deny", [idToBytes32(requestId)]);
}

export async function vaultRefundExpired(requestId: string): Promise<Hex | null> {
  if (!arcStatus().vault) return null;
  return send(service, config.arc.vaultAddress!, vaultAbi, "refundExpired", [idToBytes32(requestId)]);
}

/** Release requires the OWNER key. Only called after a verified passkey assertion. */
export async function vaultApprove(requestId: string): Promise<Hex | null> {
  if (!arcStatus().vault || !owner) return null;
  return send(owner, config.arc.vaultAddress!, vaultAbi, "approve", [idToBytes32(requestId)]);
}
