// HTTP-level authorization tests: a real createApp() server on an ephemeral port.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import type { Rule } from "@agent-firewall/policy";

const KEY = generatePrivateKey();
const SELLER = privateKeyToAccount(generatePrivateKey()).address;
process.env.BUYER_PRIVATE_KEY = KEY;
process.env.PAYMENT_MODE = "local-key"; // exercise /sign end to end
process.env.SELLER_ADDRESSES = `sportsfeed=${SELLER}`;

const { openDb } = await import("../src/db");
const { createApp } = await import("../src/server");
const { loadAuth, authenticate } = await import("../src/auth");

const tok = () => randomBytes(32).toString("base64url");
const OWNER = tok();
const ALICE = tok(); // research-agent
const BOB = tok(); // race-agent
const SERVICE = tok();
const auth = loadAuth({
  FIREWALL_OWNER_TOKEN: OWNER,
  FIREWALL_AGENT_TOKENS: `research-agent=${ALICE},race-agent=${BOB}`,
  FIREWALL_SERVICE_TOKEN: SERVICE,
});

const db = openDb(join(mkdtempSync(join(tmpdir(), "auth-")), "a.db"));
const server = createApp(db, auth);
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

const rules = (extra: Rule[] = []): Rule[] => [
  { id: "task", kind: "taskBudget", taskId: "*", maxMicro: 10_000_000 },
  { id: "ask-first", kind: "approvalThreshold", aboveMicro: 1_000_000 },
  { id: "approved", kind: "allowlist", recipients: ["sportsfeed"] },
  ...extra,
];
const savePolicy = (agentId: string, token: string | undefined, r: Rule[] = rules()) =>
  call("POST", "/v1/policy", token, { agentId, confirmed: true, rules: r, notify: { phone: "+15125550100", events: ["hold"] } });
const evaluate = (token: string | undefined, agentId: string, requestId: string, amountMicro = 20_000, recipient = "sportsfeed") =>
  call("POST", "/v1/payments/evaluate", token, { requestId, agentId, taskId: "t1", recipient, amountMicro, category: "data", purpose: "test" });
const policyHash = async (agentId: string) => (await call("GET", `/v1/policy/${agentId}`, OWNER)).json.policy?.hash ?? null;
const row = (id: string) => db.prepare("SELECT status, signed_ms FROM requests WHERE request_id=?").get(id) as { status: string; signed_ms: number | null };

beforeAll(async () => {
  expect((await savePolicy("research-agent", OWNER)).status).toBe(200);
  expect((await savePolicy("race-agent", OWNER)).status).toBe(200);
});

