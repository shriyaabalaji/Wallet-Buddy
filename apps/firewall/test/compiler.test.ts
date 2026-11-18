import { describe, expect, it } from "vitest";
import { usdToMicro } from "@agent-firewall/policy";
import { compileRules } from "../src/compiler";

describe("offline compiler (no API key)", () => {
  it("compiles the demo sentence", async () => {
    delete process.env.LLM_API_KEY;
    const r = await compileRules("Up to $10 for this task, $5 a day. Text me before anything over $1. Only pay sportsfeed and oddsapi.");
    expect(r.errors).toEqual([]);
    const byKind = Object.fromEntries(r.rules.map((x) => [x.kind, x]));
    expect(byKind.taskBudget).toMatchObject({ maxMicro: usdToMicro(10) });
    expect(byKind.periodBudget).toMatchObject({ period: "day", maxMicro: usdToMicro(5) });
    expect(byKind.approvalThreshold).toMatchObject({ aboveMicro: usdToMicro(1) });
    expect(byKind.allowlist).toMatchObject({ recipients: ["sportsfeed", "oddsapi"] });
  });

  it("flags vague phrases instead of guessing", async () => {
    const r = await compileRules("Pause it if it goes crazy. Only spend between 9am and 9pm.");
    expect(r.ambiguities.map((a) => a.phrase)).toContain("goes crazy");
    expect(r.rules.find((x) => x.kind === "timeWindow")).toMatchObject({ startHour: 9, endHour: 21 });
  });

  it("turns an explicit request about unusual activity into an anomalyGuard rule, and nothing else does", async () => {
    const r = await compileRules("Up to $10 for this task. Hold anything unusual for my OK.");
    expect(r.errors).toEqual([]);
    expect(r.rules.find((x) => x.kind === "anomalyGuard")).toMatchObject({ id: "unusual-activity", minSeverity: "high" });
    const demo = await compileRules("Up to $10 for this task, $5 a day. Text me before anything over $1. Only pay sportsfeed and oddsapi.");
    expect(demo.rules.some((x) => x.kind === "anomalyGuard")).toBe(false);
  });
});
