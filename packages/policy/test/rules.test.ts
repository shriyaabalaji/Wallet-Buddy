// Per-rule unit tests for evaluate(): every rule kind at its boundary, onViolation overrides, the exact reason/ruleId
// surfaced, and how violations combine (block beats hold, first block in rule order wins, allowlist reason preferred
// among holds). These pin down what evaluate.ts ACTUALLY does; see comments where that may differ from intuition.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEVERITY,
  evaluate,
  guardedAnomalies,
  inWindow,
  type AnomalySignal,
  type Decision,
  type PaymentRequest,
  type Rule,
  type RuleKind,
  type SpendState,
} from "../src";

const NOW = new Date("2026-11-18T12:30:00Z"); // Wednesday (day 3), 12:30 UTC

const req = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  requestId: "r1",
  agentId: "agent",
  taskId: "task-a",
  recipient: "sportsfeed",
  amountMicro: 100_000,
  category: "data",
  purpose: "test",
  ...over,
});
const state = (over: Partial<SpendState> = {}): SpendState => ({
  taskSpentMicro: 0,
  periodSpentMicro: { day: 0, week: 0, month: 0 },
  requestsLastMinute: 0,
  paused: false,
  ...over,
});
const ev = (rules: Rule[], r: Partial<PaymentRequest> = {}, s: Partial<SpendState> = {}, now = NOW): Decision =>
  evaluate(rules, req(r), state(s), { now });

const expectAllow = (d: Decision) => {
  expect(d.outcome).toBe("allow");
  expect(d.ruleId).toBeUndefined();
  expect(d.reason).toBe("Within all rules.");
  expect(d.violations).toEqual([]);
};
const expectOnly = (d: Decision, outcome: "block" | "hold", ruleId: string, kind: RuleKind, reason: string) => {
  expect(d.outcome).toBe(outcome);
  expect(d.ruleId).toBe(ruleId);
  expect(d.reason).toBe(reason);
  expect(d.violations).toEqual([{ ruleId, kind, severity: outcome, reason }]);
};

describe("default severities", () => {
  it("blocks for hard limits; holds for allowlist, approvalThreshold, anomalyGuard", () => {
    expect(DEFAULT_SEVERITY).toEqual({
      paused: "block", rateLimit: "block", categories: "block", timeWindow: "block", perTxLimit: "block",
      taskBudget: "block", periodBudget: "block", allowlist: "hold", approvalThreshold: "hold", anomalyGuard: "hold",
    });
  });

  it("no rules at all = allow (deny-by-default for a missing policy lives in the engine, not here)", () => {
    expectAllow(ev([]));
  });
});

describe("input validation (pre-rule)", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("amount %s is blocked with ruleId 'input'", (amountMicro) => {
    const d = ev([], { amountMicro });
    expectOnly(d, "block", "input", "perTxLimit", "Amount must be a positive whole number of micro-USDC.");
  });

  it("1 micro is the smallest valid amount", () => {
    expectAllow(ev([], { amountMicro: 1 }));
  });

  it("input check short-circuits: no other rule or paused state is evaluated, flags are empty", () => {
    const d = ev([{ id: "p", kind: "paused" }, { id: "a", kind: "allowlist", recipients: ["x"] }], { amountMicro: 0, recipient: "0x" + "a".repeat(40) }, { paused: true });
    expect(d.violations.map((v) => v.ruleId)).toEqual(["input"]);
    expect(d.flags).toEqual([]);
    expect(d.triggerPause).toBe(false);
  });
});

describe("perTxLimit", () => {
  const r: Rule = { id: "ptx", kind: "perTxLimit", maxMicro: 1_000_000 };
  it("allows exactly at the limit", () => expectAllow(ev([r], { amountMicro: 1_000_000 })));
  it("blocks 1 micro over, with the exact reason", () =>
    expectOnly(ev([r], { amountMicro: 1_000_001 }), "block", "ptx", "perTxLimit", "$1.000001 is over the $1.00 per-payment limit."));
  it("onViolation: hold escalates instead of blocking", () =>
    expectOnly(ev([{ ...r, onViolation: "hold" }], { amountMicro: 2_000_000 }), "hold", "ptx", "perTxLimit", "$2.00 is over the $1.00 per-payment limit."));
  it("maxMicro 0 blocks every payment", () => expect(ev([{ ...r, maxMicro: 0 }], { amountMicro: 1 }).outcome).toBe("block"));
  it("ignores spend state (per payment, not cumulative)", () =>
    expectAllow(ev([r], { amountMicro: 1_000_000 }, { taskSpentMicro: 9e9, periodSpentMicro: { day: 9e9, week: 9e9, month: 9e9 } })));
});