describe("owner-only routes", () => {
  it("1. an unauthenticated request cannot change policies, even with confirmed:true", async () => {
    const before = await policyHash("research-agent");
    const r = await savePolicy("research-agent", undefined, [{ id: "task", kind: "taskBudget", taskId: "*", maxMicro: 999_000_000 }]);
    expect(r.status).toBe(401);
    expect(await policyHash("research-agent")).toBe(before);
  });

  it("rejects a garbage or malformed credential with 401", async () => {
    expect((await savePolicy("research-agent", tok())).status).toBe(401);
    const r = await call("POST", "/v1/policy", undefined, { agentId: "research-agent", confirmed: true, rules: rules() }, { Authorization: `Basic ${OWNER}` });
    expect(r.status).toBe(401);
  });

  it("2. an agent cannot change its own policy, resume itself, or read owner data", async () => {
    const before = await policyHash("research-agent");
    expect((await savePolicy("research-agent", ALICE, [])).status).toBe(403);
    expect(await policyHash("research-agent")).toBe(before);

    expect((await call("POST", "/v1/agents/research-agent/pause", OWNER, {})).status).toBe(200);
    expect((await call("POST", "/v1/agents/research-agent/resume", ALICE, {})).status).toBe(403);
    expect((await call("POST", "/v1/agents/research-agent/resume", undefined, {})).status).toBe(401);
    expect((await call("GET", "/v1/agents/research-agent/summary", OWNER)).json.agent.status).toBe("paused");
    expect((await call("POST", "/v1/agents/research-agent/resume", OWNER, {})).status).toBe(200);

    for (const [m, p, b] of [
      ["GET", "/v1/activity?agentId=research-agent", undefined],
      ["GET", "/v1/policy/research-agent", undefined],
      ["POST", "/v1/rules/compile", { text: "Up to $10" }],
      ["POST", "/v1/rules/dry-run", { rules: rules() }],
      ["POST", "/v1/owner/passkey/options", {}],
      ["POST", "/v1/owner/passkey", { response: {} }],
      ["POST", "/v1/agents/research-agent/pause", {}],
    ] as const) {
      expect((await call(m, p, ALICE, b)).status, `${m} ${p} as agent`).toBe(403);
      expect((await call(m, p, SERVICE, b)).status, `${m} ${p} as service`).toBe(403);
      expect((await call(m, p, undefined, b)).status, `${m} ${p} anonymous`).toBe(401);
    }
  });

  it("4. an authenticated owner can modify policies", async () => {
    const r = await savePolicy("research-agent", OWNER, rules([{ id: "daily", kind: "periodBudget", period: "day", maxMicro: 500_000_000 }]));
    expect(r.status).toBe(200);
    expect(await policyHash("research-agent")).toBe(r.json.policy.hash);
    expect((await call("POST", "/v1/policy", OWNER, { agentId: "research-agent", rules: rules() })).status).toBe(400); // still needs confirmed:true
  });

  it("5. owner credentials never appear in firewall responses", async () => {
    const h = await call("GET", "/health", OWNER);
    expect(h.status).toBe(200);
    expect(h.json.auth).toEqual({ owner: true, agents: ["research-agent", "race-agent"], service: true, unauthenticatedAgents: false });
    for (const r of [h, await call("GET", "/v1/agents/research-agent/summary", OWNER), await call("GET", "/v1/policy/research-agent", OWNER)]) {
      for (const secret of [OWNER, ALICE, BOB, SERVICE]) expect(r.text).not.toContain(secret);
    }
  });

  it("a malformed %-escape is a 400, not a crash of the whole firewall", async () => {
    expect((await call("GET", "/v1/approvals/%E0%A4%A")).status).toBe(400);
    expect((await call("POST", "/v1/payments/%ZZ/sign", ALICE, { typedData: {} })).status).toBe(400);
    expect((await call("GET", "/health")).status).toBe(200); // still up
  });

  it("public /health reveals only liveness", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });
});

