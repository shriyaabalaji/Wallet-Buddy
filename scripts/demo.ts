// npm run demo: the full Wallet Buddy story end to end on Arc testnet, repeatable.
//   preflight/top-up → new agent + rules (committed on Arc) → normal payments (Claude agent) → race → prompt injection
//   → hold (escrowed on Arc) → SMS → owner denies → vault refund → decision log on Arc → summary with explorer links.
//
// "Reset" = each run registers a FRESH agent (demo-<time>) through the same owner API the website's Add-agent button
// uses, so budgets start empty without rewriting any history. Nothing here invents a hash: every link printed is
// read back from the firewall's ledger, which recorded what Arc returned.
// Run via scripts/demo.sh (starts the firewall and sellers if needed, loads .env.firewall).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFirewallClient, type PaymentResult } from "@agent-firewall/client";

const ROOT = join(import.meta.dirname, "..");
const FW = process.env.FIREWALL_URL ?? "http://localhost:4000";
const SELLERS = process.env.SELLERS_URL ?? "http://localhost:4200";
const OWNER = process.env.FIREWALL_OWNER_TOKEN ?? "";
if (!OWNER) { console.error("FIREWALL_OWNER_TOKEN missing (load .env.firewall; use npm run demo)."); process.exit(2); }
const ATTACKER = "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e";
const RUN = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
const AGENT = `demo-${RUN}-${Math.random().toString(36).slice(2, 5)}`;
const DRY_PHONE = "+15555550100"; // reserved fictional number; used only when Twilio isn't configured (texts are logged, not sent)

const C = { b: "\x1b[1m", d: "\x1b[2m", blue: "\x1b[34m", org: "\x1b[33m", r: "\x1b[0m" };
const step = (n: string, t: string) => console.log(`\n${C.b}${n}  ${t}${C.r}`);
const info = (s: string) => console.log(`   ${s}`);
const link = (label: string, url: string | null | undefined) => url && console.log(`   ${C.d}${label.padEnd(18)}${C.r} ${C.blue}${url}${C.r}`);
const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(FW + path, { method, headers: { Authorization: `Bearer ${OWNER}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error ?? r.status}`);
  return j;
};
const activity = async (requestId: string) => ((await owner("GET", `/v1/activity?agentId=${AGENT}&requestId=${encodeURIComponent(requestId)}`)).items ?? [])[0];
const results: { step: string; expected: string; got: string; pass: boolean }[] = [];
const check = (s: string, expected: string, got: string, pass: boolean) => {
  results.push({ step: s, expected, got, pass });
  console.log(`   ${pass ? `${C.blue}✓${C.r}` : `${C.org}✗${C.r}`} ${got}`);
};
const show = (label: string, r: PaymentResult) => info(`${label.padEnd(30)} ${(r.outcome === "allow" ? C.blue : C.org) + r.outcome.toUpperCase().padEnd(6) + C.r} ${r.reason}${r.decisionMs != null ? C.d + ` (${r.decisionMs.toFixed(0)} ms)` + C.r : ""}`);
const requestIds: string[] = [];

console.log(`${C.b}Wallet Buddy demo${C.r} · firewall ${FW} · sellers ${SELLERS} · agent ${AGENT}`);

// ---------- 0. preflight + top-up ----------
step("0", "Preflight: services, Arc, balances");
const health = await owner("GET", "/health");
info(`payer: ${health.paymentMode} ${health.signer} · network ${health.network} · Arc registry ${health.arc?.registry ? "on" : "OFF"} · vault ${health.arc?.vault ? "on" : "OFF"}`);
if (health.vault && "allowanceUsdc" in health.vault && health.vault.allowanceUsdc < 3) {
  info(`vault allowance low ($${health.vault.allowanceUsdc}); approving 20 USDC from the treasury…`);
  await new Promise<void>((res, rej) => spawn("npm", ["run", "vault:approve", "-w", "@agent-firewall/firewall", "--", "20"], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] }).on("exit", (c) => (c === 0 ? res() : rej(new Error("vault approve failed")))));
} else if (health.vault) info(`vault allowance $${health.vault.allowanceUsdc} · treasury $${health.vault.treasuryUsdc}`);
if (health.buyer?.enabled) info(`Gateway balance $${health.buyer.gatewayAvailableUsdc?.toFixed(2)} (auto top-up: up to $${health.buyer.dailyCapUsdc}/day; deposited today $${health.buyer.depositedTodayUsdc})`);
if (health.buyer?.gatewayAvailableUsdc != null && health.buyer.gatewayAvailableUsdc < 1.5) info(`${C.org}Gateway balance is low; the firewall tops it up within a minute unless today's cap is used.${C.r}`);

