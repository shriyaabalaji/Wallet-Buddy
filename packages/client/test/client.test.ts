import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFirewallClient, requestPayment } from "../src/index";

const NETWORK = "eip155:5042002";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const AMOUNT = "10000";
const TOKEN = "t".repeat(40);

interface Call { method: string; path: string; body: any; auth?: string; paymentSignature?: string }

// ---------- fake seller: x402 402 on /item, 200 on /free ----------
const sellerCalls: Call[] = [];
const required = {
  x402Version: 2,
  resource: { url: "/item", description: "test item" },
  accepts: [
    { scheme: "exact", network: "eip155:1", amount: "1", payTo: "0x2222222222222222222222222222222222222222", extra: { name: "Other" } },
    { scheme: "exact", network: NETWORK, amount: AMOUNT, payTo: PAY_TO, maxTimeoutSeconds: 345600, extra: { name: "GatewayWalletBatched" } },
  ],
};

// ---------- fake firewall ----------
const fwCalls: Call[] = [];
let signer: { address: string | null; mode: string; network: string };
let decision: Record<string, unknown> | { status: number; error: string };

const readBody = (req: IncomingMessage) =>
  new Promise<any>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s ? JSON.parse(s) : undefined));
  });
const json = (res: ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(v));
};

let seller: Server;
let firewall: Server;
let SELLER = "";
let FW = "";

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeAll(async () => {
  seller = createServer(async (req, res) => {
    const sig = req.headers["payment-signature"] as string | undefined;
    sellerCalls.push({ method: req.method!, path: req.url!, body: undefined, paymentSignature: sig });
    if (req.url === "/free") return json(res, 200, { free: true });
    if (req.url === "/item") {
      if (!sig) {
        res.writeHead(402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") });
        return res.end();
      }
      const settle = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc" })).toString("base64");
      return json(res, 200, { report: "paid content" }, { "PAYMENT-RESPONSE": settle });
    }
    json(res, 404, { error: "not found" });
  });
  firewall = createServer(async (req, res) => {
    const body = await readBody(req);
    fwCalls.push({ method: req.method!, path: req.url!, body, auth: req.headers.authorization });
    const url = req.url!;
    if (url === "/v1/signer") return json(res, 200, { ...signer, arcNetwork: "arc-testnet" });
    if (url === "/v1/payments/evaluate") {
      if ("status" in decision) return json(res, decision.status as number, { error: decision.error });
      return json(res, 200, { requestId: body.requestId, duplicate: false, policyHash: "0x00", ...decision });
    }
    if (/^\/v1\/payments\/[^/]+\/pay$/.test(url)) return json(res, 200, { body: JSON.stringify({ report: "paid via circle wallet", url: body.url }) });
    if (/^\/v1\/payments\/[^/]+\/(settled|failed)$/.test(url)) return json(res, 200, { ok: true });
    if (/^\/v1\/agents\/[^/]+\/summary$/.test(url)) return json(res, 200, { agent: { id: "test-agent" }, task: { spentMicro: 0 } });
    json(res, 404, { error: "not found" });
  });
  [SELLER, FW] = await Promise.all([listen(seller), listen(firewall)]);
});

afterAll(async () => {
  await Promise.all([new Promise((r) => seller.close(r)), new Promise((r) => firewall.close(r))]);
});

beforeEach(() => {
  sellerCalls.length = 0;
  fwCalls.length = 0;
  signer = { address: "0x3333333333333333333333333333333333333333", mode: "circle-agent-wallet", network: NETWORK };
  decision = { outcome: "allow", reason: "Within budget", flags: [] };
});

const client = () => createFirewallClient({ firewallUrl: FW, agentId: "test-agent", token: TOKEN });
const req = (over: Partial<Parameters<ReturnType<typeof client>["requestPayment"]>[0]> = {}) => ({
  url: `${SELLER}/item`, category: "data" as const, purpose: "An injury report", taskId: "task-1", ...over,
});
const evaluateCall = () => fwCalls.find((c) => c.path === "/v1/payments/evaluate");

describe("createFirewallClient().requestPayment", () => {
  it("allow → paid via the circle-agent-wallet /pay path", async () => {
    decision = { outcome: "allow", reason: "Within budget", flags: ["NEW_RECIPIENT"] };
    const r = await client().requestPayment(req({ requestId: "req_fixed" }));
    expect(r).toMatchObject({
      outcome: "allow", reason: "Within budget", requestId: "req_fixed", flags: ["NEW_RECIPIENT"],
      amountMicro: 10000, data: { report: "paid via circle wallet", url: `${SELLER}/item` },
    });
    expect(typeof r.decisionMs).toBe("number");
    const pay = fwCalls.find((c) => c.path === "/v1/payments/req_fixed/pay");
    expect(pay?.body).toEqual({ url: `${SELLER}/item` });
    expect(pay?.auth).toBe(`Bearer ${TOKEN}`);
    expect(evaluateCall()?.body).toMatchObject({ requestId: "req_fixed", agentId: "test-agent", taskId: "task-1", amountMicro: 10000, category: "data", purpose: "An injury report" });
    // The firewall pays: the client never sends a payment header to the seller, and never reports settlement itself.
    expect(sellerCalls.every((c) => !c.paymentSignature)).toBe(true);
    expect(fwCalls.some((c) => /\/(settled|failed)$/.test(c.path))).toBe(false);
  });

  it("recipient defaults to the seller's 402 payTo", async () => {
    await client().requestPayment(req());
    expect(evaluateCall()?.body.recipient).toBe(PAY_TO);
  });

  it("an explicit recipient is passed through unchanged", async () => {
    await client().requestPayment(req({ recipient: "sportsfeed", sourceContext: "after response from x" }));
    expect(evaluateCall()?.body).toMatchObject({ recipient: "sportsfeed", sourceContext: "after response from x" });
  });

  it("block → outcome block with reason and flags, nothing paid", async () => {
    decision = { outcome: "block", reason: "Recipient not on the allowlist", flags: ["NEW_RECIPIENT", "AMOUNT_SPIKE"] };
    const r = await client().requestPayment(req());
    expect(r).toMatchObject({ outcome: "block", reason: "Recipient not on the allowlist", flags: ["NEW_RECIPIENT", "AMOUNT_SPIKE"], amountMicro: 10000 });
    expect(r.requestId).toMatch(/^req_/);
    expect(r.data).toBeUndefined();
    expect(fwCalls.some((c) => /\/(pay|sign)$/.test(c.path))).toBe(false);
  });

  it("hold → outcome hold, nothing paid", async () => {
    decision = { outcome: "hold", reason: "Over $0.50: the owner was asked to approve", flags: [] };
    const r = await client().requestPayment(req());
    expect(r).toMatchObject({ outcome: "hold", reason: "Over $0.50: the owner was asked to approve", flags: [] });
    expect(fwCalls.some((c) => /\/(pay|sign)$/.test(c.path))).toBe(false);
  });

  it("seller that doesn't answer 402 → error, firewall never asked", async () => {
    const r = await client().requestPayment(req({ url: `${SELLER}/free` }));
    expect(r).toMatchObject({ outcome: "error", reason: "expected 402, got 200" });
    expect(evaluateCall()).toBeUndefined();
  });

  it("firewall refusing the credential → error, not a throw", async () => {
    decision = { status: 401, error: "Missing or invalid credential." };
    const r = await client().requestPayment(req());
    expect(r).toMatchObject({ outcome: "error", reason: "Missing or invalid credential." });
  });

  it("unreachable firewall → error, not a throw", async () => {
    const r = await createFirewallClient({ firewallUrl: "http://127.0.0.1:1", agentId: "a" }).requestPayment(req());
    expect(r.outcome).toBe("error");
  });

  it("local-key mode with MOCK payments: pays the seller with a mock header and reports /settled", async () => {
    signer = { address: null, mode: "local-key", network: NETWORK };
    const r = await createFirewallClient({ firewallUrl: FW, agentId: "test-agent", token: TOKEN, mockPayments: true }).requestPayment(req({ requestId: "req_mock" }));
    expect(r).toMatchObject({ outcome: "allow", data: { report: "paid content" } });
    const paid = sellerCalls.find((c) => c.paymentSignature);
    expect(JSON.parse(Buffer.from(paid!.paymentSignature!, "base64").toString())).toEqual({ mock: true, requestId: "req_mock" });
    expect(fwCalls.find((c) => c.path === "/v1/payments/req_mock/settled")?.body).toEqual({ txHash: "0xabc" });
  });

  it("local-key mode with no signer and no mock → error and /failed releases the reservation", async () => {
    signer = { address: null, mode: "local-key", network: NETWORK };
    const r = await client().requestPayment(req({ requestId: "req_nosigner" }));
    expect(r).toMatchObject({ outcome: "error", reason: "firewall has no signer configured" });
    expect(fwCalls.some((c) => c.path === "/v1/payments/req_nosigner/failed")).toBe(true);
  });

  it("one-shot requestPayment works the same", async () => {
    const r = await requestPayment({ firewallUrl: FW, agentId: "test-agent", token: TOKEN, ...req() });
    expect(r.outcome).toBe("allow");
  });
});

describe("quote and summary", () => {
  it("quote reads the seller's 402 without touching /evaluate", async () => {
    expect(await client().quote(`${SELLER}/item`)).toEqual({ amountMicro: 10000, payTo: PAY_TO });
    expect(await client().quote(`${SELLER}/free`)).toBeNull();
    expect(evaluateCall()).toBeUndefined();
  });

  it("summary calls the agent's own summary with its token", async () => {
    expect(await client().summary()).toMatchObject({ agent: { id: "test-agent" } });
    const call = fwCalls.find((c) => c.path === "/v1/agents/test-agent/summary");
    expect(call?.auth).toBe(`Bearer ${TOKEN}`);
  });
});
