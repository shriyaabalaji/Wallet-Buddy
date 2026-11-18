// Security regressions that close gaps not covered elsewhere (see auth*.test.ts, reservations.test.ts, anomaly.test.ts
// for the rest). Circle-agent-wallet mode, with /bin/echo standing in for `circle services pay` (no money moves).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { policyHash, usdToMicro, type Rule } from "@agent-firewall/policy";

const SF = privateKeyToAccount(generatePrivateKey()).address;
const ST = privateKeyToAccount(generatePrivateKey()).address;
const seller: Server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const [amount, payTo] = path === "/statline/injuries" ? ["50000", ST] : ["20000", SF];
  const required = { x402Version: 2, accepts: [{ network: "eip155:5042002", amount, payTo, extra: { name: "GatewayWalletBatched" } }] };
  res.writeHead(402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") }).end();
});
await new Promise<void>((r) => seller.listen(0, "127.0.0.1", r));
const SELLER_URL = `http://127.0.0.1:${(seller.address() as AddressInfo).port}`;

delete process.env.PAYMENT_MODE;
process.env.CIRCLE_AGENT_WALLET_ADDRESS = privateKeyToAccount(generatePrivateKey()).address;
process.env.CIRCLE_CLI_BIN = "/bin/echo";
process.env.PAY_URL_PREFIXES = SELLER_URL;
process.env.SELLERS_URL = SELLER_URL;
process.env.SELLER_ADDRESSES = `sportsfeed=${SF},statline=${ST}`;

const { openDb } = await import("../src/db");
const { createApp } = await import("../src/server");
const { savePolicy, spendState } = await import("../src/engine");
const { loadAuth } = await import("../src/auth");