describe("taskBudget", () => {
  const r: Rule = { id: "tb", kind: "taskBudget", taskId: "*", maxMicro: 1_000_000 };
  it("allows when spent + amount equals the max", () => expectAllow(ev([r], { amountMicro: 400_000 }, { taskSpentMicro: 600_000 })));
  it("blocks 1 micro over, reporting what's left", () =>
    expectOnly(ev([r], { amountMicro: 400_001 }, { taskSpentMicro: 600_000 }), "block", "tb", "taskBudget", "Only $0.40 left of the $1.00 task budget."));
  it("clamps 'left' at $0.00 when already overspent", () =>
    expect(ev([r], { amountMicro: 1 }, { taskSpentMicro: 1_500_000 }).reason).toBe("Only $0.00 left of the $1.00 task budget."));
  it("onViolation: hold", () => expect(ev([{ ...r, onViolation: "hold" }], { amountMicro: 2_000_000 }).outcome).toBe("hold"));
  it("a named taskId applies only to that task", () => {
    const named: Rule = { ...r, taskId: "task-a" };
    expect(ev([named], { taskId: "task-a", amountMicro: 2_000_000 }).outcome).toBe("block");
    expectAllow(ev([named], { taskId: "task-b", amountMicro: 2_000_000 }));
  });
  it("taskId match is exact (case-sensitive, no trimming)", () => {
    expectAllow(ev([{ ...r, taskId: "Task-A" }], { taskId: "task-a", amountMicro: 2_000_000 }));
  });
  it("'*' applies to every task, measured against THIS task's spend only", () => {
    expectAllow(ev([r], { taskId: "fresh", amountMicro: 1_000_000 }, { taskSpentMicro: 0, periodSpentMicro: { day: 5e6, week: 5e6, month: 5e6 } }));
  });
  it("maxMicro 0 blocks everything for the task", () => expect(ev([{ ...r, maxMicro: 0 }], { amountMicro: 1 }).outcome).toBe("block"));
});

describe("periodBudget", () => {
  const labels = { day: "daily", week: "weekly", month: "monthly" } as const;
  for (const period of ["day", "week", "month"] as const) {
    describe(period, () => {
      const r: Rule = { id: `pb-${period}`, kind: "periodBudget", period, maxMicro: 5_000_000 };
      const spent = (n: number) => ({ periodSpentMicro: { day: 0, week: 0, month: 0, [period]: n } as SpendState["periodSpentMicro"] });
      it("allows at exactly the max", () => expectAllow(ev([r], { amountMicro: 1_000_000 }, spent(4_000_000))));
      it("blocks 1 micro over with the period label", () =>
        expectOnly(ev([r], { amountMicro: 1_000_001 }, spent(4_000_000)), "block", `pb-${period}`, "periodBudget", `Only $1.00 left of the $5.00 ${labels[period]} budget.`));
      it("only reads its own period's spend", () => {
        const others = { periodSpentMicro: { day: 9e9, week: 9e9, month: 9e9, [period]: 0 } as SpendState["periodSpentMicro"] };
        expectAllow(ev([r], { amountMicro: 5_000_000 }, others));
      });
      it("onViolation: hold", () => expect(ev([{ ...r, onViolation: "hold" }], { amountMicro: 6_000_000 }).outcome).toBe("hold"));
    });
  }

  it("most restrictive wins: daily allows but weekly is exhausted → block by weekly", () => {
    const rules: Rule[] = [
      { id: "day", kind: "periodBudget", period: "day", maxMicro: 5_000_000 },
      { id: "week", kind: "periodBudget", period: "week", maxMicro: 10_000_000 },
    ];
    const d = ev(rules, { amountMicro: 1_000_000 }, { periodSpentMicro: { day: 0, week: 9_500_000, month: 9_500_000 } });
    expectOnly(d, "block", "week", "periodBudget", "Only $0.50 left of the $10.00 weekly budget.");
  });

  it("two rules on the same period: the tighter one fires, the looser one doesn't", () => {
    const rules: Rule[] = [
      { id: "loose", kind: "periodBudget", period: "day", maxMicro: 10_000_000 },
      { id: "tight", kind: "periodBudget", period: "day", maxMicro: 2_000_000 },
    ];
    expect(ev(rules, { amountMicro: 2_000_000 }).outcome).toBe("allow");
    expectOnly(ev(rules, { amountMicro: 2_000_001 }), "block", "tight", "periodBudget", "Only $2.00 left of the $2.00 daily budget.");
  });
});

