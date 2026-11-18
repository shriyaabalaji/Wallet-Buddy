import { describe, expect, it } from "vitest";
import {
  arcNativeToMicro,
  evaluate,
  formatUsd,
  microToArcNative,
  policyHash,
  usdToMicro,
  validateRules,
  describeRule,
  type AnomalySignal,
  type PaymentRequest,
  type Rule,
  type SpendState,
} from "../src";

const base: PaymentRequest = {
  requestId: "r1",
  agentId: "research-agent",
  taskId: "nba-injuries",
  recipient: "sportsfeed",
  amountMicro: 20_000,
  category: "data",
  purpose: "injury report",
};
const empty: SpendState = { taskSpentMicro: 0, periodSpentMicro: { day: 0, week: 0, month: 0 }, requestsLastMinute: 0, paused: false };

const demoRules: Rule[] = [
  { id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(10) },
  { id: "daily", kind: "periodBudget", period: "day", maxMicro: usdToMicro(5) },
  { id: "approve", kind: "approvalThreshold", aboveMicro: usdToMicro(1) },
  { id: "allow", kind: "allowlist", recipients: ["sportsfeed", "oddsapi"] },
];

describe("money", () => {
  it("converts USD ↔ micro without float dust", () => {
    expect(usdToMicro(0.1 + 0.2)).toBe(300_000);
    expect(usdToMicro("$1,234.56")).toBe(1_234_560_000);
    expect(formatUsd(20_000)).toBe("$0.02");
    expect(formatUsd(2_500)).toBe("$0.0025");
    expect(formatUsd(50_000_000)).toBe("$50.00");
  });
  it("normalizes Arc native 18-decimal USDC at one boundary", () => {
    expect(microToArcNative(1_000_000)).toBe(10n ** 18n);
    expect(arcNativeToMicro(10n ** 18n)).toBe(1_000_000);
    expect(arcNativeToMicro(microToArcNative(123_456))).toBe(123_456);
    expect(() => arcNativeToMicro(1n)).toThrow(/sub-micro/);
  });
});

