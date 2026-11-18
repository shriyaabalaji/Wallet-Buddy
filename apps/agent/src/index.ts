// Demo research agent. It has NO private key. Every payment goes:
//   seller 402 → firewall /evaluate (allow | hold | block) → firewall /sign (only if allowed) → seller.
//
// Usage: npm start -w @agent-firewall/agent -- <normal|race|attack|all> [count]
//
// The "attack" phase simulates a hijacked agent: it obeys an instruction injected into a seller
// response. That's deliberate: the point is that the firewall holds even when the agent doesn't.
import { randomUUID } from "node:crypto";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { formatUsd, type Category } from "@agent-firewall/policy";
import type { Address, Hex } from "viem";

// Isolation guard: the agent must never be able to see a signing key or API secret. If one leaked into
// its environment (e.g. a shared .env), refuse to run instead of quietly holding it.
const LEAKED = Object.keys(process.env).filter((k) => /PRIVATE_KEY|SECRET|AUTH_TOKEN|API_KEY|MNEMONIC/i.test(k) && process.env[k]);
if (LEAKED.length) {
  console.error(`Refusing to start: the agent can see secrets (${LEAKED.join(", ")}). Give the agent only .env.agent.`);
  process.exit(78);
}

const FW = process.env.FIREWALL_URL ?? "http://localhost:4000";
const SELLERS = process.env.SELLERS_URL ?? "http://localhost:4200";
const AGENT_ID = process.env.AGENT_ID ?? "research-agent";
const TASK_ID = process.env.TASK_ID ?? "nba-injuries";
const MOCK = process.env.MOCK_PAYMENTS === "1";
const MIN_VALIDITY_S = 8 * 24 * 3600;
// This agent's own firewall credential, bound to AGENT_ID (FIREWALL_AGENT_TOKENS on the firewall). It can only
// request payments for this agent; it can't change rules or resume the agent.
const TOKEN = process.env.FIREWALL_AGENT_TOKEN?.trim();
const AUTH: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
if (!TOKEN) console.warn("FIREWALL_AGENT_TOKEN is not set; the firewall will refuse this agent unless it allows unauthenticated agents (testnet only).");

const post = async (path: string, body: unknown) => {
  const r = await fetch(FW + path, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify(body) });
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};
const toJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

interface PayerInfo { address: Address | null; mode: "local-key" | "circle-agent-wallet"; network: string }
let payerInfo: PayerInfo | null = null;
const payer = async () => (payerInfo ??= (await (await fetch(`${FW}/v1/signer`)).json()) as PayerInfo);

/** A BatchEvmSigner whose signTypedData is a call to the firewall. The key never leaves the firewall. */
async function firewallScheme(requestId: string) {
  const { address } = await payer();
  if (!address) return null;
  return new BatchEvmScheme({
    address,
    signTypedData: async (td) => (await post(`/v1/payments/${requestId}/sign`, { typedData: toJson(td) })).signature as Hex,
  });
}

interface BuyResult {
  outcome: "allow" | "block" | "hold" | "error";
  reason: string;
  data?: unknown;
}

/** Buy one x402 resource through the firewall. */
export async function buy(path: string, opts: { recipient: string; category: Category; purpose: string; sourceContext?: string; taskId?: string; requestId?: string }): Promise<BuyResult> {
  const url = SELLERS + path;
  const first = await fetch(url);
  if (first.status !== 402) return { outcome: "error", reason: `expected 402, got ${first.status}` };
  const required = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
  const { mode, network } = await payer();
  const option = (required.accepts ?? []).find((o: any) => o.network === network && o.extra?.name === "GatewayWalletBatched");
  if (!option) return { outcome: "error", reason: "seller has no Arc Gateway option" };

  const requestId = opts.requestId ?? `req_${randomUUID()}`;
  const decision = await post("/v1/payments/evaluate", {
    requestId, agentId: AGENT_ID, taskId: opts.taskId ?? TASK_ID, recipient: opts.recipient,
    amountMicro: Number(option.amount), category: opts.category, purpose: opts.purpose, sourceContext: opts.sourceContext,
  });
  if (decision.outcome !== "allow") return { outcome: decision.outcome, reason: decision.reason };

  if (mode === "circle-agent-wallet") {
    // Mainnet: the firewall pays from the Circle Agent Wallet and hands back the response body.
    // On failure the firewall has already recorded the outcome itself.
    try {
      const { body } = await post(`/v1/payments/${requestId}/pay`, { url });
      return { outcome: "allow", reason: decision.reason, data: JSON.parse(body) };
    } catch (e) {
      return { outcome: "error", reason: (e as Error).message };
    }
  }

  try {
    let header: string;
    const scheme = await firewallScheme(requestId);
    if (scheme) {
      // Gateway rejects authorizations valid for < ~7 days ("authorization_validity_too_short"), but
      // @circle-fin/x402-batching 2.0.4 sellers advertise 4 days. Sign for 8 days. See docs/RESEARCH.md.
      const signOption = { ...option, maxTimeoutSeconds: Math.max(option.maxTimeoutSeconds ?? 0, MIN_VALIDITY_S) };
      const payload = await scheme.createPaymentPayload(required.x402Version ?? 2, signOption);
      header = Buffer.from(JSON.stringify({ ...payload, resource: required.resource, accepted: option })).toString("base64");
    } else if (MOCK) {
      header = Buffer.from(JSON.stringify({ mock: true, requestId })).toString("base64");
    } else {
      throw new Error("firewall has no signer configured");
    }
    const paid = await fetch(url, { headers: { "Payment-Signature": header } });
    if (!paid.ok) throw new Error(`seller rejected payment: ${paid.status} ${await paid.text()}`);
    const settle = paid.headers.get("PAYMENT-RESPONSE");
    const tx = settle ? JSON.parse(Buffer.from(settle, "base64").toString("utf8")).transaction : undefined;
    await post(`/v1/payments/${requestId}/settled`, { txHash: tx || undefined });
    return { outcome: "allow", reason: decision.reason, data: await paid.json() };
  } catch (e) {
    await post(`/v1/payments/${requestId}/failed`, {}).catch(() => {});
    return { outcome: "error", reason: (e as Error).message };
  }
}