describe("categories", () => {
  const r: Rule = { id: "cat", kind: "categories", allowed: ["data", "inference"] };
  it("allows a listed category", () => expectAllow(ev([r], { category: "inference" })));
  it("blocks an unlisted one with the allowed list in the reason", () =>
    expectOnly(ev([r], { category: "compute" }), "block", "cat", "categories", '"compute" purchases aren\'t allowed (allowed: data, inference).'));
  it("onViolation: hold", () => expect(ev([{ ...r, onViolation: "hold" }], { category: "other" }).outcome).toBe("hold"));
});

describe("allowlist", () => {
  const r: Rule = { id: "al", kind: "allowlist", recipients: ["sportsfeed", " OddsAPI ", "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"] };
  it("allows a listed recipient", () => expectAllow(ev([r])));
  it("matching is case- and whitespace-insensitive on both sides", () => {
    expectAllow(ev([r], { recipient: "oddsapi" }));
    expectAllow(ev([r], { recipient: "  SPORTSFEED" }));
    expectAllow(ev([r], { recipient: "0xabcdef0123456789abcdef0123456789abcdef01" }));
  });
  it("holds (not blocks) an unknown recipient by default", () =>
    expectOnly(ev([r], { recipient: "evil.x402" }), "hold", "al", "allowlist", "evil.x402 isn't on your approved list."));
  it("shortens raw addresses in the reason", () =>
    expect(ev([r], { recipient: "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e" }).reason).toBe("0x7a3f…c91e isn't on your approved list."));
  it("onViolation: block makes it strict", () =>
    expectOnly(ev([{ ...r, onViolation: "block" }], { recipient: "evil" }), "block", "al", "allowlist", "evil isn't on your approved list."));
  it("prefix/substring is not a match", () => expect(ev([r], { recipient: "sportsfeed.evil" }).outcome).toBe("hold"));
});

