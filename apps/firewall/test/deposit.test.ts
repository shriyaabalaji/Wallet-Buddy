// Deposit target reported to the owner's browser wallet (Settings → Add money): where USDC goes, and when it's off.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { CHAIN_CONFIGS as TESTNET_CONFIGS } from "@circle-fin/x402-batching/client";
// The sellers' mainnet alias (npm:@circle-fin/x402-batching@3.5.0), hoisted to the root node_modules.
import { CHAIN_CONFIGS as MAINNET_CONFIGS } from "x402-batching-mainnet/client";
import { GATEWAY_ON_ARC, depositInfo, payerGatewayBalance } from "../src/deposit";
import { openDb } from "../src/db";
import { createApp } from "../src/server";
import { loadAuth } from "../src/auth";

const EOA = "0x74f1e850fc6c03546e59e6aef7db41ff9f0e318b";

describe("Gateway addresses match Circle's library", () => {
  it("testnet = x402-batching 2.0.4 arcTestnet", () => {
    const c = (TESTNET_CONFIGS as any).arcTestnet;
    expect(GATEWAY_ON_ARC.testnet.chain.id).toBe(c.chain.id);
    expect(GATEWAY_ON_ARC.testnet.usdc.toLowerCase()).toBe(c.usdc.toLowerCase());
    expect(GATEWAY_ON_ARC.testnet.gatewayWallet.toLowerCase()).toBe(c.gatewayWallet.toLowerCase());
    expect(GATEWAY_ON_ARC.testnet.domain).toBe(c.domain);
  });
  it("mainnet = x402-batching 3.5.0 arc", () => {
    const c = (MAINNET_CONFIGS as any).arc;
    expect(GATEWAY_ON_ARC.mainnet.chain.id).toBe(c.chain.id);
    expect(GATEWAY_ON_ARC.mainnet.usdc.toLowerCase()).toBe(c.usdc.toLowerCase());
    expect(GATEWAY_ON_ARC.mainnet.gatewayWallet.toLowerCase()).toBe(c.gatewayWallet.toLowerCase());
    expect(GATEWAY_ON_ARC.mainnet.domain).toBe(c.domain);
  });
});

describe("depositInfo", () => {
  it("is off under simulated payments, whatever else is set", () => {
    const d = depositInfo({ network: "testnet", paymentMode: "circle-agent-wallet", mockPayments: true, circleDepositor: EOA });
    expect(d.enabled).toBe(false);
  });

  it("Agent Wallet: credits the backing EOA, never the wallet address", () => {
    const d = depositInfo({ network: "testnet", paymentMode: "circle-agent-wallet", mockPayments: false, circleDepositor: EOA, localSigner: "0x000000000000000000000000000000000000dEaD" });
    expect(d).toMatchObject({ enabled: true, network: "testnet", chainId: 5042002, depositor: getAddress(EOA) });
  });

  it("Agent Wallet without CIRCLE_GATEWAY_DEPOSITOR (or a malformed one) is off with a fix", () => {
    for (const circleDepositor of [undefined, "", "0x123", "not-an-address"]) {
      const d = depositInfo({ network: "testnet", paymentMode: "circle-agent-wallet", mockPayments: false, circleDepositor });
      expect(d.enabled).toBe(false);
      if (!d.enabled) expect(d.reason).toMatch(/Connect your Circle Agent Wallet/);
    }
  });

  it("mainnet uses Arc mainnet's chain and GatewayWallet", () => {
    const d = depositInfo({ network: "mainnet", paymentMode: "circle-agent-wallet", mockPayments: false, circleDepositor: EOA });
    expect(d).toMatchObject({ enabled: true, network: "mainnet", chainId: 5042, gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE" });
    if (d.enabled) expect(d.rpcUrls.length).toBeGreaterThan(0);
  });

  it("local key: credits the buyer key on testnet, refused on mainnet", () => {
    const signer = "0x000000000000000000000000000000000000dEaD";
    expect(depositInfo({ network: "testnet", paymentMode: "local-key", mockPayments: false, localSigner: signer })).toMatchObject({ enabled: true, depositor: signer });
    expect(depositInfo({ network: "mainnet", paymentMode: "local-key", mockPayments: false, localSigner: signer }).enabled).toBe(false);
    expect(depositInfo({ network: "testnet", paymentMode: "local-key", mockPayments: false, localSigner: null }).enabled).toBe(false);
  });
});

describe("payerGatewayBalance (Circle Gateway API, no key)", () => {
  const on = depositInfo({ network: "testnet", paymentMode: "local-key", mockPayments: false, localSigner: "0x000000000000000000000000000000000000dEaD" });
  const fake = (status: number, body: unknown) => {
    const calls: { url: string; body: any }[] = [];
    const f = (async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    return { f, calls };
  };

  it("asks Circle for the depositor on Arc's domain and reads the balance", async () => {
    const { f, calls } = fake(200, { token: "USDC", balances: [{ domain: 26, depositor: "0xdead", balance: "5.000000", pendingBatch: "0" }] });
    expect(await payerGatewayBalance(on, { fetchImpl: f, cacheMs: 0 })).toEqual({ depositor: on.enabled && on.depositor, availableUsdc: 5 });
    expect(calls[0]!.url).toBe("https://gateway-api-testnet.circle.com/v1/balances");
    expect(calls[0]!.body).toEqual({ token: "USDC", sources: [{ depositor: on.enabled && on.depositor, domain: 26 }] });
  });

  it("mainnet goes to Circle's mainnet API", async () => {
    const main = depositInfo({ network: "mainnet", paymentMode: "circle-agent-wallet", mockPayments: false, circleDepositor: EOA });
    const { f, calls } = fake(200, { balances: [{ balance: "1.5" }] });
    expect(await payerGatewayBalance(main, { fetchImpl: f, cacheMs: 0 })).toMatchObject({ availableUsdc: 1.5 });
    expect(calls[0]!.url).toBe("https://gateway-api.circle.com/v1/balances");
  });

  it("reports errors instead of a made-up number", async () => {
    expect(await payerGatewayBalance(on, { fetchImpl: fake(500, { message: "down" }).f, cacheMs: 0 })).toMatchObject({ error: "down" });
    expect(await payerGatewayBalance(on, { fetchImpl: fake(200, { balances: [] }).f, cacheMs: 0 })).toMatchObject({ error: expect.stringMatching(/no balance/) });
  });

  it("nothing to read without a real payer", async () => {
    expect(await payerGatewayBalance(depositInfo({ network: "testnet", paymentMode: "local-key", mockPayments: true, localSigner: "0x000000000000000000000000000000000000dEaD" }))).toBeNull();
  });
});

describe("GET /health", () => {
  const OWNER = randomBytes(32).toString("base64url");
  const AGENT = randomBytes(32).toString("base64url");
  const db = openDb(join(mkdtempSync(join(tmpdir(), "dep-")), "d.db"));
  const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${AGENT}` }));
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const health = async (token?: string) => (await (await fetch(`${base}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).json()) as any;

  it("shows the deposit target to the owner only", async () => {
    expect((await health(OWNER)).deposit).toHaveProperty("enabled");
    expect(await health(OWNER)).toHaveProperty("gateway");
    expect(await health()).toEqual({ ok: true });
    expect((await health(AGENT)).deposit).toBeUndefined();
  });
});