describe("hash", () => {
  it("is stable under rule order and key order", () => {
    const a = policyHash(demoRules);
    const b = policyHash([...demoRules].reverse().map((r) => JSON.parse(JSON.stringify(r, Object.keys(r).sort().reverse()))));
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("changes when a value changes", () => {
    const changed = demoRules.map((r) => (r.id === "daily" ? { ...r, maxMicro: usdToMicro(6) } : r));
    expect(policyHash(changed)).not.toBe(policyHash(demoRules));
  });
});

describe("evaluate", () => {
  it("allows a small payment to an allowlisted seller", () => {
    expect(evaluate(demoRules, base, empty).outcome).toBe("allow");
  });

  it("holds above the approval threshold", () => {
    const d = evaluate(demoRules, { ...base, amountMicro: usdToMicro(1.5) }, empty);
    expect(d.outcome).toBe("hold");
    expect(d.ruleId).toBe("approve");
  });

  it("holds an unknown recipient and flags possible injection", () => {
    const d = evaluate(demoRules, { ...base, recipient: "0x7a3f00000000000000000000000000000000c91e", amountMicro: usdToMicro(3), sourceContext: "after response from sportsfeed" }, empty);
    expect(d.outcome).toBe("hold");
    expect(d.flags.join(" ")).toMatch(/possible injection/);
  });

  it("block beats hold", () => {
    const d = evaluate(demoRules, { ...base, recipient: "0xdead", amountMicro: usdToMicro(50) }, empty);
    expect(d.outcome).toBe("block");
    expect(d.violations.map((v) => v.ruleId)).toEqual(expect.arrayContaining(["task", "daily", "approve", "allow"]));
  });

  it("strict allowlist blocks when onViolation=block", () => {
    const rules: Rule[] = [{ id: "allow", kind: "allowlist", recipients: ["a"], onViolation: "block" }];
    expect(evaluate(rules, { ...base, recipient: "b" }, empty).outcome).toBe("block");
  });

  it("task budget: $0.80 with $1.00 left allowed, second blocked", () => {
    const st = { ...empty, taskSpentMicro: usdToMicro(9) };
    expect(evaluate(demoRules, { ...base, amountMicro: 800_000 }, st).outcome).toBe("allow");
    const after = { ...st, taskSpentMicro: usdToMicro(9.8) };
    const d = evaluate(demoRules, { ...base, amountMicro: 800_000 }, after);
    expect(d.outcome).toBe("block");
    expect(d.reason).toMatch(/\$0\.20 left/);
  });

  it("task budget scoped to a specific task ignores other tasks", () => {
    const rules: Rule[] = [{ id: "t", kind: "taskBudget", taskId: "other", maxMicro: 1 }];
    expect(evaluate(rules, base, empty).outcome).toBe("allow");
  });

  it("per-tx limit, categories, pause", () => {
    expect(evaluate([{ id: "p", kind: "perTxLimit", maxMicro: 10_000 }], base, empty).outcome).toBe("block");
    expect(evaluate([{ id: "c", kind: "categories", allowed: ["compute"] }], base, empty).outcome).toBe("block");
    expect(evaluate([{ id: "x", kind: "paused" }], base, empty).outcome).toBe("block");
    expect(evaluate([], base, { ...empty, paused: true }).outcome).toBe("block");
  });

  it("rate limit blocks and triggers pause", () => {
    const rules: Rule[] = [{ id: "rl", kind: "rateLimit", maxPerMinute: 20, action: "pause" }];
    expect(evaluate(rules, base, { ...empty, requestsLastMinute: 19 }).outcome).toBe("allow");
    const d = evaluate(rules, base, { ...empty, requestsLastMinute: 20 });
    expect(d.outcome).toBe("block");
    expect(d.triggerPause).toBe(true);
  });

  it("time windows respect tz, days, and wraparound", () => {
    const rule: Rule = { id: "tw", kind: "timeWindow", days: [1, 2, 3, 4, 5], startHour: 9, endHour: 21, tz: "America/Chicago" };
    // Mon 2026-11-16 15:00 UTC = 09:00 CST
    expect(evaluate([rule], base, empty, { now: new Date("2026-11-16T15:00:00Z") }).outcome).toBe("allow");
    // 14:59 UTC = 08:59 CST
    expect(evaluate([rule], base, empty, { now: new Date("2026-11-16T14:59:00Z") }).outcome).toBe("block");
    // Sunday
    expect(evaluate([rule], base, empty, { now: new Date("2026-11-15T18:00:00Z") }).outcome).toBe("block");
    const night: Rule = { id: "n", kind: "timeWindow", days: [], startHour: 22, endHour: 6, tz: "UTC" };
    expect(evaluate([night], base, empty, { now: new Date("2026-11-16T23:00:00Z") }).outcome).toBe("allow");
    expect(evaluate([night], base, empty, { now: new Date("2026-11-16T12:00:00Z") }).outcome).toBe("block");
  });

  it("rejects non-positive / fractional amounts", () => {
    expect(evaluate([], { ...base, amountMicro: 0 }, empty).outcome).toBe("block");
    expect(evaluate([], { ...base, amountMicro: 1.5 }, empty).outcome).toBe("block");
  });
});

describe("validateRules", () => {
  it("accepts the demo rules", () => expect(validateRules(demoRules).errors).toEqual([]));
  it("rejects garbage", () => {
    const { errors } = validateRules([
      { id: "a", kind: "perTxLimit", maxMicro: 1.5 },
      { id: "a", kind: "paused" },
      { id: "b", kind: "timeWindow", days: [7], startHour: 0, endHour: 1, tz: "UTC" },
      { id: "c", kind: "timeWindow", days: [], startHour: 0, endHour: 1, tz: "Mars/Base" },
      { id: "d", kind: "nope" },
    ]);
    expect(errors).toHaveLength(5);
  });
});

describe("anomalyGuard (anomaly signals come from the firewall's ledger; evaluate only reacts to them)", () => {
  const spike: AnomalySignal = { type: "AMOUNT_SPIKE", severity: "medium", explanation: "$2.50 is 25× typical.", measured: {} };
  const newAddr: AnomalySignal = { type: "NEW_RECIPIENT", severity: "high", explanation: "First payment to 0x7a3f…c91e.", measured: {} };
  const guard: Rule = { id: "unusual", kind: "anomalyGuard" };
  const withA = (anomalies: AnomalySignal[]): SpendState => ({ ...empty, anomalies });

  it("is a no-op without signals (dry runs, old callers) and passes signals through to the decision", () => {
    expect(evaluate([...demoRules, guard], base, empty)).toMatchObject({ outcome: "allow", anomalies: [] });
    expect(evaluate(demoRules, base, withA([newAddr])).anomalies).toEqual([newAddr]);
    expect(evaluate(demoRules, base, withA([newAddr])).outcome).toBe("allow"); // no guard rule: flag only
  });

  it("holds at or above minSeverity (default high), most severe reason first", () => {
    expect(evaluate([guard], base, withA([spike])).outcome).toBe("allow");
    const d = evaluate([guard], base, withA([spike, newAddr]));
    expect(d).toMatchObject({ outcome: "hold", ruleId: "unusual" });
    expect(d.reason).toBe("Unusual activity: First payment to 0x7a3f…c91e.");
    expect(evaluate([{ ...guard, minSeverity: "medium" }], base, withA([spike, newAddr])).reason).toContain("(+1 more signal)");
  });

  it("respects the signals filter", () => {
    expect(evaluate([{ ...guard, minSeverity: "low", signals: ["DUPLICATE_PATTERN"] }], base, withA([spike, newAddr])).outcome).toBe("allow");
  });

  it("never overrides a block; the allowlist's hold reason still wins among holds", () => {
    const big = { ...base, amountMicro: usdToMicro(50) };
    expect(evaluate([...demoRules, guard], big, withA([newAddr]))).toMatchObject({ outcome: "block", ruleId: "task" });
    const unknown = { ...base, recipient: "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e" };
    expect(evaluate([...demoRules, guard], unknown, withA([newAddr]))).toMatchObject({ outcome: "hold", ruleId: "allow" });
    expect(evaluate([{ ...guard, onViolation: "block" }], base, withA([newAddr])).outcome).toBe("block");
  });

  it("validates, describes and hashes like any other rule", () => {
    expect(validateRules([{ id: "u", kind: "anomalyGuard", minSeverity: "medium", signals: ["AMOUNT_SPIKE"] }]).errors).toEqual([]);
    expect(validateRules([{ id: "u", kind: "anomalyGuard", minSeverity: "extreme" }]).errors).toHaveLength(1);
    expect(validateRules([{ id: "u", kind: "anomalyGuard", signals: ["MOON_PHASE"] }]).errors).toHaveLength(1);
    expect(describeRule(guard)).toBe("Ask for your OK when spending looks highly unusual for this agent.");
    expect(describeRule({ ...guard, minSeverity: "medium", onViolation: "block", signals: ["AMOUNT_SPIKE", "NEW_RECIPIENT"] })).toBe(
      "Block payments when spending looks unusual for this agent (amount spike, new recipient).",
    );
    expect(policyHash([...demoRules, guard])).not.toBe(policyHash(demoRules));
    expect(policyHash(demoRules)).toBe(policyHash([...demoRules])); // existing hashes unchanged
  });
});

describe("describeRule: allowlist wording follows onViolation", () => {
  it("says blocked when unknown recipients are blocked, and asks otherwise", async () => {
    const { describeRule } = await import("../src/describe");
    expect(describeRule({ id: "a", kind: "allowlist", recipients: ["sportsfeed"], onViolation: "block" })).toMatch(/Anyone else is blocked/);
    expect(describeRule({ id: "a", kind: "allowlist", recipients: ["sportsfeed"] })).toMatch(/needs your OK/);
  });
});
