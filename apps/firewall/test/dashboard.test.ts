// Owner dashboard endpoints: agent list, registration, totals/series, activity filters, and their authorization.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { policyHash, usdToMicro, type Rule } from "@agent-firewall/policy";
import { openDb } from "../src/db";
import { createApp } from "../src/server";
import { loadAuth } from "../src/auth";
import { evaluateAndReserve, markSettled, savePolicy } from "../src/engine";

const tok = () => randomBytes(32).toString("base64url");
const OWNER = tok();
const ALICE = tok(); // research-agent
const BOB = tok(); // race-agent
const db = openDb(join(mkdtempSync(join(tmpdir(), "dash-")), "d.db"));
const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${ALICE},race-agent=${BOB}` }));
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
const agentRow = (id: string) => db.prepare("SELECT id FROM agents WHERE id=?").get(id);

describe("empty state", () => {
  it("lists no agents on a fresh firewall, and viewing or pausing an unknown agent registers nothing", async () => {
    expect((await call("GET", "/v1/agents", OWNER)).json).toEqual({ agents: [] });
    expect((await call("GET", "/v1/agents/ghost/summary", OWNER)).status).toBe(404);
    expect((await call("POST", "/v1/agents/ghost/pause", OWNER, {})).status).toBe(404);
    expect((await call("POST", "/v1/agents/ghost/resume", OWNER, {})).status).toBe(404);
    expect(agentRow("ghost")).toBeUndefined();
  });
});

describe("registration", () => {
  it("owner registers an agent (firewall row only, no wallet); duplicates and bad ids are refused", async () => {
    const r = await call("POST", "/v1/agents", OWNER, { id: "research-agent", name: "Research agent" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ agent: { id: "research-agent", name: "Research agent", status: "active" }, wallet: null });
    expect((await call("POST", "/v1/agents", OWNER, { id: "research-agent" })).status).toBe(409);
    expect((await call("POST", "/v1/agents", OWNER, { id: "bad id/../x" })).status).toBe(400);
    expect((await call("POST", "/v1/agents", ALICE, { id: "sneaky" })).status).toBe(403);
    expect((await call("POST", "/v1/agents", undefined, { id: "sneaky" })).status).toBe(401);
    expect(agentRow("sneaky")).toBeUndefined();
  });
});

describe("agent list and totals", () => {
  const rules: Rule[] = [
    { id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(10) },
    { id: "daily", kind: "periodBudget", period: "day", maxMicro: usdToMicro(5) },
    { id: "ask", kind: "approvalThreshold", aboveMicro: usdToMicro(1) },
    { id: "max", kind: "perTxLimit", maxMicro: usdToMicro(4) },
  ];
  const ev = (agentId: string, id: string, usd: number, recipient = "sportsfeed") =>
    evaluateAndReserve(db, { requestId: id, agentId, taskId: "t1", recipient, amountMicro: usdToMicro(usd), category: "data", purpose: id });

  beforeAll(() => {
    savePolicy(db, "research-agent", rules, policyHash(rules));
    savePolicy(db, "race-agent", rules, policyHash(rules));
    ev("research-agent", "paid-1", 0.5);
    markSettled(db, "paid-1");
    ev("research-agent", "reserved-1", 0.25); // allowed, not confirmed: in progress, NOT paid
    ev("research-agent", "held-1", 2, "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e");
    ev("research-agent", "blocked-1", 9);
    ev("race-agent", "race-1", 0.8);
  });

  it("separates paid, in-progress, held and stopped money; counts decisions; computes available budget", async () => {
    const r = await call("GET", "/v1/agents", OWNER);
    expect(r.status).toBe(200);
    const a = r.json.agents.find((x: any) => x.id === "research-agent");
    expect(a.today).toMatchObject({
      paidMicro: 500_000, inProgressMicro: 250_000, heldMicro: 2_000_000, stoppedMicro: 9_000_000,
      counts: { requests: 4, allowed: 2, held: 1, blocked: 1, ownerApproved: 0 },
    });
    // Budgets count paid + in progress + held, like the engine: $2.75 of $5 today.
    expect(a.budget).toMatchObject({ daySpentMicro: 2_750_000, dayCapMicro: 5_000_000, dayAvailableMicro: 2_250_000, taskBudgetMicro: 10_000_000, taskAvailableMicro: 7_250_000 });
    expect(a).toMatchObject({ status: "active", hasPolicy: true, credentialConfigured: true, pendingApprovals: 1, currentTask: "t1" });
    expect(a.anomalies24h.requests).toBeGreaterThan(0);
    const race = r.json.agents.find((x: any) => x.id === "race-agent");
    expect(race.today.inProgressMicro).toBe(800_000); // other agents' money never leaks into this one's totals
    expect(r.json.agents.map((x: any) => x.id).sort()).toEqual(["race-agent", "research-agent"]);
  });

  it("is owner-only, and no response carries a credential", async () => {
    expect((await call("GET", "/v1/agents", ALICE)).status).toBe(403);
    expect((await call("GET", "/v1/agents")).status).toBe(401);
    const text = JSON.stringify((await call("GET", "/v1/agents", OWNER)).json);
    for (const t of [OWNER, ALICE, BOB]) expect(text).not.toContain(t);
  });

  it("summary carries the same totals and an 8-hour series for the selected agent only", async () => {
    const s = (await call("GET", "/v1/agents/research-agent/summary", OWNER)).json;
    expect(s.totals.paidMicro).toBe(500_000);
    expect(s.series).toHaveLength(8);
    const last = s.series[7];
    expect(last).toMatchObject({ paidMicro: 500_000, inProgressMicro: 2_250_000, stoppedMicro: 9_000_000, paid: 1, inProgress: 2, stopped: 1 });
    expect(s.series.slice(0, 7).every((b: any) => b.paid + b.inProgress + b.stopped === 0)).toBe(true);
    // An agent may read its own summary, never another's.
    expect((await call("GET", "/v1/agents/research-agent/summary", BOB)).status).toBe(403);
  });

  it("activity filters by agent (or all), status group, anomalies and requestId; old callers keep working", async () => {
    const ids = async (q: string) => (await call("GET", `/v1/activity?${q}`, OWNER)).json.items.map((i: any) => i.requestId).sort();
    expect(await ids("")).toEqual(["blocked-1", "held-1", "paid-1", "reserved-1"]); // default agent, as before
    expect(await ids("agentId=all")).toEqual(["blocked-1", "held-1", "paid-1", "race-1", "reserved-1"]);
    expect(await ids("agentId=race-agent")).toEqual(["race-1"]);
    expect(await ids("agentId=research-agent&status=paid")).toEqual(["paid-1"]);
    expect(await ids("agentId=research-agent&status=pending")).toEqual(["reserved-1"]);
    expect(await ids("agentId=all&status=held")).toEqual(["held-1"]);
    expect(await ids("agentId=research-agent&filter=blocked")).toEqual(["blocked-1", "held-1"]);
    expect(await ids("agentId=all&requestId=race-1")).toEqual(["race-1"]);
    const flagged = (await call("GET", "/v1/activity?agentId=all&anomalies=1", OWNER)).json.items;
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((i: any) => i.anomalies.length > 0)).toBe(true);
    const one = (await call("GET", "/v1/activity?agentId=all&requestId=held-1", OWNER)).json.items[0];
    expect(one).toMatchObject({ agentId: "research-agent", taskId: "t1", outcome: "hold", status: "held" });
    expect((await call("GET", "/v1/activity?agentId=all", ALICE)).status).toBe(403);
  });
});