describe("agent routes", () => {
  it("6. a valid evaluate → reserve → sign flow still works for the owning agent", async () => {
    const id = `req_ok_${Date.now()}`;
    const d = await evaluate(ALICE, "research-agent", id);
    expect(d.status).toBe(200);
    expect(d.json.outcome).toBe("allow");
    expect(row(id).status).toBe("reserved");
    // Idempotent replay by the same agent returns the same decision.
    const again = await evaluate(ALICE, "research-agent", id);
    expect(again.json).toMatchObject({ outcome: "allow", duplicate: true });

    // Full x402 signature over HTTP with the real BatchEvmScheme, as the demo agent does it.
    const signer = (await call("GET", "/v1/signer")).json;
    const scheme = new BatchEvmScheme({
      address: signer.address,
      signTypedData: async (td) => {
        const r = await call("POST", `/v1/payments/${id}/sign`, ALICE, { typedData: JSON.parse(JSON.stringify(td, (_, x) => (typeof x === "bigint" ? x.toString() : x))) });
        if (r.status !== 200) throw new Error(r.json.error);
        return r.json.signature;
      },
    });
    await scheme.createPaymentPayload(2, {
      scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "20000", payTo: SELLER, maxTimeoutSeconds: 8 * 24 * 3600,
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" },
    } as any);
    expect(row(id).signed_ms).not.toBeNull();
    expect((await call("POST", `/v1/payments/${id}/settled`, ALICE, { txHash: "0xabc" })).json.ok).toBe(true);
    expect(row(id).status).toBe("settled");
  });

  it("B1. a payment reserved before an emergency pause can't be signed until the owner resumes", async () => {
    // Sign over HTTP with the real BatchEvmScheme, as the demo agent does.
    const sign = async (id: string) => {
      const signer = (await call("GET", "/v1/signer")).json;
      const scheme = new BatchEvmScheme({
        address: signer.address,
        signTypedData: async (td) => {
          const r = await call("POST", `/v1/payments/${id}/sign`, ALICE, { typedData: JSON.parse(JSON.stringify(td, (_, x) => (typeof x === "bigint" ? x.toString() : x))) });
          if (r.status !== 200) throw new Error(`${r.status} ${r.json.error}`);
          return r.json.signature;
        },
      });
      await scheme.createPaymentPayload(2, {
        scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "20000", payTo: SELLER, maxTimeoutSeconds: 8 * 24 * 3600,
        extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" },
      } as any);
    };
    const id = `req_pause_${Date.now()}`;
    expect((await evaluate(ALICE, "research-agent", id)).json.outcome).toBe("allow");
    expect((await call("POST", "/v1/agents/research-agent/pause", OWNER, {})).status).toBe(200);

    await expect(sign(id)).rejects.toThrow(/^403 This agent is paused/);
    expect(row(id)).toEqual({ status: "reserved", signed_ms: null }); // still counted, never signed

    // The agent can't lift the pause: not with its own token, another agent's, the service token, or none.
    for (const t of [ALICE, BOB, SERVICE, undefined]) expect((await call("POST", "/v1/agents/research-agent/resume", t, {})).status).not.toBe(200);
    expect((await call("GET", "/v1/agents/research-agent/summary", OWNER)).json.agent.status).toBe("paused");
    // New requests are blocked while paused (unchanged behavior).
    expect((await evaluate(ALICE, "research-agent", `req_pause_new_${Date.now()}`)).json).toMatchObject({ outcome: "block", ruleId: "paused" });
    expect(row(id).signed_ms).toBeNull();

    // Only the owner resumes; then the same reservation can be signed, exactly once.
    expect((await call("POST", "/v1/agents/research-agent/resume", OWNER, {})).status).toBe(200);
    await sign(id);
    expect(row(id).signed_ms).not.toBeNull();
    await expect(sign(id)).rejects.toThrow(/already signed/);
  });

  it("3. an agent cannot impersonate another agent", async () => {
    const r = await evaluate(ALICE, "race-agent", `req_imp_${Date.now()}`);
    expect(r.status).toBe(403);
    expect((await call("GET", "/v1/agents/race-agent/summary", ALICE)).status).toBe(403);
    expect((await evaluate(OWNER, "research-agent", `req_own_${Date.now()}`)).status).toBe(403); // owner isn't a payer
    expect((await evaluate(SERVICE, "research-agent", `req_svc_${Date.now()}`)).status).toBe(403);
    expect((await evaluate(undefined, "research-agent", `req_anon_${Date.now()}`)).status).toBe(401);
  });

  it("7. another agent cannot consume, settle or release someone else's reservation", async () => {
    const id = `req_victim_${Date.now()}`;
    expect((await evaluate(ALICE, "research-agent", id)).json.outcome).toBe("allow");
    for (const path of ["sign", "pay", "settled", "failed"]) {
      const r = await call("POST", `/v1/payments/${id}/${path}`, BOB, { typedData: {}, url: "http://localhost:4200/sportsfeed/injuries" });
      expect(r.status, path).toBe(403);
      expect(r.json.error).toBe("Unknown payment request for this agent.");
    }
    // Replaying the requestId under its own name doesn't leak Alice's decision either.
    expect((await evaluate(BOB, "race-agent", id)).status).toBe(403);
    expect(row(id)).toEqual({ status: "reserved", signed_ms: null });
    // Unknown ids get the same answer as foreign ones (no existence oracle).
    expect((await call("POST", "/v1/payments/req_nope/sign", BOB, { typedData: {} })).json.error).toBe("Unknown payment request for this agent.");
  });

  it("the service token may report outcomes but not evaluate or sign", async () => {
    const id = `req_svc2_${Date.now()}`;
    expect((await evaluate(ALICE, "research-agent", id)).json.outcome).toBe("allow");
    expect((await call("POST", `/v1/payments/${id}/sign`, SERVICE, { typedData: {} })).status).toBe(403);
    expect((await call("POST", `/v1/payments/${id}/failed`, SERVICE, {})).json.ok).toBe(true);
    expect(row(id).status).toBe("released");
  });

  it("an agent's own summary never includes hold tokens", async () => {
    const id = `req_hold_${Date.now()}`;
    expect((await evaluate(ALICE, "research-agent", id, 3_000_000, "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e")).json.outcome).toBe("hold");
    const mine = await call("GET", "/v1/agents/research-agent/summary", ALICE);
    expect(mine.status).toBe(200);
    expect(mine.json.pending.length).toBeGreaterThan(0);
    expect(mine.json.pending.every((h: any) => h.token === undefined)).toBe(true);
    const owner = await call("GET", "/v1/agents/research-agent/summary", OWNER);
    expect(owner.json.pending.some((h: any) => typeof h.token === "string")).toBe(true); // dev-mode Review button
  });
});

