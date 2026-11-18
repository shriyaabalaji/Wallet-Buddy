// Anomaly detection over the real ledger (engine + anomaly.ts), with explicit clocks so windows are deterministic.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyHash, usdToMicro, type AnomalySignal, type AnomalyType, type Rule } from "@agent-firewall/policy";
import { openDb, type DB } from "../src/db";
import { evaluateAndReserve, markSettled, savePolicy } from "../src/engine";
import { ANOMALY_DEFAULTS, loadAnomalyConfig } from "../src/anomaly";

const run = promisify(execFile);
const ATTACKER = "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e";
const T0 = Date.parse("2026-11-18T15:00:00Z");
const MIN = 60_000;
let dir: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anom-"));
  dbPath = join(dir, "t.db");
  db = openDb(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const roomy: Rule[] = [
  { id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(1000) },
  { id: "daily", kind: "periodBudget", period: "day", maxMicro: usdToMicro(1000) },
  { id: "allow", kind: "allowlist", recipients: ["sportsfeed", "oddsapi"] },
];
const policy = (rules: Rule[], agentId = "a") => savePolicy(db, agentId, rules, policyHash(rules));

let seq = 0;
const ev = (amountUsd: number, at: number, o: { recipient?: string; agentId?: string; taskId?: string; purpose?: string; requestId?: string } = {}) =>
  evaluateAndReserve(
    db,
    {
      requestId: o.requestId ?? `r${++seq}`, agentId: o.agentId ?? "a", taskId: o.taskId ?? "t", recipient: o.recipient ?? "sportsfeed",
      amountMicro: usdToMicro(amountUsd), category: "data", purpose: o.purpose ?? `buy ${seq}`,
    },
    { now: new Date(at), anomaly: ANOMALY_DEFAULTS },
  );
const types = (a: AnomalySignal[]) => a.map((x) => x.type).sort();
const find = (a: AnomalySignal[], t: AnomalyType) => a.find((x) => x.type === t);
const stored = (id: string) => JSON.parse((db.prepare("SELECT anomalies_json j FROM requests WHERE request_id=?").get(id) as any).j) as AnomalySignal[];

/** n paid $amount purchases from sportsfeed, `gap` ms apart, ending before `end`. Distinct purposes (no duplicates). */
function history(n: number, amountUsd: number, end: number, gap = 3 * MIN, agentId = "a") {
  for (let i = 0; i < n; i++) {
    const r = ev(amountUsd, end - (n - i) * gap, { agentId, purpose: `report ${i}` });
    expect(r.decision.outcome).toBe("allow");
    markSettled(db, r.decision.requestId);
  }
}

describe("normal activity", () => {
  it("a typical purchase from a known seller raises nothing", () => {
    policy(roomy);
    history(10, 0.02, T0);
    const r = ev(0.03, T0);
    expect(r.decision.outcome).toBe("allow");
    expect(r.decision.anomalies).toEqual([]);
    expect(stored(r.decision.requestId)).toEqual([]);
  });
});

describe("AMOUNT_SPIKE", () => {
  it("medium at 5×+ the median, high at 20×+, nothing for small absolute jumps", () => {
    policy(roomy);
    history(10, 0.1, T0);
    expect(find(ev(0.3, T0).decision.anomalies, "AMOUNT_SPIKE")).toBeUndefined(); // 3×, and only +$0.20
    const med = find(ev(0.8, T0 + 1).decision.anomalies, "AMOUNT_SPIKE")!;
    expect(med).toMatchObject({ severity: "medium", measured: { medianMicro: 100_000, amountMicro: 800_000, ratioX100: 800, basis: "history" } });
    expect(med.explanation).toContain("8×");
    expect(find(ev(2.5, T0 + 2).decision.anomalies, "AMOUNT_SPIKE")).toMatchObject({ severity: "high", measured: { ratioX100: 2500 } });
  });

  it("an agent that usually spends a lot isn't flagged for its usual amount, only by the absolute threshold", () => {
    policy(roomy);
    history(10, 3, T0);
    const a = find(ev(3, T0).decision.anomalies, "AMOUNT_SPIKE")!;
    expect(a).toMatchObject({ severity: "medium", measured: { basis: "absolute" } });
  });
});

describe("insufficient history (documented fallbacks)", () => {
  it("uses only the absolute amount threshold, and NEW_RECIPIENT is low for a brand-new agent", () => {
    policy(roomy);
    const big = ev(2.5, T0);
    expect(find(big.decision.anomalies, "AMOUNT_SPIKE")).toMatchObject({ severity: "medium", measured: { basis: "absolute", sampleSize: 0 } });
    expect(find(big.decision.anomalies, "NEW_RECIPIENT")).toMatchObject({ severity: "low", measured: { onAllowlist: true } });
    expect(find(ev(1.5, T0 + 1).decision.anomalies, "AMOUNT_SPIKE")).toBeUndefined();
    // Four paid requests is still below MIN_HISTORY: no relative spike, even at 100×.
    policy(roomy, "b");
    history(4, 0.01, T0, 3 * MIN, "b");
    expect(find(ev(1, T0, { agentId: "b" }).decision.anomalies, "AMOUNT_SPIKE")).toBeUndefined();
  });

  it("a raw wallet address is high even with no history", () => {
    policy(roomy);
    expect(find(ev(0.5, T0, { recipient: ATTACKER }).decision.anomalies, "NEW_RECIPIENT")).toMatchObject({ severity: "high", measured: { rawAddress: true, onAllowlist: false } });
  });
});

describe("FREQUENCY_SPIKE", () => {
  it("absolute fallback: flags from the 10th request in a minute, high from the 20th", () => {
    policy(roomy);
    const out = Array.from({ length: 20 }, (_, i) => find(ev(0.01, T0 + i * 1000).decision.anomalies, "FREQUENCY_SPIKE"));
    expect(out.slice(0, 9).every((x) => x === undefined)).toBe(true);
    expect(out[9]).toMatchObject({ severity: "medium", measured: { requestsInWindow: 10, basis: "absolute" } });
    expect(out[19]).toMatchObject({ severity: "high", measured: { requestsInWindow: 20 } });
  });

  it("relative to history: a busy agent's normal pace is not a spike, a quiet agent's burst is", () => {
    policy(roomy, "busy");
    for (let i = 0; i < 60 * 15; i++) ev(0.01, T0 - 61 * MIN + i * 4000, { agentId: "busy" }); // 15/min for an hour
    const burst = Array.from({ length: 12 }, (_, i) => ev(0.01, T0 + i * 1000, { agentId: "busy" }).decision.anomalies);
    expect(burst.every((a) => !find(a, "FREQUENCY_SPIKE"))).toBe(true);

    policy(roomy, "quiet");
    for (let i = 0; i < 60; i++) ev(0.01, T0 - 61 * MIN + i * MIN, { agentId: "quiet" }); // 1/min
    const q = Array.from({ length: 12 }, (_, i) => find(ev(0.01, T0 + i * 1000, { agentId: "quiet" }).decision.anomalies, "FREQUENCY_SPIKE"));
    // Lookback for the 10th burst request is (T0+9s−61min, T0+9s−1min]: 59 of the 60 history rows → 0.98/min.
    expect(q[9]).toMatchObject({ measured: { requestsInWindow: 10, basis: "history", lookbackRequests: 59, usualPerWindowX100: 98 } });
    expect(q.slice(0, 9).every((x) => x === undefined)).toBe(true);
  });
});

describe("NEW_RECIPIENT", () => {
  it("low for an approved seller, medium otherwise; the allowlist still holds the unapproved one", () => {
    policy(roomy);
    history(6, 0.02, T0);
    expect(find(ev(0.02, T0).decision.anomalies, "NEW_RECIPIENT")).toBeUndefined(); // paid before
    expect(find(ev(0.02, T0 + 1, { recipient: "oddsapi" }).decision.anomalies, "NEW_RECIPIENT")).toMatchObject({ severity: "low", measured: { onAllowlist: true } });
    const shady = ev(0.02, T0 + 2, { recipient: "shadyapi" });
    expect(find(shady.decision.anomalies, "NEW_RECIPIENT")).toMatchObject({ severity: "medium", measured: { onAllowlist: false } });
    expect(shady.decision.outcome).toBe("hold"); // unchanged: the allowlist rule decides, not the anomaly
    expect(shady.decision.ruleId).toBe("allow");
  });

  it("a held (not yet paid) request doesn't make the recipient 'known'", () => {
    policy(roomy);
    expect(ev(0.02, T0, { recipient: "shadyapi" }).decision.outcome).toBe("hold");
    expect(find(ev(0.02, T0 + 1, { recipient: "shadyapi" }).decision.anomalies, "NEW_RECIPIENT")).toBeDefined();
  });
});

describe("REPEATED_DENIALS", () => {
  it("medium after 3 blocks in 10 minutes, high after 6; blocks outside the window don't count", () => {
    policy([...roomy, { id: "max", kind: "perTxLimit", maxMicro: usdToMicro(1) }]);
    ev(5, T0 - 11 * MIN); // outside the window
    for (let i = 0; i < 3; i++) expect(ev(5, T0 + i).decision.outcome).toBe("block");
    expect(find(ev(0.02, T0 + 10).decision.anomalies, "REPEATED_DENIALS")).toMatchObject({ severity: "medium", measured: { blockedInWindow: 3 } });
    for (let i = 0; i < 3; i++) ev(5, T0 + 20 + i);
    expect(find(ev(0.02, T0 + 30).decision.anomalies, "REPEATED_DENIALS")).toMatchObject({ severity: "high", measured: { blockedInWindow: 6 } });
  });
});

describe("RAPID_BUDGET_DEPLETION", () => {
  it("flags a burst that eats most of what's left of the daily budget", () => {
    policy([{ id: "daily", kind: "periodBudget", period: "day", maxMicro: usdToMicro(1) }, { id: "allow", kind: "allowlist", recipients: ["sportsfeed"] }]);
    expect(find(ev(0.3, T0).decision.anomalies, "RAPID_BUDGET_DEPLETION")).toBeUndefined(); // 30% of $1.00
    const d = find(ev(0.3, T0 + 5 * MIN).decision.anomalies, "RAPID_BUDGET_DEPLETION")!;
    // $0.60 in 10 min vs $0.70 left = 85%
    expect(d).toMatchObject({ severity: "high", measured: { budget: "daily", remainingMicro: 700_000, windowSpendMicro: 600_000, sharePct: 85 } });
    expect(typeof d.measured.minutesToEmptyAtThisPace).toBe("number");
  });

  it("ignores tiny amounts and exhausted budgets (those are blocks, not anomalies)", () => {
    policy([{ id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(0.2) }]);
    expect(find(ev(0.15, T0).decision.anomalies, "RAPID_BUDGET_DEPLETION")).toBeUndefined(); // under the $0.25 floor
    policy([{ id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(1) }], "race");
    expect(ev(0.8, T0, { agentId: "race" }).decision.outcome).toBe("allow");
    const over = ev(0.8, T0 + 1, { agentId: "race" }); // $0.80 > $0.20 left: the budget blocks it
    expect(over.decision).toMatchObject({ outcome: "block", ruleId: "task" });
    expect(find(over.decision.anomalies, "RAPID_BUDGET_DEPLETION")).toBeUndefined();
  });
});

describe("DUPLICATE_PATTERN and idempotency", () => {
  it("flags the 6th identical purchase in 10 minutes", () => {
    policy(roomy);
    const same = { purpose: "Bulk odds" };
    const out = Array.from({ length: 6 }, (_, i) => find(ev(0.8, T0 + i * MIN, same).decision.anomalies, "DUPLICATE_PATTERN"));
    expect(out.slice(0, 5).every((x) => x === undefined)).toBe(true);
    expect(out[5]).toMatchObject({ severity: "low", measured: { identicalInWindow: 5 } });
  });

  it("a replayed requestId returns the stored decision and signals, and adds no row", () => {
    policy(roomy);
    const first = ev(2.5, T0, { requestId: "fixed" });
    const rows = () => (db.prepare("SELECT COUNT(*) n FROM requests").get() as any).n;
    const before = rows();
    const again = ev(2.5, T0 + 1000, { requestId: "fixed" });
    expect(again.duplicate).toBe(true);
    expect(again.decision.anomalies).toEqual(first.decision.anomalies);
    expect(rows()).toBe(before);
  });
});

describe("decision behavior: rules stay authoritative", () => {
  const guard = (extra: Partial<Extract<Rule, { kind: "anomalyGuard" }>> = {}): Rule => ({ id: "unusual", kind: "anomalyGuard", minSeverity: "medium", ...extra });

  it("without an anomalyGuard rule, anomalies are recorded but never change the outcome", () => {
    policy(roomy.filter((r) => r.kind !== "allowlist"));
    const r = ev(2.5, T0, { recipient: ATTACKER });
    expect(r.decision.outcome).toBe("allow");
    expect(types(r.decision.anomalies)).toEqual(["AMOUNT_SPIKE", "NEW_RECIPIENT"]);
  });

  it("with anomalyGuard, elevated risk HOLDS; below its threshold it only flags", () => {
    policy([...roomy.filter((r) => r.kind !== "allowlist"), guard({ minSeverity: "high" })]);
    expect(ev(2.5, T0).decision.outcome).toBe("allow"); // AMOUNT_SPIKE medium, NEW_RECIPIENT low: under "high"
    const held = ev(0.5, T0 + 1, { recipient: ATTACKER });
    expect(held.decision).toMatchObject({ outcome: "hold", ruleId: "unusual" });
    expect(held.decision.reason).toMatch(/^Unusual activity: First payment to 0x7a3f…c91e/);
  });

  it("block beats an anomaly hold", () => {
    policy([...roomy, { id: "max", kind: "perTxLimit", maxMicro: usdToMicro(1) }, guard()]);
    const r = ev(2.5, T0, { recipient: ATTACKER });
    expect(r.decision.outcome).toBe("block");
    expect(r.decision.ruleId).toBe("max");
    expect(r.decision.violations.map((v) => v.ruleId)).toEqual(expect.arrayContaining(["max", "allow", "unusual"]));
  });

  it("anomalyGuard can be made strict with onViolation: block, and can be limited to some signals", () => {
    policy([...roomy, guard({ onViolation: "block", signals: ["AMOUNT_SPIKE"] })]);
    expect(ev(0.02, T0, { recipient: "oddsapi" }).decision.outcome).toBe("allow"); // NEW_RECIPIENT low, not watched anyway
    expect(ev(2.5, T0 + 1).decision).toMatchObject({ outcome: "block", ruleId: "unusual" });
  });

  it("existing task and daily budgets still block exactly as before, anomalies or not", () => {
    policy([
      { id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(1) },
      { id: "daily", kind: "periodBudget", period: "day", maxMicro: usdToMicro(1.5) },
      guard({ minSeverity: "low" }),
    ]);
    expect(ev(0.8, T0).decision.ruleId).not.toBe("task");
    const over = ev(0.8, T0 + 1);
    expect(over.decision).toMatchObject({ outcome: "block", ruleId: "task" });
    const daily = ev(0.8, T0 + 2, { taskId: "other" });
    expect(daily.decision).toMatchObject({ outcome: "block", ruleId: "daily" });
  });
});

describe("concurrency", () => {
  it("N processes × M requests: anomalies are computed serially (each request sees every earlier one) and budgets hold", async () => {
    const rules: Rule[] = [{ id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(0.1) }];
    savePolicy(db, "race-agent", rules, policyHash(rules));
    const startAt = Date.now() + 1200;
    const outs = await Promise.all(
      [0, 1, 2, 3].map((p) => run("npx", ["tsx", join(__dirname, "race-worker.ts"), dbPath, `p${p}`, "5", "10000", String(startAt)], { cwd: join(__dirname, "..") })),
    );
    const outcomes = outs.flatMap((o) => JSON.parse(o.stdout) as string[]);
    expect(outcomes.filter((o) => o === "allow")).toHaveLength(10); // $0.10 / $0.01: exactly ten, never more
    const counts = (db.prepare("SELECT anomalies_json j FROM requests WHERE agent_id='race-agent'").all() as any[])
      .map((r) => (JSON.parse(r.j) as AnomalySignal[]).find((a) => a.type === "FREQUENCY_SPIKE")?.measured.requestsInWindow)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    // 20 requests within a minute: the 10th..20th each see a distinct, exact count. No two saw the same history.
    expect(counts).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  }, 30_000);
});

describe("config", () => {
  it("ANOMALY_* overrides positive integers and rejects anything else", () => {
    const warnings: string[] = [];
    const c = loadAnomalyConfig({ ANOMALY_FREQUENCY_MIN_COUNT: "3", ANOMALY_DENIAL_COUNT: "-1", ANOMALY_AMOUNT_SPIKE_RATIO: "abc" }, (m) => warnings.push(m));
    expect(c.FREQUENCY_MIN_COUNT).toBe(3);
    expect(c.DENIAL_COUNT).toBe(ANOMALY_DEFAULTS.DENIAL_COUNT);
    expect(c.AMOUNT_SPIKE_RATIO).toBe(ANOMALY_DEFAULTS.AMOUNT_SPIKE_RATIO);
    expect(warnings).toHaveLength(2);
  });
});

describe("monitoring API", () => {
  it("owner sees anomalies with measured values; agents and anonymous callers don't; the agent's decision omits them", async () => {
    const { createApp } = await import("../src/server");
    const { loadAuth } = await import("../src/auth");
    const tok = () => randomBytes(32).toString("base64url");
    const OWNER = tok();
    const AGENT = tok();
    const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${AGENT}` }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, path: string, token?: string, body?: unknown) =>
      fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    try {
      policy(roomy, "research-agent");
      const d = await call("POST", "/v1/payments/evaluate", AGENT, { requestId: "api-1", agentId: "research-agent", taskId: "t", recipient: ATTACKER, amountMicro: 3_000_000, category: "other", purpose: "license renewal" });
      const decision = (await d.json()) as any;
      expect(decision.outcome).toBe("hold");
      expect(decision.anomalies).toBeUndefined();

      const res = await call("GET", "/v1/agents/research-agent/anomalies", OWNER);
      expect(res.status).toBe(200);
      const { items } = (await res.json()) as any;
      expect(items.map((i: any) => i.type).sort()).toEqual(["AMOUNT_SPIKE", "NEW_RECIPIENT"]);
      for (const i of items) {
        expect(i).toMatchObject({ requestId: "api-1", agentId: "research-agent", outcome: "hold", amountMicro: 3_000_000 });
        expect(typeof i.explanation).toBe("string");
        expect(typeof i.at).toBe("string");
        expect(["low", "medium", "high"]).toContain(i.severity);
        expect(i.measured).toBeTypeOf("object");
      }
      expect((await call("GET", "/v1/agents/research-agent/anomalies", AGENT)).status).toBe(403);
      expect((await call("GET", "/v1/agents/research-agent/anomalies")).status).toBe(401);

      const act = (await (await call("GET", "/v1/activity?agentId=research-agent", OWNER)).json()) as any;
      expect(act.items[0].anomalies.length).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("hardening", () => {
  it("DUPLICATE_PATTERN: rewording the agent-written purpose doesn't hide a repeat", () => {
    policy(roomy);
    const out = Array.from({ length: 6 }, (_, i) => find(ev(0.8, T0 + i * MIN, { purpose: `Bulk odds v${i}` }).decision.anomalies, "DUPLICATE_PATTERN"));
    expect(out[4]).toBeUndefined();
    expect(out[5]).toMatchObject({ severity: "low", measured: { identicalInWindow: 5, distinctPurposes: 5 } });
  });

  it("REPEATED_DENIALS: holds the owner refused count as rejections too", async () => {
    const { denyHold } = await import("../src/approvals");
    policy([...roomy, { id: "ask", kind: "approvalThreshold", aboveMicro: usdToMicro(1) }]);
    for (let i = 0; i < 3; i++) {
      const h = ev(2, T0 + i);
      expect(h.decision.outcome).toBe("hold");
      expect((await denyHold(db, h.decision.requestId)).ok).toBe(true);
    }
    expect(find(ev(0.02, T0 + 10).decision.anomalies, "REPEATED_DENIALS")).toMatchObject({
      severity: "medium", measured: { rejectedInWindow: 3, blockedInWindow: 0, ownerDeniedInWindow: 3 },
    });
  });

  it("RAPID_BUDGET_DEPLETION covers weekly and monthly budgets", () => {
    for (const period of ["week", "month"] as const) {
      const agentId = `dep-${period}`;
      policy([{ id: period, kind: "periodBudget", period, maxMicro: usdToMicro(1) }, { id: "allow", kind: "allowlist", recipients: ["sportsfeed"] }], agentId);
      ev(0.3, T0, { agentId });
      expect(find(ev(0.3, T0 + 5 * MIN, { agentId }).decision.anomalies, "RAPID_BUDGET_DEPLETION")).toMatchObject({
        severity: "high", measured: { budget: period === "week" ? "weekly" : "monthly", remainingMicro: 700_000, windowSpendMicro: 600_000, sharePct: 85 },
      });
    }
  });

  it("RAPID_BUDGET_DEPLETION: just after UTC midnight, yesterday's spend isn't part of today's burst", () => {
    const midnight = Date.parse("2026-11-19T00:00:00Z");
    policy([{ id: "daily", kind: "periodBudget", period: "day", maxMicro: usdToMicro(1) }, { id: "allow", kind: "allowlist", recipients: ["sportsfeed"] }]);
    ev(0.3, midnight - 2 * MIN);
    expect(find(ev(0.3, midnight + 2 * MIN).decision.anomalies, "RAPID_BUDGET_DEPLETION")).toBeUndefined(); // 30% of today's $1.00, not 60%
  });

  it("an agent's decisions and own summary carry no anomaly measurements, even in an anomalyGuard reason; the owner's do", async () => {
    const { createApp } = await import("../src/server");
    const { loadAuth } = await import("../src/auth");
    const tok = () => randomBytes(32).toString("base64url");
    const OWNER = tok();
    const AGENT = tok();
    const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${AGENT}` }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, token: string, body?: unknown) =>
      (await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
    const REDACTED = "Unusual activity for this agent. The owner can see the details.";
    try {
      policy([...roomy.filter((r) => r.kind !== "allowlist"), { id: "unusual", kind: "anomalyGuard", minSeverity: "medium" }], "research-agent");
      // No history: $2.50 trips the absolute AMOUNT_SPIKE threshold (medium), so the guard holds it.
      const d = await call("POST", "/v1/payments/evaluate", AGENT, { requestId: "g-1", agentId: "research-agent", taskId: "t", recipient: "sportsfeed", amountMicro: 2_500_000, category: "data", purpose: "x" });
      expect(d).toMatchObject({ outcome: "hold", ruleId: "unusual", reason: REDACTED });
      expect(d.anomalies).toBeUndefined();
      expect(JSON.stringify(d)).not.toMatch(/threshold|\$2\.00/);
      // Same answer on an idempotent replay.
      expect((await call("POST", "/v1/payments/evaluate", AGENT, { requestId: "g-1", agentId: "research-agent", taskId: "t", recipient: "sportsfeed", amountMicro: 2_500_000, category: "data", purpose: "x" })).reason).toBe(REDACTED);

      const mine = await call("GET", "/v1/agents/research-agent/summary", AGENT);
      expect(mine.recent[0]).toMatchObject({ requestId: "g-1", reason: REDACTED, anomalies: [] });
      expect(mine.pending[0]).toMatchObject({ requestId: "g-1", reason: REDACTED });
      expect(JSON.stringify(mine)).not.toMatch(/threshold|medianMicro|thresholdMicro/);

      const owner = await call("GET", "/v1/agents/research-agent/summary", OWNER);
      expect(owner.recent[0].reason).toMatch(/large-payment threshold/);
      expect(owner.recent[0].anomalies.map((a: any) => a.type)).toContain("AMOUNT_SPIKE");
      expect(owner.pending[0].reason).toMatch(/large-payment threshold/);
      // Persisted in the audit trail with the full detail.
      expect(stored("g-1").find((a) => a.type === "AMOUNT_SPIKE")?.measured).toMatchObject({ amountMicro: 2_500_000, thresholdMicro: 2_000_000 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