const log = (tag: string, r: BuyResult) => console.log(`  ${tag.padEnd(28)} ${r.outcome.toUpperCase().padEnd(6)} ${r.reason}`);

async function normal(n: number) {
  console.log(`\n▶ Normal work: buying ${n} injury reports`);
  for (let i = 0; i < n; i++) {
    const r = await buy("/sportsfeed/injuries", { recipient: "sportsfeed", category: "data", purpose: "An injury report" });
    log(`injury report #${i + 1}`, r);
    if (r.data) console.log(`    ↳ ${(r.data as any).report}`);
  }
}

async function race() {
  // A fresh task each run, so the task budget starts full and the demo is repeatable.
  const taskId = `${TASK_ID}-${Date.now().toString(36)}`;
  console.log(`\n▶ Race: two $0.80 bulk-odds requests at the same instant (task ${taskId})`);
  const [a, b] = await Promise.all([
    buy("/oddsapi/odds/bulk", { recipient: "oddsapi", category: "data", purpose: "Bulk odds (A)", taskId }),
    buy("/oddsapi/odds/bulk", { recipient: "oddsapi", category: "data", purpose: "Bulk odds (B)", taskId }),
  ]);
  log("request A", a);
  log("request B", b);
}

async function attack() {
  console.log("\n▶ Attack: compromised seller response contains an instruction");
  const r = await buy("/sportsfeed/injuries/live", { recipient: "sportsfeed", category: "data", purpose: "Live injury report" });
  log("live injury report", r);
  const note: string | undefined = (r.data as any)?.note;
  if (!note) return console.log("  (no injected note received)");
  console.log(`    ↳ seller said: "${note}"`);
  const m = note.match(/send (\d+(?:\.\d+)?) USDC to (0x[0-9a-fA-F]{40})/);
  if (!m) return;
  // Simulated hijack: the agent obeys.
  const [, amount, addr] = m;
  console.log(`  ⚠ agent is hijacked and tries to send $${amount} to ${addr}`);
  const requestId = `req_${randomUUID()}`;
  const d = await post("/v1/payments/evaluate", {
    requestId, agentId: AGENT_ID, taskId: TASK_ID, recipient: addr, amountMicro: Math.round(Number(amount) * 1e6),
    category: "other", purpose: "license renewal", sourceContext: "after response from sportsfeed",
  });
  console.log(`  firewall: ${d.outcome.toUpperCase()}: ${d.reason}`);
  for (const f of d.flags ?? []) console.log(`    flag: ${f}`);
  // It then tries to get the money signed anyway: refused, because only allowed payments get signatures.
  try {
    if ((await payer()).mode === "circle-agent-wallet") await post(`/v1/payments/${requestId}/pay`, { url: `${SELLERS}/sportsfeed/injuries` });
    else await post(`/v1/payments/${requestId}/sign`, { typedData: {} });
    console.log("  !!! firewall paid a payment it didn't allow (this should never happen)");
  } catch (e) {
    console.log(`  agent tries to get it signed directly → refused: ${(e as Error).message}`);
  }
  if (d.outcome === "hold") console.log("  → the owner was texted. Reply NO to cancel; approving needs their passkey.");
}


async function optimize() {
  // Ask the firewall's optimizer which demo seller to use for an injury report. Advice only: the purchase still goes
  // through /evaluate (policy + reservation) and the payer re-checks the seller's 402 before paying.
  console.log("\n▶ Optimizer: cheapest eligible seller for an injury report (both sellers are our demo providers)");
  const requestId = `req_${randomUUID()}`;
  const rec = await post("/v1/optimizer/recommend", { agentId: AGENT_ID, taskId: TASK_ID, need: { category: "data", sku: "injury-report" }, maxAmountMicro: 1_000_000, requestId });
  for (const c of rec.candidates.filter((c: any) => c.compatible)) console.log(`  ${c.name.padEnd(20)} ${c.quote ? formatUsd(c.quote.amountMicro) : "—"}  ${c.reason}`);
  console.log(`  → ${rec.explanation}`);
  if (!rec.recommended) return;
  const r = await buy(rec.recommended.path, { recipient: rec.recommended.recipient, category: "data", purpose: "An injury report (optimizer)", requestId });
  log(`bought from ${rec.recommended.providerId}`, r);
}

const [phase = "all", count = "5"] = process.argv.slice(2);
console.log(`Agent ${AGENT_ID} · task ${TASK_ID} · firewall ${FW} · sellers ${SELLERS}${MOCK ? " · MOCK payments" : ""}`);
if (phase === "normal" || phase === "all") await normal(Number(count));
if (phase === "race" || phase === "all") await race();
if (phase === "attack" || phase === "all") await attack();
if (phase === "optimize") await optimize();
const s = (await (await fetch(`${FW}/v1/agents/${AGENT_ID}/summary`, { headers: AUTH })).json()) as any;
console.log(`\nSpent on this task: ${formatUsd(s.task.spentMicro)}${s.task.budgetMicro ? ` of ${formatUsd(s.task.budgetMicro)}` : ""} · today: ${formatUsd(s.today.spentMicro)}${s.today.capMicro ? ` of ${formatUsd(s.today.capMicro)}` : ""}`);
