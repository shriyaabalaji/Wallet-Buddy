// Property test: random rule sets × random concurrent request streams never overspend.
//
// For each seed we generate a rule set (perTxLimit, taskBudget "*" and/or named, periodBudget day/week/month, plus
// sometimes approvalThreshold/allowlist so holds also reserve budget) and a stream of requests over a few tasks, with
// boundary-hitting amounts, duplicate requestIds, and some allowed payments later settled or failed (failed+unsigned
// = released, so budget comes back mid-stream). The stream is fired:
//   (a) in-process, all at once with Promise.all against the real HTTP app;
//   (b) across 4 OS processes, each with its own SQLite connection to the same file (see property-worker.ts).
// Invariants checked on the ledger afterwards, per seed:
//   - for every taskBudget / periodBudget rule, the sum of counted spend (SPENDING_STATUSES) is ≤ its maxMicro
//   - every allowed request satisfies every perTxLimit individually
//   - one ledger row per requestId, and every replay of an id got the same outcome as the stored row
//   - a non-allow decision names a rule in the policy
// On failure the offending seeds are printed; rerun just those with PROP_SEEDS=3,17 npm test -w @agent-firewall/firewall.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { periodStart, policyHash, type Rule } from "@agent-firewall/policy";
import { openDb, SPENDING_STATUSES, type DB } from "../src/db";
import { savePolicy } from "../src/engine";

const SEEDS: number[] = process.env.PROP_SEEDS
  ? process.env.PROP_SEEDS.split(",").map((s) => Number(s.trim())).filter(Number.isInteger)
  : Array.from({ length: 25 }, (_, i) => i + 1);
const WORKERS = 4;
const TASKS = ["t0", "t1", "t2", "t3"];
const RECIPIENTS = ["sportsfeed", "statline", "sportsfeed", "statline", "unknown.x402"];

/** mulberry32: tiny deterministic PRNG, good enough for test-case generation. */
function prng(seed: number) {
  let a = (seed * 0x9e3779b1) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int, chance: (p: number) => next() < p, pick: <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)]! };
}

interface GenReq { id: string; taskId: string; amountMicro: number; recipient: string; worker: number; after: "settle" | "fail" | null }
interface Case { seed: number; rules: Rule[]; requests: GenReq[] }

function genCase(seed: number, prefix: string): Case {
  const r = prng(seed);
  const rules: Rule[] = [];
  if (r.chance(0.8)) rules.push({ id: "ptx", kind: "perTxLimit", maxMicro: r.int(50_000, 600_000), ...(r.chance(0.2) ? { onViolation: "hold" as const } : {}) });
  if (r.chance(0.9)) rules.push({ id: "task-all", kind: "taskBudget", taskId: "*", maxMicro: r.int(200_000, 2_000_000) });
  if (r.chance(0.4)) rules.push({ id: "task-t0", kind: "taskBudget", taskId: "t0", maxMicro: r.int(50_000, 800_000) });
  if (r.chance(0.8)) rules.push({ id: "day", kind: "periodBudget", period: "day", maxMicro: r.int(300_000, 4_000_000) });
  if (r.chance(0.6)) rules.push({ id: "week", kind: "periodBudget", period: "week", maxMicro: r.int(300_000, 4_000_000) });
  if (r.chance(0.3)) rules.push({ id: "month", kind: "periodBudget", period: "month", maxMicro: r.int(300_000, 4_000_000) });
  if (!rules.some((x) => x.kind === "taskBudget" || x.kind === "periodBudget")) rules.push({ id: "day", kind: "periodBudget", period: "day", maxMicro: r.int(300_000, 4_000_000) });
  if (r.chance(0.3)) rules.push({ id: "ask", kind: "approvalThreshold", aboveMicro: r.int(100_000, 500_000) });
  if (r.chance(0.3)) rules.push({ id: "al", kind: "allowlist", recipients: ["sportsfeed", "statline"] });

  const caps = rules.flatMap((x) => ("maxMicro" in x ? [x.maxMicro] : []));
  const requests: GenReq[] = [];
  const n = r.int(32, 48);
  for (let i = 0; i < n; i++) {
    // Replay an earlier request verbatim (same id, same body) from a possibly different worker.
    if (i > 0 && r.chance(0.06)) {
      requests.push({ ...r.pick(requests), worker: r.int(0, WORKERS - 1), after: null });
      continue;
    }
    const roll = r.next();
    const amountMicro =
      roll < 0.25 ? Math.max(1, Math.floor(r.pick(caps) / r.int(1, 6))) // lands exactly on a cap or a fraction of one
      : roll < 0.45 ? r.int(1, 20_000)
      : r.int(1, 400_000);
    const after = r.chance(0.3) ? "settle" : r.chance(0.2) ? "fail" : null;
    requests.push({ id: `${prefix}-${seed}-${i}`, taskId: r.pick(TASKS), amountMicro, recipient: r.pick(RECIPIENTS), worker: r.int(0, WORKERS - 1), after });
  }
  return { seed, rules, requests };
}