describe("timeWindow", () => {
  const at = (iso: string) => new Date(iso);
  const r = (over: Partial<Extract<Rule, { kind: "timeWindow" }>> = {}): Extract<Rule, { kind: "timeWindow" }> =>
    ({ id: "tw", kind: "timeWindow", days: [], startHour: 9, endHour: 17, tz: "UTC", ...over });

  it("startHour is inclusive, endHour is exclusive", () => {
    expectAllow(ev([r()], {}, {}, at("2026-11-18T09:00:00Z")));
    expect(ev([r()], {}, {}, at("2026-11-18T08:59:59Z")).outcome).toBe("block");
    expectAllow(ev([r()], {}, {}, at("2026-11-18T16:59:59Z")));
    expectOnly(ev([r()], {}, {}, at("2026-11-18T17:00:00Z")), "block", "tw", "timeWindow", "Outside allowed spending hours (9am–5pm UTC).");
  });

  it("evaluates hours in the rule's timezone", () => {
    // Fixed-offset zones (no DST) so the test doesn't depend on tzdata DST rules.
    const tokyo = r({ tz: "Asia/Tokyo" }); // UTC+9
    expectAllow(ev([tokyo], {}, {}, at("2026-11-18T00:30:00Z"))); // 09:30 JST
    expect(ev([tokyo], {}, {}, at("2026-11-17T23:30:00Z")).reason).toBe("Outside allowed spending hours (9am–5pm Asia/Tokyo)."); // 08:30 JST
  });

  it("days are 0=Sun..6=Sat, in the rule's timezone; empty = every day", () => {
    expectAllow(ev([r({ days: [3] })])); // Wed
    expect(ev([r({ days: [1, 2, 4, 5] })]).outcome).toBe("block");
    // 2026-11-19T03:00Z is Thursday in UTC but still Wednesday 17:00 in Honolulu (UTC-10, no DST).
    expect(inWindow(r({ days: [3], startHour: 0, endHour: 0, tz: "Pacific/Honolulu" }), at("2026-11-19T03:00:00Z"))).toBe(true);
    expect(inWindow(r({ days: [3], startHour: 0, endHour: 0, tz: "UTC" }), at("2026-11-19T03:00:00Z"))).toBe(false);
  });

  it("startHour > endHour wraps past midnight", () => {
    const night = r({ startHour: 22, endHour: 6 });
    expect(inWindow(night, at("2026-11-18T22:00:00Z"))).toBe(true);
    expect(inWindow(night, at("2026-11-18T05:59:59Z"))).toBe(true);
    expect(inWindow(night, at("2026-11-18T06:00:00Z"))).toBe(false);
    expect(inWindow(night, at("2026-11-18T21:59:59Z"))).toBe(false);
    expect(ev([night], {}, {}, at("2026-11-18T12:00:00Z")).reason).toBe("Outside allowed spending hours (10pm–6am UTC).");
  });

  it("the day filter is checked against the CURRENT local day, not the day the overnight window opened", () => {
    // Documented behavior: a Friday-night 22→6 window does not cover Saturday 02:00, because Saturday isn't in days.
    const friNight = r({ days: [5], startHour: 22, endHour: 6 });
    expect(inWindow(friNight, at("2026-11-20T23:00:00Z"))).toBe(true); // Fri 23:00
    expect(inWindow(friNight, at("2026-11-21T02:00:00Z"))).toBe(false); // Sat 02:00
  });

  it("startHour === endHour means all day (subject to days)", () => {
    expect(inWindow(r({ startHour: 5, endHour: 5 }), at("2026-11-18T03:00:00Z"))).toBe(true);
    expect(inWindow(r({ startHour: 5, endHour: 5, days: [0] }), at("2026-11-18T03:00:00Z"))).toBe(false);
  });

  it("endHour 24 covers through 23:59", () => {
    expect(inWindow(r({ startHour: 9, endHour: 24 }), at("2026-11-18T23:59:59Z"))).toBe(true);
    expect(inWindow(r({ startHour: 9, endHour: 24 }), at("2026-11-18T08:59:59Z"))).toBe(false);
  });

  // BUG (cosmetic, owner-facing): windowLabel() formats hour 24 as "12pm" (noon). validateRules accepts endHour 24,
  // so a 9→24 window is enforced correctly (see above) but explained as "9am–12pm", i.e. "until noon".
  it("reason labels endHour 24 as midnight (12am), not noon", () => {
    expect(ev([r({ startHour: 9, endHour: 24 })], {}, {}, at("2026-11-18T08:00:00Z")).reason).toBe("Outside allowed spending hours (9am–12am UTC).");
  });

  it("onViolation: hold", () => expect(ev([r({ onViolation: "hold" })], {}, {}, at("2026-11-18T03:00:00Z")).outcome).toBe("hold"));
});

