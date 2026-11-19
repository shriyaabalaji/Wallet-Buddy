// Approving and cancelling by text: one-time 6-digit codes per held payment, owner's number only, a dollar cap,
// lockout after wrong codes, and Textbelt reply signatures. Arc and SMS providers aren't configured here, so texts
// are dry-run (logged in sms_log) and replies go through the Twilio route, which accepts unsigned requests in dev mode.
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.TEXTBELT_KEY = ""; // dry-run for sends; the signature test sets its own key below
const { openDb } = await import("../src/db");
const { createApp } = await import("../src/server");
const { loadAuth } = await import("../src/auth");

const tok = () => randomBytes(32).toString("base64url");
const OWNER = tok(), AGENT = tok();
const OWNER_PHONE = "+16045550199";
const db = openDb(join(mkdtempSync(join(tmpdir(), "txt-")), "t.db"));
const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${AGENT}` }));
let base = "";
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
const reply = async (from: string, text: string) => {
  const r = await fetch(base + "/v1/twilio/inbound", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: from, Body: text }) });
  return (await r.text()).replace(/<[^>]+>/g, "");
};
const hold = async (id: string, amountMicro: number) => {
  const d = await call("POST", "/v1/payments/evaluate", AGENT, { requestId: id, agentId: "research-agent", taskId: id, recipient: "sportsfeed", amountMicro, category: "data", purpose: "test" });
  expect(d.json.outcome).toBe("hold");
  for (let i = 0; i < 50; i++) {
    const sms = db.prepare("SELECT body FROM sms_log WHERE direction='out' ORDER BY id DESC LIMIT 1").get() as any;
    if (sms && sms.body.includes(`${(amountMicro / 1e6).toFixed(2)} USDC`)) return sms.body as string;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no hold text");
};
const statusOf = (id: string) => (db.prepare("SELECT status FROM holds WHERE request_id=?").get(id) as any)?.status;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await call("POST", "/v1/policy", OWNER, { agentId: "research-agent", confirmed: true, rules: [
    { id: "task", kind: "taskBudget", taskId: "*", maxMicro: 50_000_000 },
    { id: "ask", kind: "approvalThreshold", aboveMicro: 100_000 },
  ] });
  await call("POST", "/v1/settings", OWNER, { phone: OWNER_PHONE, events: ["hold"], textApprove: { enabled: true, maxMicro: 5_000_000 } });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("approve by text", () => {
  it("the hold text carries a 6-digit code; YES <code> from the owner approves exactly that payment", async () => {
    const body = await hold("h1", 500_000);
    const code = /YES (\d{6})/.exec(body)![1]!;
    expect(body).toMatch(/Reply YES \d{6} to allow or NO to cancel\./);
    expect(body).not.toMatch(/\$|send|refund/i); // carrier-filter triggers (see sms.ts)
    expect(await reply("+15550000000", `YES ${code}`)).toMatch(/don't|Nothing|recognize|match/); // stranger: refused
    expect(statusOf("h1")).toBe("held");
    expect(await reply(OWNER_PHONE, `yes ${code}`)).toMatch(/Allowed: 0\.50 USDC/);
    expect(statusOf("h1")).toBe("approved");
    expect((db.prepare("SELECT approved_via FROM holds WHERE request_id='h1'").get() as any).approved_via).toBe("text");
    expect(await reply(OWNER_PHONE, `YES ${code}`)).toMatch(/Nothing is waiting|doesn't match/); // can't reuse
  });

  it("YES without a code, or a wrong code, approves nothing; 5 wrong codes lock text approval for that payment", async () => {
    const body = await hold("h2", 400_000);
    const code = /YES (\d{6})/.exec(body)![1]!;
    expect(await reply(OWNER_PHONE, "YES")).toMatch(/6-digit code/);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await reply(OWNER_PHONE, `YES ${wrong}`)).toMatch(/doesn't match/);
    expect(await reply(OWNER_PHONE, `YES ${code}`)).toMatch(/isn't available|passkey/);
    expect(statusOf("h2")).toBe("held");
  });

  it("over the cap: no code in the text, passkey required; NO <code> cancels just one payment", async () => {
    const big = await hold("h3", 7_000_000);
    expect(big).not.toMatch(/YES \d{6}/);
    const a = /YES (\d{6})/.exec(await hold("h4", 300_000))![1]!;
    await hold("h5", 200_000);
    expect(await reply(OWNER_PHONE, `NO ${a}`)).toMatch(/Cancelled/);
    expect(statusOf("h4")).toBe("denied");
    expect(statusOf("h5")).toBe("held");
    expect(statusOf("h3")).toBe("held");
  });

  it("owner can turn text approval off or change the cap; bad caps are rejected; agents can't change it", async () => {
    expect((await call("POST", "/v1/settings", OWNER, { textApprove: { enabled: true, maxMicro: 500_000_000 } })).status).toBe(400);
    expect((await call("POST", "/v1/settings", AGENT, { textApprove: { enabled: true, maxMicro: 1 } })).status).toBe(403);
    expect((await call("POST", "/v1/settings", OWNER, { textApprove: { enabled: false, maxMicro: 5_000_000 } })).json.textApprove).toEqual({ enabled: false, maxMicro: 5_000_000 });
    expect((await call("GET", "/v1/settings", OWNER)).json.phone).toBe(OWNER_PHONE); // phone untouched by a partial save
    const body = await hold("h6", 300_000);
    expect(body).not.toMatch(/YES \d{6}/);
    expect(await reply(OWNER_PHONE, "YES 123456")).toMatch(/turned off/);
  });
});

describe("Textbelt reply signature", () => {
  it("accepts only hex HMAC-SHA256(key, timestamp + raw body) with a fresh timestamp", async () => {
    const { config } = await import("../src/config");
    const { validTextbeltSignature } = await import("../src/sms");
    (config as any).textbelt.key = "tb_test_key";
    const raw = JSON.stringify({ textId: "1", fromNumber: OWNER_PHONE, text: "NO" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", "tb_test_key").update(ts + raw).digest("hex");
    expect(validTextbeltSignature(sig, ts, raw)).toBe(true);
    expect(validTextbeltSignature(sig, ts, raw.replace("NO", "YES"))).toBe(false);
    expect(validTextbeltSignature(sig, String(Number(ts) - 16 * 60), raw)).toBe(false);
    expect(validTextbeltSignature(undefined, ts, raw)).toBe(false);
    const forged = await fetch(base + "/v1/sms/textbelt", { method: "POST", headers: { "Content-Type": "application/json", "X-textbelt-signature": "00", "X-textbelt-timestamp": ts }, body: raw });
    expect(forged.status).toBe(403);
    (config as any).textbelt.key = undefined;
  });
});