const agentFor = (prefix: string, seed: number) => `${prefix}-agent-${seed}`;

/** Returns human-readable invariant violations (empty = ok). */
function checkInvariants(db: DB, agentId: string, rules: Rule[], observed: Map<string, string[]>): string[] {
  const rows = db.prepare("SELECT request_id, task_id, amount_micro, outcome, status, rule_id, created_ms FROM requests WHERE agent_id=?").all(agentId) as {
    request_id: string; task_id: string; amount_micro: number; outcome: string; status: string; rule_id: string | null; created_ms: number;
  }[];
  const bad: string[] = [];
  const counted = rows.filter((x) => (SPENDING_STATUSES as readonly string[]).includes(x.status));
  const sum = (xs: typeof rows) => xs.reduce((a, x) => a + Number(x.amount_micro), 0);
  const now = new Date();
  for (const rule of rules) {
    if (rule.kind === "taskBudget") {
      const tasks = rule.taskId === "*" ? [...new Set(rows.map((x) => x.task_id))] : [rule.taskId];
      for (const t of tasks) {
        const s = sum(counted.filter((x) => x.task_id === t));
        if (s > rule.maxMicro) bad.push(`${rule.id}: task ${t} counted ${s} > max ${rule.maxMicro}`);
      }
    } else if (rule.kind === "periodBudget") {
      const s = sum(counted.filter((x) => x.created_ms >= periodStart(rule.period, now).getTime()));
      if (s > rule.maxMicro) bad.push(`${rule.id}: ${rule.period} counted ${s} > max ${rule.maxMicro}`);
    }
  }
  for (const x of rows.filter((x) => x.outcome === "allow")) {
    for (const rule of rules) if (rule.kind === "perTxLimit" && x.amount_micro > rule.maxMicro) bad.push(`${x.request_id}: allowed ${x.amount_micro} > perTx ${rule.maxMicro}`);
  }
  const ids = new Set(rules.map((x) => x.id));
  for (const x of rows) if (x.outcome !== "allow" && !ids.has(x.rule_id ?? "")) bad.push(`${x.request_id}: ${x.outcome} by unknown rule ${x.rule_id}`);
  const byId = new Map(rows.map((x) => [x.request_id, x]));
  if (byId.size !== rows.length) bad.push(`duplicate ledger rows: ${rows.length} rows for ${byId.size} ids`);
  for (const [id, outs] of observed) {
    const row = byId.get(id);
    if (!row) bad.push(`${id}: no ledger row`);
    else if (outs.some((o) => o !== row.outcome)) bad.push(`${id}: replies ${outs.join("/")} vs ledger ${row.outcome}`);
  }
  return bad;
}

const stats = (db: DB, prefix: string) =>
  db.prepare("SELECT outcome, COUNT(*) n FROM requests WHERE agent_id LIKE ? GROUP BY outcome").all(`${prefix}-agent-%`) as { outcome: string; n: number }[];
const budgetBlocks = (db: DB, prefix: string) =>
  Number((db.prepare("SELECT COUNT(*) n FROM requests WHERE agent_id LIKE ? AND outcome='block' AND rule_id IN ('task-all','task-t0','day','week','month')").get(`${prefix}-agent-%`) as any).n);

function report(mode: string, failures: { seed: number; bad: string[] }[]) {
  if (!failures.length) return;
  const msg = failures.map((f) => `seed ${f.seed} (${mode}):\n  ${f.bad.slice(0, 10).join("\n  ")}`).join("\n");
  console.error(`[budget-property] FAILING SEEDS (${mode}): ${failures.map((f) => f.seed).join(",")}\n${msg}\nRerun with PROP_SEEDS=${failures.map((f) => f.seed).join(",")}`);
}

