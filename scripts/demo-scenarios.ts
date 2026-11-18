// Repeatable judge demo, scenarios A–F, against the RUNNING testnet stack (firewall :4000, sellers :4200).
//   set -a; . ./.env.firewall; set +a; npx tsx scripts/demo-scenarios.ts
// Plays two roles with two credentials: the OWNER (FIREWALL_OWNER_TOKEN: sets rules, pauses) and the AGENT
// (demo-agent's token from FIREWALL_AGENT_TOKENS: evaluates and pays). Real testnet payments happen in A and F only,
// through the configured payer (Circle Agent Wallet by default). Nothing here invents a transaction hash: it prints
// whatever the firewall recorded. Each run uses a fresh task id, so it can be repeated.
import { randomUUID } from "node:crypto";

const FW = process.env.FIREWALL_URL ?? "http://localhost:4000";
const SELLERS = process.env.SELLERS_URL ?? "http://localhost:4200";
const OWNER = process.env.FIREWALL_OWNER_TOKEN ?? "";
const AGENT_ID = "demo-agent";
const AGENT = (process.env.FIREWALL_AGENT_TOKENS ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith(`${AGENT_ID}=`))?.slice(AGENT_ID.length + 1) ?? "";
if (!OWNER || !AGENT) {
  console.error(`Needs FIREWALL_OWNER_TOKEN and a ${AGENT_ID}=<token> entry in FIREWALL_AGENT_TOKENS (load .env.firewall first).`);
  process.exit(2);
}
const TASK = `demo-${Date.now().toString(36)}`;
const ATTACKER = "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e";