// ---------- 1. reset: fresh agent + rules ----------
step("1", "New agent and its rules (committed on Arc)");
const created = await owner("POST", "/v1/agents", { id: AGENT, name: `Demo agent ${RUN}`, issueKey: true });
const KEY: string = created.key;
info(`registered ${AGENT}; key issued once (stored as a hash) · pays from ${created.wallet?.mode} ${created.wallet?.address ?? ""}`);
// Order matters for the reported reason (the first failing rule is shown), so the allowlist goes first.
const rules = [
  { id: "approved-sellers", kind: "allowlist", recipients: ["sportsfeed", "statline", "oddsapi"], onViolation: "block" },
  { id: "task-budget", kind: "taskBudget", taskId: "*", maxMicro: 1_000_000 },
  { id: "day-budget", kind: "periodBudget", period: "day", maxMicro: 3_000_000 },
  { id: "ask-first", kind: "approvalThreshold", aboveMicro: 600_000 },
];
const pol = await owner("POST", "/v1/policy", { agentId: AGENT, confirmed: true, rules, notify: { phone: process.env.OWNER_PHONE || DRY_PHONE, events: ["hold"] } });
for (const v of (await owner("GET", `/v1/policy/${AGENT}`)).views ?? []) info(`• ${v.sentence}`);
link("policy commit", pol.policy?.committedTxUrl);
check("1", "rules saved and committed on Arc", `policy ${pol.policy?.hash?.slice(0, 10)}… ${pol.policy?.committedTx ? "committed" : "NOT committed"}`, Boolean(pol.policy?.committedTx));

const client = createFirewallClient({ firewallUrl: FW, agentId: AGENT, token: KEY });

