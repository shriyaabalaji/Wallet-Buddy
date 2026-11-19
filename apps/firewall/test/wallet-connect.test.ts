// Connecting a Circle Agent Wallet from the dashboard: the firewall drives Circle's CLI (a stand-in script here that
// behaves like @circle-fin/cli 1.4.0's JSON output), and the connected wallet becomes the payer at runtime.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { policyHash, usdToMicro, type Rule } from "@agent-firewall/policy";

const dir = mkdtempSync(join(tmpdir(), "circle-cli-"));
const STATE = join(dir, "state.json");
const LOG = join(dir, "calls.log");
const WALLET = privateKeyToAccount(generatePrivateKey()).address;
const EOA = privateKeyToAccount(generatePrivateKey()).address;
const CLI = join(dir, "circle");
// Stand-in for Circle's CLI: terms gate, two-step email login (code 123456), wallet list, gateway balance.
writeFileSync(CLI, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(args) + "\\n");
let st = {}; try { st = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, "utf8")); } catch {}
const save = () => fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(st));
const out = (data) => { process.stdout.write(JSON.stringify({ data }, null, 2) + "\\n"); };
const fail = (code, message) => { process.stdout.write(JSON.stringify({ error: { code, message } }) + "\\n"); process.stderr.write("Error: " + message + "\\n"); process.exit(1); };
if (args[0] === "--version") { process.stdout.write("1.4.0\\n"); process.exit(0); }
if (args[0] === "terms" && args[1] === "show") out({ accepted: !!st.terms, currentVersion: "1", termsOfUseUrl: "https://agents.circle.com/terms-of-use", privacyPolicyUrl: "https://www.circle.com/legal/privacy-policy", acceptance: null });
else if (args[0] === "terms" && args[1] === "accept") { st.terms = true; save(); out({ message: "Terms accepted." }); }
else if (!st.terms) fail("PERMISSION_DENIED", "Circle CLI Terms acceptance is required before use.");
else if (args[0] === "wallet" && args[1] === "login" && args.includes("--init")) { st.request = "req-" + Date.now(); st.email = args[2]; st.testnet = args.includes("--testnet"); save(); out({ message: "OTP code sent to " + args[2] + "\\nPlease run: circle wallet login --request " + st.request + " --otp <code>", warning: "Never give an AI agent access to your email." }); }
else if (args[0] === "wallet" && args[1] === "login" && args.includes("--request")) {
  const id = args[args.indexOf("--request") + 1], otp = args[args.indexOf("--otp") + 1];
  if (id !== st.request) fail("INTERNAL", "Invalid or expired request ID");
  if (!/^(B1X-)?123456$/.test(otp)) fail("INTERNAL", "Invalid or expired OTP code");
  st.session = { email: st.email, testnet: st.testnet }; save(); out({ message: "Logged in as " + st.email });
}
else if (args[0] === "wallet" && args[1] === "status") { if (!st.session) fail("AUTH_REQUIRED", "Not logged in"); const s = { email: st.session.email, tokenStatus: "VALID", expiresIn: "6d" }; out({ type: "agent", mainnet: st.session.testnet ? { tokenStatus: "NOT_LOGGED_IN" } : s, testnet: st.session.testnet ? s : { tokenStatus: "NOT_LOGGED_IN" } }); }
else if (args[0] === "wallet" && args[1] === "list") { if (!st.session) fail("AUTH_REQUIRED", "Not logged in (or session expired)."); out({ wallets: [{ type: "agent", name: "agent-1", address: ${JSON.stringify(WALLET.toLowerCase())}, blockchain: args[args.indexOf("--chain") + 1] }] }); }
else if (args[0] === "gateway" && args[1] === "balance") out({ address: args[args.indexOf("--address") + 1], backingEOA: ${JSON.stringify(EOA.toLowerCase())}, total: "0", balances: [] });
else fail("INVALID_ARGUMENT", "unexpected " + args.join(" "));
`);
chmodSync(CLI, 0o755);

process.env.PAYMENT_MODE = "local-key"; // like a fresh local setup: the buyer key signs until a wallet is connected
process.env.BUYER_PRIVATE_KEY = generatePrivateKey();
process.env.CIRCLE_CLI_BIN = CLI;
delete process.env.CIRCLE_AGENT_WALLET_ADDRESS;
delete process.env.CIRCLE_GATEWAY_DEPOSITOR;
delete process.env.MOCK_PAYMENTS;

const { openDb } = await import("../src/db");
const { createApp } = await import("../src/server");
const { loadAuth } = await import("../src/auth");
const { resetConnectState } = await import("../src/circle-connect");
const { paymentMode, loadConnectedWallet } = await import("../src/wallet");
const { evaluateAndReserve, savePolicy } = await import("../src/engine");

const tok = () => randomBytes(32).toString("base64url");
const OWNER = tok();
const ALICE = tok();
const db = openDb(join(dir, "fw.db"));
const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${ALICE}` }));
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, body?: unknown, token = OWNER) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
const calls = () => readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);