const tok = () => randomBytes(32).toString("base64url");
const OWNER = tok(), ALICE = tok(), BOB = tok();
const db = openDb(join(mkdtempSync(join(tmpdir(), "secreg-")), "s.db"));
const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${ALICE},race-agent=${BOB}` }));
let base = "";
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
const rules = (recipients: string[]): Rule[] => [
  { id: "task", kind: "taskBudget", taskId: "*", maxMicro: 3_000_000 },
  { id: "daily", kind: "periodBudget", period: "day", maxMicro: 5_000_000 },
  { id: "approved", kind: "allowlist", recipients, onViolation: "block" },
];
const evaluate = (token: string, agentId: string, requestId: string, amountMicro = 20_000, recipient = "sportsfeed", taskId = "t1") =>
  call("POST", "/v1/payments/evaluate", token, { requestId, agentId, taskId, recipient, amountMicro, category: "data", purpose: "test" });
const status = (id: string) => (db.prepare("SELECT status FROM requests WHERE request_id=?").get(id) as any)?.status;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await call("POST", "/v1/policy", OWNER, { agentId: "research-agent", confirmed: true, rules: rules(["sportsfeed", "statline"]) })).status).toBe(200);
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => seller.close(() => r()));
});

describe("security regressions", () => {
  it("a reservation can't be paid twice (second /pay refused, spend counted once)", async () => {
    expect((await evaluate(ALICE, "research-agent", "dbl")).json.outcome).toBe("allow");
    expect((await call("POST", "/v1/payments/dbl/pay", ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` })).status).toBe(200);
    const again = await call("POST", "/v1/payments/dbl/pay", ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` });
    expect(again.status).toBe(403);
    expect(spendState(db, "research-agent", "t1", new Date()).taskSpentMicro).toBe(20_000);
  });

  it("duplicate requestId never reserves more money, even concurrently", async () => {
    const before = spendState(db, "research-agent", "dup-task", new Date()).taskSpentMicro;
    await Promise.all(Array.from({ length: 8 }, () => evaluate(ALICE, "research-agent", "dup", 300_000, "sportsfeed", "dup-task")));
    expect(spendState(db, "research-agent", "dup-task", new Date()).taskSpentMicro - before).toBe(300_000);
  });

  it("another agent's token can't evaluate, pay or read as research-agent", async () => {
    expect((await evaluate(BOB, "research-agent", "imp")).status).toBe(403);
    expect((await evaluate(ALICE, "research-agent", "mine")).json.outcome).toBe("allow");
    expect((await call("POST", "/v1/payments/mine/pay", BOB, { url: `${SELLER_URL}/sportsfeed/injuries` })).status).toBeGreaterThanOrEqual(403);
    expect(status("mine")).toBe("reserved");
    expect((await call("GET", "/v1/agents/research-agent/summary", BOB)).status).toBe(403);
  });

  it("unapproved recipient is blocked and logged; /pay refuses it", async () => {
    const r = await evaluate(ALICE, "research-agent", "bad", 20_000, "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e");
    expect(r.json.outcome).toBe("block");
    expect(status("bad")).toBe("blocked");
    expect((await call("POST", "/v1/payments/bad/pay", ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` })).status).toBe(403);
  });

  it("agent can't rewrite its rules or resume itself after an emergency pause; requests are refused while paused", async () => {
    expect((await call("POST", "/v1/agents/research-agent/pause", OWNER, { reason: "test" })).status).toBe(200);
    expect((await evaluate(ALICE, "research-agent", "while-paused")).json.outcome).toBe("block");
    expect((await call("POST", "/v1/agents/research-agent/resume", ALICE, {})).status).toBe(403);
    expect((await call("POST", "/v1/policy", ALICE, { agentId: "research-agent", confirmed: true, rules: rules(["anyone"]) })).status).toBe(403);
    expect((await call("POST", "/v1/agents/research-agent/resume", OWNER, {})).status).toBe(200);
  });

  it("the optimizer can't authorize what the firewall rejects: a recommendation creates no reservation, and a later rule change still blocks", async () => {
    const rec = await call("POST", "/v1/optimizer/recommend", ALICE, { agentId: "research-agent", taskId: "opt", need: { category: "data", sku: "injury-report" }, maxAmountMicro: 1_000_000 });
    expect(rec.json.recommended.providerId).toBe("sportsfeed");
    expect(spendState(db, "research-agent", "opt", new Date()).taskSpentMicro).toBe(0);
    // Owner removes sportsfeed after the recommendation; following the stale advice is blocked.
    expect((await call("POST", "/v1/policy", OWNER, { agentId: "research-agent", confirmed: true, rules: rules(["statline"]) })).status).toBe(200);
    expect((await evaluate(ALICE, "research-agent", "stale-advice", 20_000, "sportsfeed", "opt")).json.outcome).toBe("block");
    // A pay call that names a URL whose terms don't match the reservation is refused before paying.
    expect((await evaluate(ALICE, "research-agent", "swap", 50_000, "statline", "opt")).json.outcome).toBe("allow");
    expect((await call("POST", "/v1/payments/swap/pay", ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` })).status).toBe(403);
    expect(status("swap")).toBe("released");
    await call("POST", "/v1/policy", OWNER, { agentId: "research-agent", confirmed: true, rules: rules(["sportsfeed", "statline"]) });
  });
});

describe("daily budget under concurrency, across separate tasks", () => {
  it("6 processes × 10 requests on 60 different tasks never exceed the $1.00 daily cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daily-race-"));
    const path = join(dir, "d.db");
    const d = openDb(path);
    const r: Rule[] = [{ id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(100) }, { id: "daily", kind: "periodBudget", period: "day", maxMicro: usdToMicro(1) }];
    savePolicy(d, "race-agent", r, policyHash(r));
    const startAt = Date.now() + 2000;
    const worker = join(import.meta.dirname, "race-worker.ts");
    const run = promisify(execFile);
    const outs = (await Promise.all(Array.from({ length: 6 }, (_, i) => run(process.execPath, ["--import", "tsx", worker, path, `w${i}`, "10", "30000", String(startAt), "distinct"]))))
      .flatMap((o) => JSON.parse(o.stdout) as string[]);
    expect(outs).toHaveLength(60);
    expect(outs.filter((o) => o === "allow").length).toBe(33);
    expect(spendState(d, "race-agent", "any", new Date()).periodSpentMicro.day).toBeLessThanOrEqual(usdToMicro(1));
  }, 30_000);
});