describe("8. public approval and webhook flows", () => {
  const holdToken = async () => {
    const id = `req_link_${Date.now()}_${Math.random()}`;
    expect((await evaluate(ALICE, "research-agent", id, 3_000_000, "0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80912c91e")).json.outcome).toBe("hold");
    const s = await call("GET", "/v1/agents/research-agent/summary", OWNER);
    return s.json.pending.find((h: any) => h.requestId === id).token as string;
  };

  it("the approval link works without a login; approving still needs the passkey", async () => {
    const t = await holdToken();
    const view = await call("GET", `/v1/approvals/${t}`);
    expect(view.status).toBe(200);
    expect(view.json.status).toBe("held");
    expect((await call("POST", `/v1/approvals/${t}/approve`, undefined, { assertion: {} })).status).toBe(403);
    const deny = await call("POST", `/v1/approvals/${t}/deny`, undefined, {});
    expect(deny.status).toBe(200);
    expect(deny.json.status).toBe("denied");
    expect((await call("POST", `/v1/approvals/${t}/deny`, undefined, {})).status).toBe(409);
    expect((await call("GET", "/v1/approvals/not-a-real-token")).status).toBe(404);
  });

  it("Twilio NO still cancels the latest hold (dev mode, no Twilio token configured)", async () => {
    const t = await holdToken();
    const r = await call("POST", "/v1/twilio/inbound", undefined, "From=%2B15125550100&Body=No", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Cancelled");
    expect((await call("GET", `/v1/approvals/${t}`)).json.status).toBe("denied");
  });
});

describe("9. missing or broken auth config fails closed", () => {
  it("no tokens configured: owner routes 503, agent routes 401, nothing is open", async () => {
    const empty = loadAuth({});
    const s = createApp(db, empty);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const post = (p: string, body: unknown, t?: string) =>
        fetch(b + p, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.status);
      expect(await post("/v1/policy", { agentId: "research-agent", confirmed: true, rules: [] })).toBe(503);
      expect(await post("/v1/policy", { agentId: "research-agent", confirmed: true, rules: [] }, OWNER)).toBe(503);
      expect(await post("/v1/agents/research-agent/resume", {})).toBe(503);
      expect(await post("/v1/payments/evaluate", { requestId: "x", agentId: "research-agent" })).toBe(401);
      expect(await post("/v1/payments/evaluate", { requestId: "x", agentId: "research-agent" }, ALICE)).toBe(401);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("short, reused or malformed tokens are disabled, not accepted", () => {
    const a = loadAuth({ FIREWALL_OWNER_TOKEN: "short", FIREWALL_AGENT_TOKENS: `research-agent=${OWNER.slice(0, 10)},=${ALICE},bad id=${BOB}` });
    expect(a.owner).toBeNull();
    expect(a.agents).toEqual([]);
    expect(a.problems.length).toBeGreaterThanOrEqual(3);

    const reused = loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${OWNER},race-agent=${BOB}` });
    expect(reused.owner).toBeNull();
    expect(reused.agents.map((x) => x.agentId)).toEqual(["race-agent"]);
    expect(authenticate(`Bearer ${OWNER}`, reused)).toBe("invalid");

    const dup = loadAuth({ FIREWALL_AGENT_TOKENS: `research-agent=${ALICE},research-agent=${BOB}` });
    expect(dup.agents).toEqual([]);
  });

  it("the unauthenticated-agent migration switch is refused in production and on mainnet, and never opens owner routes", async () => {
    expect(loadAuth({ FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS: "1", NODE_ENV: "production" }).allowUnauthenticatedAgents).toBe(false);
    expect(loadAuth({ FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS: "1", NETWORK: "mainnet" }).allowUnauthenticatedAgents).toBe(false);

    const legacy = loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS: "1" });
    expect(legacy.allowUnauthenticatedAgents).toBe(true);
    const s = createApp(db, legacy);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const post = (p: string, body: unknown) => fetch(b + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
      expect(await post("/v1/policy", { agentId: "research-agent", confirmed: true, rules: [] })).toBe(401);
      expect(await post("/v1/agents/research-agent/resume", {})).toBe(401);
      // Legacy agents can still evaluate (old demo agent), but a presented-and-wrong token is still rejected.
      expect(await post("/v1/payments/evaluate", { requestId: `req_legacy_${Date.now()}`, agentId: "research-agent", taskId: "t1", recipient: "sportsfeed", amountMicro: 10_000, category: "data", purpose: "x" })).toBe(200);
      const bad = await fetch(b + "/v1/payments/evaluate", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok()}` }, body: "{}" });
      expect(bad.status).toBe(401);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