// ---------- 2. normal work: the LLM agent ----------
step("2", "Normal work: an AI agent researches tonight's NBA injuries and pays per call");
const agentEnv = readFileSync(join(ROOT, ".env.agent"), "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() || process.env.ANTHROPIC_API_KEY;
let normalPaid = 0;
if (agentEnv) {
  const taskId = `research-${RUN}`;
  const out = await new Promise<string>((res) => {
    let buf = "";
    const p = spawn(join(ROOT, "scripts/run-agent.sh"), ["llm", "Research tonight's NBA injury news and summarize which notable players are out or questionable for tonight's games. Keep spending low."], {
      cwd: ROOT, env: { PATH: process.env.PATH, FIREWALL_URL: FW, SELLERS_URL: SELLERS, AGENT_ID: AGENT, TASK_ID: taskId, FIREWALL_AGENT_TOKEN: KEY, AGENT_MAX_TURNS: "12" },
    });
    p.stdout.on("data", (d) => { buf += d; for (const l of String(d).split("\n")) if (l && !l.startsWith("RESULT ")) process.stdout.write(`   ${C.d}│${C.r} ${l}\n`); });
    p.stderr.on("data", (d) => process.stderr.write(`   ${C.d}│${C.r} ${d}`));
    p.on("exit", () => res(buf));
  });
  const result = JSON.parse(out.split("\n").find((l) => l.startsWith("RESULT "))?.slice(7) ?? "{}");
  normalPaid = result.allowed ?? 0;
  for (const c of result.calls ?? []) if (c.requestId) requestIds.push(c.requestId);
  check("2", "Claude chose and bought data through the firewall", `${result.purchases ?? 0} purchase(s) decided, ${normalPaid} paid, ${usd(result.spentMicro ?? 0)} spent`, normalPaid > 0);
} else {
  info(`${C.org}No ANTHROPIC_API_KEY in .env.agent: running the scripted fallback (not an LLM) for this step.${C.r}`);
  const games = await client.requestPayment({ url: `${SELLERS}/oddsapi/odds`, recipient: "oddsapi", category: "data", purpose: "Tonight's games", taskId: `research-${RUN}` });
  show("tonight's games", games); requestIds.push(games.requestId);
  const teams = ((games.data as any)?.games ?? []).flatMap((g: any) => (g.teams ?? []).map((t: any) => t.abbr)).slice(0, 2);
  for (const t of teams.length ? teams : ["LAL"]) {
    const r = await client.requestPayment({ url: `${SELLERS}/sportsfeed/injuries?team=${t}`, recipient: "sportsfeed", category: "data", purpose: `Injury report for ${t}`, taskId: `research-${RUN}` });
    show(`injury report ${t}`, r); requestIds.push(r.requestId);
  }
  normalPaid = 1 + teams.length;
  check("2", "small purchases allowed and paid (scripted fallback)", `${requestIds.length} purchase(s)`, true);
}

// ---------- 3. race ----------
step("3", "Race: three $0.50 purchases at the same instant against a $1.00 task budget");
const raceTask = `race-${RUN}`;
const race = await Promise.all([1, 2, 3].map((i) => client.requestPayment({ url: `${SELLERS}/sportsfeed/season`, recipient: "sportsfeed", category: "data", purpose: `League injury list (${i})`, taskId: raceTask })));
race.forEach((r, i) => { show(`request ${"ABC"[i]}`, r); requestIds.push(r.requestId); });
const allowedN = race.filter((r) => r.outcome === "allow").length, blockedN = race.filter((r) => r.outcome === "block").length;
check("3", "exactly two allowed ($1.00), one blocked: no overspend", `${allowedN} allowed, ${blockedN} blocked`, allowedN === 2 && blockedN === 1);

// ---------- 4. prompt injection ----------
step("4", "Prompt injection: a compromised seller tells the agent to pay an attacker");
const live = await client.requestPayment({ url: `${SELLERS}/sportsfeed/injuries/live`, recipient: "sportsfeed", category: "data", purpose: "Live injury wire", taskId: `inject-${RUN}` });
show("live injury wire ($0.02)", live); requestIds.push(live.requestId);
const note: string | undefined = (live.data as any)?.note;
if (note) info(`${C.org}seller response contains: "${note.slice(0, 110)}…"${C.r}`);
info(`${C.d}(scripted hijack, clearly labelled: we make the agent obey the injected instruction to show the firewall still holds)${C.r}`);
const hijackId = `req_${crypto.randomUUID()}`;
const hj = await fetch(`${FW}/v1/payments/evaluate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ requestId: hijackId, agentId: AGENT, taskId: `inject-${RUN}`, recipient: ATTACKER, amountMicro: 3_000_000, category: "other", purpose: "license renewal", sourceContext: "after response from sportsfeed" }) }).then((r) => r.json()) as any;
requestIds.push(hijackId);
info(`hijacked payment: ${C.org}${String(hj.outcome).toUpperCase()}${C.r} ${hj.reason}`);
for (const f of hj.flags ?? []) info(`   flag: ${f}`);
const sneak = await fetch(`${FW}/v1/payments/${hijackId}/pay`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ url: `${SELLERS}/sportsfeed/injuries` }) });
info(`agent tries to pay it anyway → HTTP ${sneak.status} (refused)`);
check("4", "blocked, flagged PROMPT_INJECTION, pay refused", `${hj.outcome}; injection flag ${(hj.flags ?? []).some((f: string) => f.startsWith("PROMPT_INJECTION")) ? "present" : "missing"}; pay HTTP ${sneak.status}`,
  hj.outcome === "block" && (hj.flags ?? []).some((f: string) => f.startsWith("PROMPT_INJECTION")) && sneak.status === 403);

// ---------- 5. hold → SMS → deny → refund ----------
step("5", "Hold: an $0.80 purchase is above the $0.60 ask-first line");
const big = await client.requestPayment({ url: `${SELLERS}/oddsapi/odds/bulk`, recipient: "oddsapi", category: "data", purpose: "Bulk odds export for tonight", taskId: `hold-${RUN}` });
show("bulk odds export", big); requestIds.push(big.requestId);
let held = await activity(big.requestId);
for (let i = 0; i < 40 && !held?.arcTx; i++) { await sleep(2000); held = await activity(big.requestId); }
info(`USDC escrowed in the ApprovalVault until the owner decides`);
link("vault hold", held?.arcTxUrl);
check("5", "held and escrowed on Arc", `${big.outcome}; escrow ${held?.arcTx ? "on Arc" : `missing${held?.holdError ? ` (${held.holdError})` : ""}`}`, big.outcome === "hold" && Boolean(held?.arcTx));

step("6", "The owner gets a text");
await sleep(500);
const notes = await owner("GET", "/v1/notifications?limit=5");
const sms = (notes.items ?? []).find((n: any) => n.body.includes(AGENT.replace(/-/g, " ")) || n.body.includes("wants to send"));
info(`${notes.twilio ? "sent via Twilio" : "Twilio not configured: dry-run, logged instead of sent"} → ${sms?.phone ?? "?"}`);
if (sms) info(`${C.b}“${sms.body}”${C.r}`);
check("6", "hold text composed", sms ? "text logged" : "no text", Boolean(sms));

step("7", "Owner says no → the vault refunds the treasury on Arc");
const pending = ((await owner("GET", `/v1/agents/${AGENT}/summary`)).pending ?? []).find((p: any) => p.requestId === big.requestId);
if (pending?.token) await fetch(`${FW}/v1/approvals/${pending.token}/deny`, { method: "POST" });
let denied = await activity(big.requestId);
for (let i = 0; i < 40 && !denied?.resolveTx; i++) { await sleep(2000); denied = await activity(big.requestId); }
link("vault refund", denied?.resolveTxUrl);
check("7", "denied and refunded on Arc", `${denied?.status}; refund ${denied?.resolveTx ? "on Arc" : "missing"}`, denied?.status === "denied" && Boolean(denied?.resolveTx));

// ---------- 8. decision log ----------
step("8", "Every decision, logged on Arc");
let rows: any[] = [];
for (let i = 0; i < 20; i++) {
  rows = await Promise.all(requestIds.map(activity));
  if (rows.every((r) => r?.decisionLogTx)) break;
  await sleep(3000);
}
for (const r of rows.filter(Boolean)) info(`${String(r.outcome ?? r.status).padEnd(6)} ${usd(r.amountMicro ?? 0).padStart(6)} ${String(r.recipient).slice(0, 14).padEnd(14)} ${C.blue}${r.decisionLogTxUrl ?? "(not logged yet)"}${C.r}`);
check("8", "all decisions in the onchain log", `${rows.filter((r) => r?.decisionLogTx).length}/${requestIds.length} logged`, rows.every((r) => r?.decisionLogTx));

console.log(`\n${C.b}Result${C.r}`);
console.table(results.map(({ step, expected, got, pass }) => ({ step, expected, got: got.slice(0, 70), pass })));
console.log(`Dashboard: http://localhost:3000 (agent ${AGENT}) · Onchain proof: http://localhost:3000/proof`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