let dir: string;
let db: DB;
let dbPath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "budget-prop-"));
  dbPath = join(dir, "p.db");
  db = openDb(dbPath);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("budget property", () => {
  it("the invariant checker catches a planted overspend (not vacuous)", () => {
    const rules: Rule[] = [{ id: "ptx", kind: "perTxLimit", maxMicro: 100 }, { id: "task-all", kind: "taskBudget", taskId: "*", maxMicro: 1_000 }, { id: "day", kind: "periodBudget", period: "day", maxMicro: 1_500 }];
    savePolicy(db, "planted", rules, policyHash(rules));
    const ins = db.prepare("INSERT INTO requests (request_id, agent_id, task_id, recipient, amount_micro, category, purpose, outcome, status, reason, created_at, created_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const t = Date.now();
    ins.run("p1", "planted", "x", "s", 900, "data", "", "allow", "settled", "", new Date(t).toISOString(), t);
    ins.run("p2", "planted", "x", "s", 900, "data", "", "allow", "reserved", "", new Date(t).toISOString(), t);
    ins.run("p3", "planted", "y", "s", 5_000, "data", "", "allow", "released", "", new Date(t).toISOString(), t); // released: not counted
    const bad = checkInvariants(db, "planted", rules, new Map([["p1", ["block"]]]));
    expect(bad.some((b) => b.startsWith("task-all: task x counted 1800"))).toBe(true);
    expect(bad.some((b) => b.startsWith("day: day counted 1800"))).toBe(true);
    expect(bad.some((b) => b.includes("allowed 900 > perTx 100"))).toBe(true);
    expect(bad.some((b) => b.includes("p1: replies block vs ledger allow"))).toBe(true);
    expect(bad.some((b) => b.includes("task y"))).toBe(false);
  });

  it(`in-process: ${SEEDS.length} seeds, each stream fired at once with Promise.all over HTTP`, async () => {
    const { createApp } = await import("../src/server");
    const { loadAuth } = await import("../src/auth");
    const tokens = new Map(SEEDS.map((s) => [agentFor("http", s), randomBytes(32).toString("base64url")]));
    // Outcome reports go through the service token: agents may not self-report in circle-agent-wallet mode (the default).
    const SERVICE = randomBytes(32).toString("base64url");
    const server = createApp(db, loadAuth({ FIREWALL_AGENT_TOKENS: [...tokens].map(([a, t]) => `${a}=${t}`).join(","), FIREWALL_SERVICE_TOKEN: SERVICE }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, token: string, body: unknown) => {
      const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const json = (await res.json()) as any;
      if (res.status !== 200) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
      return json;
    };
    const failures: { seed: number; bad: string[] }[] = [];
    try {
      for (const seed of SEEDS) {
        const c = genCase(seed, "http");
        const agentId = agentFor("http", seed);
        const token = tokens.get(agentId)!;
        savePolicy(db, agentId, c.rules, policyHash(c.rules));
        const observed = new Map<string, string[]>();
        await Promise.all(
          c.requests.map(async (q) => {
            const d = await post("/v1/payments/evaluate", token, { requestId: q.id, agentId, taskId: q.taskId, recipient: q.recipient, amountMicro: q.amountMicro, category: "data", purpose: "property" });
            observed.set(q.id, [...(observed.get(q.id) ?? []), d.outcome]);
            if (d.outcome === "allow" && !d.duplicate && q.after) await post(`/v1/payments/${q.id}/${q.after === "settle" ? "settled" : "failed"}`, SERVICE, {});
          }),
        );
        const bad = checkInvariants(db, agentId, c.rules, observed);
        if (bad.length) failures.push({ seed, bad });
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    report("http", failures);
    expect(failures.map((f) => f.seed), "failing seeds (see stderr for details)").toEqual([]);
    const s = stats(db, "http");
    console.log(`[budget-property] http: ${JSON.stringify(s)}, budget blocks ${budgetBlocks(db, "http")}`);
    expect(s.find((x) => x.outcome === "allow")?.n ?? 0).toBeGreaterThan(0);
    if (SEEDS.length >= 10) expect(budgetBlocks(db, "http")).toBeGreaterThan(0); // the budgets were actually contended
  }, 60_000);

  it(`multi-process: ${SEEDS.length} seeds across ${WORKERS} OS processes on one SQLite file`, async () => {
    const cases = SEEDS.map((seed) => genCase(seed, "proc"));
    for (const c of cases) savePolicy(db, agentFor("proc", c.seed), c.rules, policyHash(c.rules));
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, JSON.stringify(cases.map((c) => ({ agentId: agentFor("proc", c.seed), requests: c.requests }))));
    const worker = join(import.meta.dirname, "property-worker.ts");
    const run = promisify(execFile);
    const startAt = Date.now() + 2500;
    const outs = (
      await Promise.all(Array.from({ length: WORKERS }, (_, i) => run(process.execPath, ["--import", "tsx", worker, dbPath, specPath, String(i), String(startAt)], { maxBuffer: 16 * 1024 * 1024 })))
    ).flatMap((o) => JSON.parse(o.stdout) as { id: string; outcome: string }[]);
    expect(outs).toHaveLength(cases.reduce((a, c) => a + c.requests.length, 0));

    const observed = new Map<string, string[]>();
    for (const o of outs) observed.set(o.id, [...(observed.get(o.id) ?? []), o.outcome]);
    const failures: { seed: number; bad: string[] }[] = [];
    for (const c of cases) {
      const mine = new Map([...observed].filter(([id]) => id.startsWith(`proc-${c.seed}-`)));
      const bad = checkInvariants(db, agentFor("proc", c.seed), c.rules, mine);
      if (bad.length) failures.push({ seed: c.seed, bad });
    }
    report("multi-process", failures);
    expect(failures.map((f) => f.seed), "failing seeds (see stderr for details)").toEqual([]);
    console.log(`[budget-property] multi-process: ${JSON.stringify(stats(db, "proc"))}, budget blocks ${budgetBlocks(db, "proc")}`);
    expect(stats(db, "proc").find((x) => x.outcome === "allow")?.n ?? 0).toBeGreaterThan(0);
    if (SEEDS.length >= 10) expect(budgetBlocks(db, "proc")).toBeGreaterThan(0);
  }, 60_000);
});
