// Demo research agent. It has NO private key. Every payment goes:
//   seller 402 → firewall /evaluate (allow | hold | block) → firewall /sign (only if allowed) → seller.
//
// Usage: npm start -w @agent-firewall/agent -- <normal|race|attack|all> [count]
//
// The "attack" phase simulates a hijacked agent: it obeys an instruction injected into a seller
// response. That's deliberate: the point is that the firewall holds even when the agent doesn't.
import { randomUUID } from "node:crypto";
import { formatUsd, type Category } from "@agent-firewall/policy";
import { createFirewallApi, createFirewallClient, type PaymentResult } from "@agent-firewall/client";

// Isolation guard: the agent must never be able to see a signing key or API secret. If one leaked into
// its environment (e.g. a shared .env), refuse to run instead of quietly holding it.
const LEAKED = Object.keys(process.env).filter((k) => k !== "ANTHROPIC_API_KEY" && /PRIVATE_KEY|SECRET|AUTH_TOKEN|API_KEY|MNEMONIC/i.test(k) && process.env[k]);
if (LEAKED.length) {
  console.error(`Refusing to start: the agent can see secrets (${LEAKED.join(", ")}). Give the agent only .env.agent.`);
  process.exit(78);
}

const FW = process.env.FIREWALL_URL ?? "http://localhost:4000";
const SELLERS = process.env.SELLERS_URL ?? "http://localhost:4200";
const AGENT_ID = process.env.AGENT_ID ?? "research-agent";
const TASK_ID = process.env.TASK_ID ?? "nba-injuries";
const MOCK = process.env.MOCK_PAYMENTS === "1";
// This agent's own firewall credential, bound to AGENT_ID (FIREWALL_AGENT_TOKENS on the firewall). It can only
// request payments for this agent; it can't change rules or resume the agent.
const TOKEN = process.env.FIREWALL_AGENT_TOKEN?.trim();
if (!TOKEN) console.warn("FIREWALL_AGENT_TOKEN is not set; the firewall will refuse this agent unless it allows unauthenticated agents (testnet only).");

// All payment logic (402 → /evaluate → /pay or /sign → seller → /settled|/failed) lives in @agent-firewall/client.
const firewall = createFirewallClient({ firewallUrl: FW, agentId: AGENT_ID, token: TOKEN, mockPayments: MOCK });
// Raw firewall calls for the demo-only paths the client deliberately doesn't offer (the hijacked agent, the optimizer).
const api = createFirewallApi({ firewallUrl: FW, token: TOKEN });
const post = api.post;
const payer = api.payer;

type BuyResult = PaymentResult;

/** Buy one x402 resource from the demo sellers through the firewall. */
export async function buy(path: string, opts: { recipient: string; category: Category; purpose: string; sourceContext?: string; taskId?: string; requestId?: string }): Promise<BuyResult> {
  return firewall.requestPayment({ url: SELLERS + path, ...opts, taskId: opts.taskId ?? TASK_ID });
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
const s = (await firewall.summary()) as any;
console.log(`\nSpent on this task: ${formatUsd(s.task.spentMicro)}${s.task.budgetMicro ? ` of ${formatUsd(s.task.budgetMicro)}` : ""} · today: ${formatUsd(s.today.spentMicro)}${s.today.capMicro ? ` of ${formatUsd(s.today.capMicro)}` : ""}`);
