// Live stress checks against a running firewall (no money moves: nothing here is signed or settled).
//   FIREWALL_OWNER_TOKEN=… FIREWALL_AGENT_TOKEN=… [FIREWALL_SERVICE_TOKEN=…] npx tsx scripts/stress-api.ts   (FIREWALL_URL defaults to http://localhost:4000)
//   FIREWALL_AGENT_TOKEN must be the token for STRESS_AGENT_ID (default "stress-agent") in the firewall's FIREWALL_AGENT_TOKENS.
// Works in both payment modes (GET /v1/signer says which). Each check passes, fails, or is SKIPped with the reason.
// 1. Race: 20 concurrent $0.80 requests with $1.00 of task budget -> exactly 1 allowed, never over budget.
// 2. Idempotency: the same requestId evaluated 10x concurrently -> one reservation (its own task).
// 3. Failure before signing releases the reservation. local-key: the agent reports it. circle-agent-wallet: the firewall
//    records outcomes itself and refuses agent reports, so this needs FIREWALL_SERVICE_TOKEN (else SKIP).
// 4. Paying/signing a blocked request is refused (SKIP when the payer isn't configured, so the status check isn't reached).
// 5. Emergency pause: a reservation made before the pause can't be paid/signed until the owner resumes.
import { randomUUID } from "node:crypto";

const FW = process.env.FIREWALL_URL ?? "http://localhost:4000";
const SELLERS = process.env.SELLERS_URL ?? "http://localhost:4200";
const bearer = (t: string | undefined): Record<string, string> => (t ? { Authorization: `Bearer ${t}` } : {});
const OWNER = bearer(process.env.FIREWALL_OWNER_TOKEN);
const AGENT = bearer(process.env.FIREWALL_AGENT_TOKEN);
const SERVICE = process.env.FIREWALL_SERVICE_TOKEN ? bearer(process.env.FIREWALL_SERVICE_TOKEN) : null;
const post = async (path: string, body: unknown, auth = AGENT) => {
  const r = await fetch(FW + path, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const get = async (path: string) => (await (await fetch(FW + path, { headers: OWNER })).json()) as any;

type Result = "PASS" | "FAIL" | "SKIP";
const results: { test: string; result: Result; detail: string }[] = [];
const check = (test: string, pass: boolean, detail: string) => results.push({ test, result: pass ? "PASS" : "FAIL", detail });
const skip = (test: string, detail: string) => results.push({ test, result: "SKIP", detail });

const { mode } = (await get("/v1/signer")) as { mode: "local-key" | "circle-agent-wallet" };
// A token is bound to one agent id, so the agent is fixed; a fresh task per check gives a full task budget.
const agentId = process.env.STRESS_AGENT_ID ?? "stress-agent";
const run = Date.now().toString(36);
const saved = await post("/v1/policy", {
  agentId, confirmed: true,
  rules: [{ id: "task-budget", kind: "taskBudget", taskId: "*", maxMicro: 1_000_000 }, { id: "approved-recipients", kind: "allowlist", recipients: ["oddsapi"] }],
}, OWNER);
if (saved.status !== 200) throw new Error(`Saving rules failed (HTTP ${saved.status}: ${saved.body.error}). Set FIREWALL_OWNER_TOKEN.`);
const req = (id: string, amountMicro: number, taskId: string) => ({ requestId: id, agentId, taskId, recipient: "oddsapi", amountMicro, category: "data", purpose: "stress" });
const taskSpent = async () => (await get(`/v1/agents/${agentId}/summary`)).task.spentMicro as number;
const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;
// What a payer call looks like in this mode. Neither reaches a seller for a blocked/paused request.
const payOrSign = (id: string) => (mode === "circle-agent-wallet" ? post(`/v1/payments/${id}/pay`, { url: `${SELLERS}/oddsapi/odds/bulk` }) : post(`/v1/payments/${id}/sign`, { typedData: {} }));

// 1. Race
const raceTask = `t-${run}-race`;
const ids = Array.from({ length: 20 }, () => `req_${randomUUID()}`);
const decisions = await Promise.all(ids.map((id) => post("/v1/payments/evaluate", req(id, 800_000, raceTask))));
const allowed = decisions.filter((d) => d.body.outcome === "allow");
const spent = await taskSpent();
check("Race: 20 × $0.80 vs $1.00 budget", allowed.length === 1 && spent <= 1_000_000, `${allowed.length} allowed, ${decisions.length - allowed.length} blocked, reserved ${usd(spent)}`);

// 3. Failure before signing releases the budget
const winner = ids[decisions.findIndex((d) => d.body.outcome === "allow")]!;
const reporter = mode === "circle-agent-wallet" ? SERVICE : AGENT;
if (!reporter) {
  skip("Failure (unsigned) releases reservation", "circle-agent-wallet: agents can't report outcomes; set FIREWALL_SERVICE_TOKEN to run this as the payment service");
} else {
  const failed = await post(`/v1/payments/${winner}/failed`, {}, reporter);
  const afterFail = await taskSpent();
  check("Failure (unsigned) releases reservation", failed.status === 200 && afterFail === 0, `reported as ${reporter === SERVICE ? "service" : "agent"}: HTTP ${failed.status}; reserved after failure: ${usd(afterFail)}`);
}

// 2. Idempotency: same requestId 10x concurrently
const dup = `req_${randomUUID()}`;
const dupRes = await Promise.all(Array.from({ length: 10 }, () => post("/v1/payments/evaluate", req(dup, 300_000, `t-${run}-dup`))));
const dupSpent = await taskSpent();
const sameOutcome = new Set(dupRes.map((d) => d.body.outcome)).size === 1;
check("Idempotency: same requestId × 10", dupSpent === 300_000 && sameOutcome, `reserved ${usd(dupSpent)} once; outcomes identical: ${sameOutcome}`);

// 4. Paying/signing a blocked request is refused, and refused because it's blocked.
const blockedId = ids[decisions.findIndex((d) => d.body.outcome === "block")]!;
const refused = await payOrSign(blockedId);
const byStatus = /only allowed payments/i.test(refused.body.error ?? "");
if (refused.status >= 400 && !byStatus) skip(`Payer (${mode}) refuses a blocked request`, `payer not configured, so the status check wasn't reached: HTTP ${refused.status}: ${refused.body.error}`);
else check(`Payer (${mode}) refuses a blocked request`, refused.status >= 400 && byStatus, `HTTP ${refused.status}: ${refused.body.error}`);

// 5. Emergency pause stops an already-reserved payment (checked before the payer, so it runs in both modes).
const pausedId = `req_${randomUUID()}`;
const pd = await post("/v1/payments/evaluate", req(pausedId, 10_000, `t-${run}-pause`));
await post(`/v1/agents/${agentId}/pause`, { reason: "stress-api pause check" }, OWNER);
let whilePaused: Awaited<ReturnType<typeof post>>;
try {
  whilePaused = await payOrSign(pausedId);
} finally {
  await post(`/v1/agents/${agentId}/resume`, {}, OWNER);
}
check("Pause blocks a reserved payment", pd.body.outcome === "allow" && whilePaused.status === 403 && /paused/i.test(whilePaused.body.error ?? ""), `evaluate: ${pd.body.outcome}; ${mode === "circle-agent-wallet" ? "/pay" : "/sign"} while paused: HTTP ${whilePaused.status}: ${whilePaused.body.error}`);
// The unused reservation is released by the firewall's reservation timeout (RESERVATION_TTL_MINUTES).

console.table(results);
process.exit(results.some((r) => r.result === "FAIL") ? 1 : 0);