async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(FW + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;
const evaluate = (requestId: string, recipient: string, amountMicro: number, purpose: string, sourceContext?: string, taskId = TASK) =>
  call(AGENT, "POST", "/v1/payments/evaluate", { requestId, agentId: AGENT_ID, taskId, recipient, amountMicro, category: "data", purpose, sourceContext });
const record = async (requestId: string) => {
  const a = await call(OWNER, "GET", `/v1/activity?agentId=${AGENT_ID}&requestId=${encodeURIComponent(requestId)}`);
  return (a.json.items ?? [])[0];
};
const results: { scenario: string; expected: string; got: string; pass: boolean }[] = [];
const check = (scenario: string, expected: string, got: string, pass: boolean) => {
  results.push({ scenario, expected, got, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${got}`);
};

console.log(`Demo scenarios · agent ${AGENT_ID} · task ${TASK} · firewall ${FW}`);
// Owner sets the rules: $3 per task, $5 per day, ask above $1, only our three demo sellers, unknown recipients blocked.
await call(OWNER, "POST", "/v1/agents/demo-agent/resume", {}).catch(() => {});
const rules = await call(OWNER, "POST", "/v1/policy", {
  agentId: AGENT_ID, confirmed: true,
  rules: [
    { id: "task-budget", kind: "taskBudget", taskId: "*", maxMicro: 3_000_000 },
    { id: "day-budget", kind: "periodBudget", period: "day", maxMicro: 5_000_000 },
    { id: "ask-first", kind: "approvalThreshold", aboveMicro: 1_000_000 },
    { id: "approved-recipients", kind: "allowlist", recipients: ["sportsfeed", "statline", "oddsapi"], onViolation: "block" },
  ],
});
if (rules.status !== 200) { console.error("Couldn't save rules:", rules.json); process.exit(1); }

console.log("\nA. Authorized $0.50 purchase from an approved seller");
{
  const id = `req_${randomUUID()}`;
  const d = await evaluate(id, "sportsfeed", 500_000, "Season injury summary");
  const pay = d.json.outcome === "allow" ? await call(AGENT, "POST", `/v1/payments/${id}/pay`, { url: `${SELLERS}/sportsfeed/season` }) : null;
  const rec = await record(id);
  check("A", "allow → paid → recorded", `decision ${d.json.outcome}; payment HTTP ${pay?.status ?? "-"}${pay?.status !== 200 ? ` (${pay?.json?.error ?? ""})` : ""}; ledger status ${rec?.status}${rec?.settlement ? ` (${rec.settlement.label ?? rec.settlement})` : ""}`, d.json.outcome === "allow" && pay?.status === 200 && rec?.status === "settled");
}

console.log("\nB. $5 purchase against a $3 task budget");
{
  const id = `req_${randomUUID()}`;
  const d = await evaluate(id, "sportsfeed", 5_000_000, "Full historical dataset", undefined, `${TASK}-b`);
  const pay = await call(AGENT, "POST", `/v1/payments/${id}/pay`, { url: `${SELLERS}/sportsfeed/injuries` });
  check("B", "block before signing", `decision ${d.json.outcome}: ${d.json.reason}; pay attempt HTTP ${pay.status}`, d.json.outcome === "block" && pay.status === 403);
}

console.log("\nC. Unapproved recipient");
{
  const id = `req_${randomUUID()}`;
  const d = await evaluate(id, "shadyapi", 20_000, "Data from an unapproved seller");
  const rec = await record(id);
  check("C", "block + audit log", `decision ${d.json.outcome}: ${d.json.reason}; audit log: ${rec ? `${rec.status} at ${rec.at}` : "missing"}`, d.json.outcome === "block" && rec?.status === "blocked");
}

console.log("\nD. Suspicious request (raw wallet address right after reading a seller's response)");
{
  const id = `req_${randomUUID()}`;
  const d = await evaluate(id, ATTACKER, 300_000, "license renewal", "after response from sportsfeed");
  const risk = await call(OWNER, "GET", `/v1/agents/${AGENT_ID}/anomalies?limit=20`);
  const mine = (risk.json.items ?? []).filter((i: any) => i.requestId === id);
  check("D", "anomaly flagged, reason visible to owner", `decision ${d.json.outcome}; owner sees ${mine.length} signal(s): ${mine.map((m: any) => `${m.type} (${m.severity})`).join(", ") || "none"}; agent's flags: ${(d.json.flags ?? []).length}`, mine.length > 0 && d.json.outcome !== "allow");
}

console.log("\nE. Emergency pause");
{
  const p = await call(OWNER, "POST", `/v1/agents/${AGENT_ID}/pause`, { reason: "Owner emergency stop (demo)" });
  const id = `req_${randomUUID()}`;
  const d = await evaluate(id, "sportsfeed", 20_000, "Injury report while paused");
  const selfResume = await call(AGENT, "POST", `/v1/agents/${AGENT_ID}/resume`, {});
  const ownerResume = await call(OWNER, "POST", `/v1/agents/${AGENT_ID}/resume`, {});
  check("E", "paused → request rejected → agent can't resume", `pause HTTP ${p.status}; request ${d.json.outcome}: ${d.json.reason}; agent resume HTTP ${selfResume.status}; owner resume HTTP ${ownerResume.status}`,
    p.status === 200 && d.json.outcome === "block" && selfResume.status === 403 && ownerResume.status === 200);
}

console.log("\nF. Payment optimizer (two of OUR demo sellers selling the same injury report)");
{
  const id = `req_${randomUUID()}`;
  const rec = await call(AGENT, "POST", "/v1/optimizer/recommend", { agentId: AGENT_ID, taskId: `${TASK}-f`, need: { category: "data", sku: "injury-report" }, maxAmountMicro: 1_000_000, requestId: id });
  for (const c of (rec.json.candidates ?? []).filter((c: any) => c.compatible)) console.log(`    ${c.name.padEnd(20)} ${c.quote ? usd(c.quote.amountMicro) : "—"}  ${c.reason}`);
  const best = rec.json.recommended;
  let paid = false;
  if (best) {
    const d = await evaluate(id, best.recipient, best.amountMicro, "Injury report (optimizer)", undefined, `${TASK}-f`);
    const pay = d.json.outcome === "allow" ? await call(AGENT, "POST", `/v1/payments/${id}/pay`, { url: SELLERS + best.path }) : null;
    paid = pay?.status === 200;
  }
  const hist = await call(OWNER, "GET", `/v1/optimizer/recommendations?agentId=${AGENT_ID}`);
  const mine = (hist.json.items ?? []).find((i: any) => i.requestId === id);
  check("F", "cheapest eligible provider, routed, saving realized only after settlement",
    `recommended ${best?.providerId ?? "none"} at ${best ? usd(best.amountMicro) : "-"}; estimated ${rec.json.estimatedSavingsMicro != null ? usd(rec.json.estimatedSavingsMicro) : "none"}; paid: ${paid}; realized ${mine?.realizedSavingsMicro != null ? usd(mine.realizedSavingsMicro) : "none"} (${mine?.status})`,
    best?.providerId === "sportsfeed" && paid && mine?.realizedSavingsMicro === 30_000);
}

console.log();
console.table(results);
console.log(`Open http://localhost:3000 → agent "${AGENT_ID}" to see every decision, the risk panel and the price check.`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