describe("rateLimit", () => {
  const r: Rule = { id: "rl", kind: "rateLimit", maxPerMinute: 5, action: "pause" };
  it("allows the Nth request in a minute (N-1 prior)", () => {
    const d = ev([r], {}, { requestsLastMinute: 4 });
    expectAllow(d);
    expect(d.triggerPause).toBe(false);
  });
  it("blocks the N+1th and asks the engine to pause the agent", () => {
    const d = ev([r], {}, { requestsLastMinute: 5 });
    expectOnly(d, "block", "rl", "rateLimit", "More than 5 payments in a minute. Agent paused.");
    expect(d.triggerPause).toBe(true);
  });
  it("onViolation: hold still sets triggerPause (the agent is paused even though this one is only held)", () => {
    const d = ev([{ ...r, onViolation: "hold" }], {}, { requestsLastMinute: 99 });
    expect(d.outcome).toBe("hold");
    expect(d.triggerPause).toBe(true);
  });
  it("triggerPause is set even when another rule is what blocks", () => {
    const d = ev([{ id: "ptx", kind: "perTxLimit", maxMicro: 1 }, r], {}, { requestsLastMinute: 5 });
    expect(d.ruleId).toBe("ptx");
    expect(d.triggerPause).toBe(true);
  });
});

describe("approvalThreshold", () => {
  const r: Rule = { id: "ask", kind: "approvalThreshold", aboveMicro: 1_000_000 };
  it("allows exactly at the threshold (strictly 'above')", () => expectAllow(ev([r], { amountMicro: 1_000_000 })));
  it("holds 1 micro above", () =>
    expectOnly(ev([r], { amountMicro: 1_000_001 }), "hold", "ask", "approvalThreshold", "$1.000001 is over $1.00, so it needs your OK."));
  it("onViolation: block", () => expect(ev([{ ...r, onViolation: "block" }], { amountMicro: 2_000_000 }).outcome).toBe("block"));
  it("aboveMicro 0 holds every payment", () => expect(ev([{ ...r, aboveMicro: 0 }], { amountMicro: 1 }).outcome).toBe("hold"));
});

describe("paused", () => {
  it("a paused rule always blocks", () => expectOnly(ev([{ id: "stop", kind: "paused" }]), "block", "stop", "paused", "Spending is paused by the owner."));
  it("a paused rule with onViolation: hold holds instead", () => expect(ev([{ id: "stop", kind: "paused", onViolation: "hold" }]).outcome).toBe("hold"));
  it("agent paused state blocks with ruleId 'paused', even with no rules", () =>
    expectOnly(ev([], {}, { paused: true }), "block", "paused", "paused", "Agent is paused."));
  it("agent paused state is reported ahead of any rule violation", () => {
    const d = ev([{ id: "ptx", kind: "perTxLimit", maxMicro: 1 }], {}, { paused: true });
    expect(d.ruleId).toBe("paused");
    expect(d.violations.map((v) => v.ruleId)).toEqual(["paused", "ptx"]);
  });
});

describe("anomalyGuard", () => {
  const sig = (type: AnomalySignal["type"], severity: AnomalySignal["severity"], explanation = `${type} ${severity}`): AnomalySignal => ({ type, severity, explanation, measured: {} });
  const g = (over: Partial<Extract<Rule, { kind: "anomalyGuard" }>> = {}): Extract<Rule, { kind: "anomalyGuard" }> => ({ id: "ag", kind: "anomalyGuard", ...over });

  it("does nothing without anomalies", () => expectAllow(ev([g()])));
  it("anomalies without a guard never change the decision", () => {
    const d = ev([], {}, { anomalies: [sig("AMOUNT_SPIKE", "high")] });
    expectAllow(d);
    expect(d.anomalies).toHaveLength(1);
  });
  it("default threshold is 'high': medium is ignored", () => expectAllow(ev([g()], {}, { anomalies: [sig("AMOUNT_SPIKE", "medium")] })));
  it("holds on a high signal with its explanation", () =>
    expectOnly(ev([g()], {}, { anomalies: [sig("NEW_RECIPIENT", "high", "First payment to evil.")] }), "hold", "ag", "anomalyGuard", "Unusual activity: First payment to evil."));
  it("minSeverity is inclusive", () => {
    expect(ev([g({ minSeverity: "medium" })], {}, { anomalies: [sig("AMOUNT_SPIKE", "medium")] }).outcome).toBe("hold");
    expectAllow(ev([g({ minSeverity: "medium" })], {}, { anomalies: [sig("AMOUNT_SPIKE", "low")] }));
    expect(ev([g({ minSeverity: "low" })], {}, { anomalies: [sig("AMOUNT_SPIKE", "low")] }).outcome).toBe("hold");
  });
  it("signals filter restricts which types count; empty list = all", () => {
    const a = [sig("AMOUNT_SPIKE", "high")];
    expectAllow(ev([g({ signals: ["FREQUENCY_SPIKE"] })], {}, { anomalies: a }));
    expect(ev([g({ signals: ["AMOUNT_SPIKE"] })], {}, { anomalies: a }).outcome).toBe("hold");
    expect(ev([g({ signals: [] })], {}, { anomalies: a }).outcome).toBe("hold");
  });
  it("reports the most severe signal first, and counts the rest (singular/plural)", () => {
    const two = [sig("AMOUNT_SPIKE", "medium", "m"), sig("NEW_RECIPIENT", "high", "h")];
    expect(ev([g({ minSeverity: "low" })], {}, { anomalies: two }).reason).toBe("Unusual activity: h (+1 more signal)");
    const three = [...two, sig("FREQUENCY_SPIKE", "low", "l")];
    expect(ev([g({ minSeverity: "low" })], {}, { anomalies: three }).reason).toBe("Unusual activity: h (+2 more signals)");
    expect(guardedAnomalies(g({ minSeverity: "low" }), three).map((s) => s.explanation)).toEqual(["h", "m", "l"]);
  });
  it("onViolation: block", () => expect(ev([g({ onViolation: "block" })], {}, { anomalies: [sig("AMOUNT_SPIKE", "high")] }).outcome).toBe("block"));
  it("never overrides a block", () => {
    const d = ev([g(), { id: "ptx", kind: "perTxLimit", maxMicro: 1 }], {}, { anomalies: [sig("AMOUNT_SPIKE", "high")] });
    expect(d.outcome).toBe("block");
    expect(d.ruleId).toBe("ptx");
  });
});