describe("connect a Circle Agent Wallet from the dashboard", () => {
  beforeEach(() => resetConnectState());

  it("only the owner can see or change it", async () => {
    expect((await call("GET", "/v1/owner/wallet", undefined, ALICE)).status).toBe(403);
    expect((await call("GET", "/v1/owner/wallet", undefined, "")).status).toBe(401);
    expect((await call("POST", "/v1/owner/wallet/code", { email: "a@b.co" }, ALICE)).status).toBe(403);
    expect((await call("POST", "/v1/owner/wallet/disconnect", {}, ALICE)).status).toBe(403);
  });

  it("starts on the environment's payer, with Circle's Terms not accepted", async () => {
    const s = (await call("GET", "/v1/owner/wallet")).json;
    expect(s).toMatchObject({ network: "testnet", chain: "ARC-TESTNET", paymentMode: "local-key", cli: { installed: true }, terms: { accepted: false }, connected: null, wallet: { address: null, source: "env" } });
  });

  it("needs Circle's Terms, accepted only with an explicit yes", async () => {
    expect((await call("POST", "/v1/owner/wallet/code", { email: "owner@example.com" })).status).toBe(409);
    expect((await call("POST", "/v1/owner/wallet/terms", {})).status).toBe(400);
    expect((await call("POST", "/v1/owner/wallet/terms", { accept: "yes" })).status).toBe(400);
    const r = await call("POST", "/v1/owner/wallet/terms", { accept: true });
    expect(r.status).toBe(200);
    expect(r.json.terms.accepted).toBe(true);
  });

  it("refuses emails and codes that aren't plainly that (no CLI flag injection)", async () => {
    for (const email of ["", "not-an-email", "--init@x.co", "-x@y.co", "a b@c.co", 42]) {
      expect((await call("POST", "/v1/owner/wallet/code", { email })).status).toBe(400);
    }
    expect((await call("POST", "/v1/owner/wallet/verify", { code: "123456" })).status).toBe(409); // no code requested
  });

  it("emails a code on testnet, then the right code connects the wallet and makes it the payer", async () => {
    const sent = await call("POST", "/v1/owner/wallet/code", { email: "owner@example.com" });
    expect(sent.status).toBe(200);
    expect(sent.json.email).toBe("owner@example.com");
    expect(JSON.stringify(sent.json)).not.toMatch(/req-/); // the CLI's request id stays on the firewall
    const init = calls().find((a) => a.includes("--init"))!;
    expect(init).toEqual(["wallet", "login", "owner@example.com", "--type", "agent", "--testnet", "--init", "-o", "json"]);

    expect((await call("POST", "/v1/owner/wallet/code", { email: "owner@example.com" })).status).toBe(429); // resend throttle

    for (const code of ["12345", "abc", "123456; rm -rf /", "--otp"]) expect((await call("POST", "/v1/owner/wallet/verify", { code })).status).toBe(400);
    const wrong = await call("POST", "/v1/owner/wallet/verify", { code: "654321" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toMatch(/didn't work/);

    const ok = await call("POST", "/v1/owner/wallet/verify", { code: "B1X-123456" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ paymentMode: "circle-agent-wallet", connected: { email: "owner@example.com" }, wallet: { source: "dashboard" } });
    expect(ok.json.wallet.address.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(ok.json.wallet.depositor.toLowerCase()).toBe(EOA.toLowerCase());
    expect(calls().some((a) => a[0] === "gateway" && a.includes(ok.json.wallet.address) && a.includes("ARC-TESTNET"))).toBe(true);
    expect(paymentMode()).toBe("circle-agent-wallet");
  });

  it("the whole firewall follows the connected wallet: signer, deposits, /sign refused", async () => {
    const signer = (await call("GET", "/v1/signer", undefined, "")).json;
    expect(signer.mode).toBe("circle-agent-wallet");
    expect(signer.address.toLowerCase()).toBe(WALLET.toLowerCase());
    const h = (await call("GET", "/health")).json;
    expect(h.paymentMode).toBe("circle-agent-wallet");
    expect(h.deposit.depositor.toLowerCase()).toBe(EOA.toLowerCase()); // MetaMask deposits now fund this wallet

    const rules: Rule[] = [{ id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(10) }];
    savePolicy(db, "research-agent", rules, policyHash(rules));
    evaluateAndReserve(db, { requestId: "sign-1", agentId: "research-agent", taskId: "t1", recipient: "0x000000000000000000000000000000000000dEaD", amountMicro: usdToMicro(0.02), category: "data", purpose: "x" });
    const sign = await call("POST", "/v1/payments/sign-1/sign", { typedData: {} }, ALICE);
    expect(sign.status).toBe(403);
    expect(sign.json.error).toMatch(/use \/pay/);
  });

  it("survives a restart: the connection is stored, and ignored on the other network", () => {
    expect(loadConnectedWallet(db)?.address.toLowerCase()).toBe(WALLET.toLowerCase());
    const row = db.prepare("SELECT value FROM owner_settings WHERE key='circle_wallet'").get() as { value: string };
    db.prepare("UPDATE owner_settings SET value=? WHERE key='circle_wallet'").run(JSON.stringify({ ...JSON.parse(row.value), network: "mainnet" }));
    expect(loadConnectedWallet(db)).toBeNull();
    expect(paymentMode()).toBe("local-key");
    db.prepare("UPDATE owner_settings SET value=? WHERE key='circle_wallet'").run(row.value);
    expect(loadConnectedWallet(db)).not.toBeNull();
  });

  it("disconnect goes back to the environment's payer", async () => {
    const r = await call("POST", "/v1/owner/wallet/disconnect", {});
    expect(r.json).toMatchObject({ paymentMode: "local-key", connected: null, wallet: { source: "env", address: null } });
    expect((await call("GET", "/v1/signer", undefined, "")).json.mode).toBe("local-key");
  });

  it("reconnects from an existing CLI session without a new code", async () => {
    const r = await call("POST", "/v1/owner/wallet/connect", {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ paymentMode: "circle-agent-wallet", connected: { email: "owner@example.com" } });
    await call("POST", "/v1/owner/wallet/disconnect", {});
  });

  it("gives up on a code request after 5 wrong tries", async () => {
    // Let the resend throttle pass for this one test by resetting it.
    resetConnectState();
    expect((await call("POST", "/v1/owner/wallet/code", { email: "owner@example.com" })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await call("POST", "/v1/owner/wallet/verify", { code: "000000" })).status).toBe(400);
    expect((await call("POST", "/v1/owner/wallet/verify", { code: "123456" })).status).toBe(429);
    expect((await call("POST", "/v1/owner/wallet/verify", { code: "123456" })).status).toBe(409);
  });

  it("says so when Circle's CLI isn't installed", async () => {
    const real = process.env.CIRCLE_CLI_BIN;
    process.env.CIRCLE_CLI_BIN = join(dir, "no-such-circle");
    try {
      expect((await call("GET", "/v1/owner/wallet")).json.cli.installed).toBe(false);
      expect((await call("POST", "/v1/owner/wallet/code", { email: "owner@example.com" })).status).toBe(503);
    } finally {
      process.env.CIRCLE_CLI_BIN = real;
    }
  });
});
