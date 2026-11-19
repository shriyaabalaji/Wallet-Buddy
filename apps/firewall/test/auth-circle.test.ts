// Authorization in circle-agent-wallet mode (the default payer): the firewall pays and records the outcome itself,
// so an agent may not report /settled or /failed. Separate file because the environment payment mode is read at import.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const SELLER_ADDR = privateKeyToAccount(generatePrivateKey()).address;
// A seller whose 402 probe is slow, so a concurrent agent call lands while /pay is mid-flight.
let releaseProbe: () => void = () => {};
let probes = 0;
const seller: Server = createServer((_req, res) => {
  probes++;
  const required = { x402Version: 2, accepts: [{ network: "eip155:5042002", amount: "20000", payTo: SELLER_ADDR, extra: { name: "GatewayWalletBatched" } }] };
  const send = () => res.writeHead(402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") }).end();
  new Promise<void>((r) => (releaseProbe = r)).then(send);
});
await new Promise<void>((r) => seller.listen(0, "127.0.0.1", r));
const SELLER_URL = `http://127.0.0.1:${(seller.address() as AddressInfo).port}`;

delete process.env.PAYMENT_MODE; // default: circle-agent-wallet
process.env.CIRCLE_AGENT_WALLET_ADDRESS = privateKeyToAccount(generatePrivateKey()).address;
process.env.CIRCLE_CLI_BIN = "/bin/echo"; // stands in for `circle services pay`: succeeds and prints its args
process.env.PAY_URL_PREFIXES = SELLER_URL;
process.env.SELLER_ADDRESSES = `sportsfeed=${SELLER_ADDR}`;

const { openDb } = await import("../src/db");
const { createApp, paymentsInFlight } = await import("../src/server");
const { releaseStaleReservations } = await import("../src/engine");
const { loadAuth } = await import("../src/auth");
const { paymentMode } = await import("../src/payer");

const tok = () => randomBytes(32).toString("base64url");
const OWNER = tok();
const ALICE = tok();
const SERVICE = tok();
const auth = loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${ALICE}`, FIREWALL_SERVICE_TOKEN: SERVICE });
const db = openDb(join(mkdtempSync(join(tmpdir(), "auth-circle-")), "a.db"));
const server = createApp(db, auth);
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = await call("POST", "/v1/policy", OWNER, {
    agentId: "research-agent", confirmed: true,
    rules: [{ id: "task", kind: "taskBudget", taskId: "*", maxMicro: 10_000_000 }, { id: "approved", kind: "allowlist", recipients: ["sportsfeed"] }],
  });
  expect(saved.status).toBe(200);
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => seller.close(() => r()));
});

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
const evaluate = (requestId: string) =>
  call("POST", "/v1/payments/evaluate", ALICE, { requestId, agentId: "research-agent", taskId: "t1", recipient: "sportsfeed", amountMicro: 20_000, category: "data", purpose: "test" });
const row = (id: string) => db.prepare("SELECT status, signed_ms FROM requests WHERE request_id=?").get(id) as { status: string; signed_ms: number | null };

describe("circle-agent-wallet mode", () => {
  it("runs in circle-agent-wallet mode", () => expect(paymentMode()).toBe("circle-agent-wallet"));

  it("an agent can't release its reservation while /pay is in flight (spend stays counted)", async () => {
    const id = `req_race_${Date.now()}`;
    expect((await evaluate(id)).json.outcome).toBe("allow");
    const pay = call("POST", `/v1/payments/${id}/pay`, ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` });
    await new Promise((r) => setTimeout(r, 100)); // /pay is now waiting on the seller probe
    const failed = await call("POST", `/v1/payments/${id}/failed`, ALICE, {});
    expect(failed.status).toBe(403);
    expect(row(id).status).toBe("reserved");
    releaseProbe();
    expect((await pay).status).toBe(200);
    expect(row(id).status).toBe("settled");
    expect(row(id).signed_ms).not.toBeNull();
    // Settled can't be rewritten by the agent either.
    expect((await call("POST", `/v1/payments/${id}/settled`, ALICE, {})).status).toBe(403);
  });

  it("B1. a payment reserved before an emergency pause isn't paid until the owner resumes", async () => {
    const id = `req_pause_${Date.now()}`;
    expect((await evaluate(id)).json.outcome).toBe("allow");
    expect((await call("POST", "/v1/agents/research-agent/pause", OWNER, {})).status).toBe(200);
    const before = probes;
    // Without the check, /pay would wait on the seller probe; bound it so a regression fails instead of hanging.
    const paid = await Promise.race([
      call("POST", `/v1/payments/${id}/pay`, ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` }),
      new Promise<{ status: number; json: any }>((r) => setTimeout(() => r({ status: -1, json: null }), 1000)),
    ]);
    expect(paid.status).toBe(403);
    expect(paid.json.error).toMatch(/paused/);
    expect(probes).toBe(before); // refused before the firewall contacted the seller, let alone ran the CLI
    expect(row(id)).toEqual({ status: "reserved", signed_ms: null });
    expect((await call("POST", "/v1/agents/research-agent/resume", ALICE, {})).status).toBe(403);

    expect((await call("POST", "/v1/agents/research-agent/resume", OWNER, {})).status).toBe(200);
    const pay = call("POST", `/v1/payments/${id}/pay`, ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` });
    await new Promise((r) => setTimeout(r, 100));
    releaseProbe();
    expect((await pay).status).toBe(200);
    expect(row(id).status).toBe("settled");
  });

  it("B3. the reservation timeout skips a /pay that is waiting on the seller, so the payment stays counted", async () => {
    const id = `req_ttl_${Date.now()}`;
    expect((await evaluate(id)).json.outcome).toBe("allow");
    const pay = call("POST", `/v1/payments/${id}/pay`, ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` });
    await new Promise((r) => setTimeout(r, 100)); // /pay is now waiting on the seller probe, signed_ms still NULL
    expect(paymentsInFlight.has(id)).toBe(true);
    // As if the reservation were long past its TTL.
    expect(releaseStaleReservations(db, { now: Date.now() + 3_600_000, ttlMs: 15 * 60_000, inFlight: paymentsInFlight })).not.toContain(id);
    expect((await call("POST", `/v1/payments/${id}/reconcile`, OWNER, { outcome: "not_paid" })).status).toBe(409);
    expect((await call("POST", `/v1/payments/${id}/pay`, ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` })).status).toBe(409); // no second /pay
    releaseProbe();
    expect((await pay).status).toBe(200);
    expect(row(id).status).toBe("settled");
    expect(paymentsInFlight.has(id)).toBe(false);
  });

  // B6: the signed_ms claim requires status='reserved' and an active agent, so a reservation given back mid-probe
  // (even by another process that ignores the in-process guard) can't be paid.
  it("B6: a reservation released mid-probe must not be paid", async () => {
    const id = `req_b6_${Date.now()}`;
    expect((await evaluate(id)).json.outcome).toBe("allow");
    const pay = call("POST", `/v1/payments/${id}/pay`, ALICE, { url: `${SELLER_URL}/sportsfeed/injuries` });
    await new Promise((r) => setTimeout(r, 100));
    releaseStaleReservations(db, { now: Date.now() + 3_600_000, ttlMs: 15 * 60_000 }); // no inFlight guard
    expect(row(id).status).toBe("released");
    releaseProbe();
    const res = await pay;
    expect(res.status).not.toBe(200); // today: 200, the CLI ran and the spend is no longer counted
  });

  it("the service token may still report outcomes", async () => {
    const id = `req_svc_${Date.now()}`;
    expect((await evaluate(id)).json.outcome).toBe("allow");
    expect((await call("POST", `/v1/payments/${id}/failed`, SERVICE, {})).json.ok).toBe(true);
    expect(row(id).status).toBe("released");
  });

  it("an owner can't report outcomes or pay", async () => {
    const id = `req_owner_${Date.now()}`;
    expect((await evaluate(id)).json.outcome).toBe("allow");
    expect((await call("POST", `/v1/payments/${id}/failed`, OWNER, {})).status).toBe(403);
    expect((await call("POST", `/v1/payments/${id}/pay`, OWNER, { url: `${SELLER_URL}/x` })).status).toBe(403);
    expect(row(id).status).toBe("reserved");
  });
});