describe("interactions", () => {
  it("every violation is collected, in rule order", () => {
    const rules: Rule[] = [
      { id: "ask", kind: "approvalThreshold", aboveMicro: 0 },
      { id: "cat", kind: "categories", allowed: ["inference"] },
      { id: "ptx", kind: "perTxLimit", maxMicro: 1 },
      { id: "al", kind: "allowlist", recipients: ["x"] },
    ];
    const d = ev(rules);
    expect(d.violations.map((v) => [v.ruleId, v.severity])).toEqual([["ask", "hold"], ["cat", "block"], ["ptx", "block"], ["al", "hold"]]);
  });

  it("block beats hold, regardless of order; the FIRST block in rule order is reported", () => {
    const rules: Rule[] = [
      { id: "ask", kind: "approvalThreshold", aboveMicro: 0 },
      { id: "cat", kind: "categories", allowed: ["inference"] },
      { id: "ptx", kind: "perTxLimit", maxMicro: 1 },
    ];
    expect(ev(rules).ruleId).toBe("cat");
    expect(ev([rules[2]!, rules[1]!, rules[0]!]).ruleId).toBe("ptx");
  });

  it("among holds, the allowlist reason is preferred even if a different hold came first", () => {
    const rules: Rule[] = [
      { id: "ask", kind: "approvalThreshold", aboveMicro: 0 },
      { id: "al", kind: "allowlist", recipients: ["x"] },
    ];
    const d = ev(rules, { recipient: "evil" });
    expect(d.outcome).toBe("hold");
    expect(d.ruleId).toBe("al");
  });

  it("among non-allowlist holds, the first in rule order is reported", () => {
    const rules: Rule[] = [
      { id: "ptx-hold", kind: "perTxLimit", maxMicro: 1, onViolation: "hold" },
      { id: "ask", kind: "approvalThreshold", aboveMicro: 0 },
    ];
    expect(ev(rules).ruleId).toBe("ptx-hold");
  });

  it("an allowlist with onViolation: block is a block, so it beats every hold", () => {
    const rules: Rule[] = [{ id: "ask", kind: "approvalThreshold", aboveMicro: 0 }, { id: "al", kind: "allowlist", recipients: ["x"], onViolation: "block" }];
    expect(ev(rules, { recipient: "evil" })).toMatchObject({ outcome: "block", ruleId: "al" });
  });

  it("budgets: task and period both tight → first in rule order reported, both listed", () => {
    const rules: Rule[] = [
      { id: "day", kind: "periodBudget", period: "day", maxMicro: 1_000_000 },
      { id: "tb", kind: "taskBudget", taskId: "*", maxMicro: 1_000_000 },
    ];
    const d = ev(rules, { amountMicro: 600_000 }, { taskSpentMicro: 500_000, periodSpentMicro: { day: 500_000, week: 500_000, month: 500_000 } });
    expect(d.ruleId).toBe("day");
    expect(d.violations.map((v) => v.ruleId)).toEqual(["day", "tb"]);
  });

  it("an over-budget payment that is also above the approval threshold is blocked, not held (no approve-past-budget)", () => {
    const rules: Rule[] = [
      { id: "ask", kind: "approvalThreshold", aboveMicro: 100_000 },
      { id: "tb", kind: "taskBudget", taskId: "*", maxMicro: 1_000_000 },
    ];
    expect(ev(rules, { amountMicro: 1_000_001 })).toMatchObject({ outcome: "block", ruleId: "tb" });
    expect(ev(rules, { amountMicro: 1_000_000 })).toMatchObject({ outcome: "hold", ruleId: "ask" });
  });

  it("a realistic policy: allow inside every boundary, each limit trips alone", () => {
    const rules: Rule[] = [
      { id: "ptx", kind: "perTxLimit", maxMicro: 2_000_000 },
      { id: "tb", kind: "taskBudget", taskId: "*", maxMicro: 10_000_000 },
      { id: "day", kind: "periodBudget", period: "day", maxMicro: 5_000_000 },
      { id: "cat", kind: "categories", allowed: ["data"] },
      { id: "al", kind: "allowlist", recipients: ["sportsfeed"] },
      { id: "ask", kind: "approvalThreshold", aboveMicro: 1_000_000 },
    ];
    expectAllow(ev(rules, { amountMicro: 1_000_000 }, { taskSpentMicro: 9_000_000, periodSpentMicro: { day: 4_000_000, week: 0, month: 0 } }));
    expect(ev(rules, { amountMicro: 1_500_000 }).ruleId).toBe("ask");
    expect(ev(rules, { amountMicro: 2_000_001 }).ruleId).toBe("ptx");
    expect(ev(rules, { amountMicro: 1_000_000 }, { taskSpentMicro: 9_000_001 }).ruleId).toBe("tb");
    expect(ev(rules, { amountMicro: 1_000_000 }, { periodSpentMicro: { day: 4_000_001, week: 0, month: 0 } }).ruleId).toBe("day");
    expect(ev(rules, { category: "compute" }).ruleId).toBe("cat");
    expect(ev(rules, { recipient: "other" }).ruleId).toBe("al");
  });

  it("an unknown rule kind throws (fail loudly rather than silently allow)", () => {
    expect(() => ev([{ id: "x", kind: "bogus" } as unknown as Rule])).toThrow(/unknown rule/);
  });

  it("decision echoes requestId and timestamp", () => {
    const d = ev([], { requestId: "abc" });
    expect(d.requestId).toBe("abc");
    expect(d.at).toBe(NOW.toISOString());
  });
});

describe("injection flags (warnings only, never change the outcome)", () => {
  it("unknown recipient right after a seller response is flagged; known recipient is not", () => {
    const rules: Rule[] = [{ id: "al", kind: "allowlist", recipients: ["sportsfeed"], onViolation: "hold" }];
    expect(ev(rules, { recipient: "evil", sourceContext: "after response from sportsfeed" }).flags).toEqual(["Requested right after response from sportsfeed: possible injection."]);
    expect(ev(rules, { recipient: "SportsFeed", sourceContext: "after response from sportsfeed" }).flags).toEqual([]);
  });
  it("raw address not on any known list is flagged; no known list at all = no flags", () => {
    const addr = "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e";
    expect(evaluate([], req({ recipient: addr }), state(), { now: NOW, knownRecipients: ["sportsfeed"] }).flags).toEqual(["Raw wallet address, not a known service."]);
    expect(ev([], { recipient: addr }).flags).toEqual([]);
  });
});
