import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyHash, usdToMicro, type Rule } from "@agent-firewall/policy";
import { openDb, type DB } from "../src/db";
import { evaluateAndReserve, markFailed, reconcilePayment, releaseStaleReservations, savePolicy, spendState } from "../src/engine";

const run = promisify(execFile);
let dir: string;
let dbPath: string;
let db: DB;

const rules = (taskMax: number): Rule[] => [
  { id: "task", kind: "taskBudget", taskId: "*", maxMicro: taskMax },
  { id: "daily", kind: "periodBudget", period: "day", maxMicro: usdToMicro(1000) },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-"));
  dbPath = join(dir, "t.db");
  db = openDb(dbPath);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (id: string, amountMicro: number, extra: object = {}) => ({
  requestId: id, agentId: "race-agent", taskId: "race-task", recipient: "sportsfeed", amountMicro, category: "data" as const, purpose: "t", ...extra,
});

describe("engine", () => {
  it("blocks everything when no policy is saved (deny by default)", () => {
    expect(evaluateAndReserve(db, req("a", 1)).decision.outcome).toBe("block");
  });

  it("is idempotent on requestId", () => {
    savePolicy(db, "race-agent", rules(usdToMicro(1)), policyHash(rules(usdToMicro(1))));
    expect(evaluateAndReserve(db, req("a", 600_000)).duplicate).toBe(false);
    const again = evaluateAndReserve(db, req("a", 600_000));
    expect(again.duplicate).toBe(true);
    expect(spendState(db, "race-agent", "race-task", new Date()).taskSpentMicro).toBe(600_000);
  });

  it("releases budget when a payment fails", () => {
    savePolicy(db, "race-agent", rules(usdToMicro(1)), policyHash(rules(usdToMicro(1))));
    evaluateAndReserve(db, req("a", 800_000));
    expect(evaluateAndReserve(db, req("b", 800_000)).decision.outcome).toBe("block");
    expect(markFailed(db, "a")).toBe(true);
    expect(evaluateAndReserve(db, req("c", 800_000)).decision.outcome).toBe("allow");
  });

  it("keeps counting a payment that failed AFTER signing until the owner reconciles it; never released by time alone", () => {
    savePolicy(db, "race-agent", rules(usdToMicro(1)), policyHash(rules(usdToMicro(1))));
    evaluateAndReserve(db, req("a", 800_000));
    db.prepare("UPDATE requests SET signed_ms=? WHERE request_id='a'").run(Date.now());
    expect(markFailed(db, "a")).toBe(true);
    // The seller may already have settled the signed authorization, so the budget is NOT returned.
    expect(evaluateAndReserve(db, req("b", 800_000)).decision.outcome).toBe("block");
    expect(spendState(db, "race-agent", "race-task", new Date()).taskSpentMicro).toBe(800_000);
    // Not even long after the authorization could have expired.
    expect(releaseStaleReservations(db, { now: Date.now() + 30 * 24 * 3600_000, ttlMs: 15 * 60_000 })).toEqual([]);
    expect(evaluateAndReserve(db, req("c", 800_000)).decision.outcome).toBe("block");
    // Only an owner reconciliation returns it.
    expect(reconcilePayment(db, "a", "not_paid", { note: "checked Gateway history" })).toEqual({ status: "released" });
    expect(evaluateAndReserve(db, req("d", 800_000)).decision.outcome).toBe("allow");
  });

  it("holds return a token and count against budget", () => {
    const r: Rule[] = [...rules(usdToMicro(10)), { id: "approve", kind: "approvalThreshold", aboveMicro: usdToMicro(1) }];
    savePolicy(db, "race-agent", r, policyHash(r));
    const h = evaluateAndReserve(db, req("h", usdToMicro(3)), { devMode: true });
    expect(h.decision.outcome).toBe("hold");
    expect(h.holdToken).toBeTruthy();
    expect(spendState(db, "race-agent", "race-task", new Date()).taskSpentMicro).toBe(usdToMicro(3));
  });

  it("rate limit trips the pause for subsequent requests", () => {
    const r: Rule[] = [...rules(usdToMicro(10)), { id: "rl", kind: "rateLimit", maxPerMinute: 3, action: "pause" }];
    savePolicy(db, "race-agent", r, policyHash(r));
    const outs = [1, 2, 3, 4, 5].map((i) => evaluateAndReserve(db, req(`r${i}`, 1000)).decision.outcome);
    expect(outs).toEqual(["allow", "allow", "allow", "block", "block"]);
    expect(evaluateAndReserve(db, req("r6", 1000)).decision.ruleId).toBe("paused");
  });

  it("race: two $0.80 requests against $1.00 → exactly one allowed (separate processes)", async () => {
    const r = rules(usdToMicro(1));
    savePolicy(db, "race-agent", r, policyHash(r));
    const startAt = Date.now() + 1500;
    const worker = join(import.meta.dirname, "race-worker.ts");
    const procs = ["p1", "p2"].map((p) => run(process.execPath, ["--import", "tsx", worker, dbPath, p, "1", "800000", String(startAt)]));
    const outs = (await Promise.all(procs)).flatMap((o) => JSON.parse(o.stdout) as string[]);
    expect(outs.sort()).toEqual(["allow", "block"]);
  }, 20_000);

  it("race: N processes × M requests never overspend the task budget", async () => {
    const budget = usdToMicro(1);
    const r = rules(budget);
    savePolicy(db, "race-agent", r, policyHash(r));
    const startAt = Date.now() + 2000;
    const worker = join(import.meta.dirname, "race-worker.ts");
    const procs = Array.from({ length: 6 }, (_, i) => run(process.execPath, ["--import", "tsx", worker, dbPath, `w${i}`, "10", "30000", String(startAt)]));
    const outs = (await Promise.all(procs)).flatMap((o) => JSON.parse(o.stdout) as string[]);
    const allowed = outs.filter((o) => o === "allow").length;
    expect(outs).toHaveLength(60);
    expect(allowed).toBe(Math.floor(budget / 30000)); // 33
    expect(spendState(db, "race-agent", "race-task", new Date()).taskSpentMicro).toBeLessThanOrEqual(budget);
  }, 30_000);
});
