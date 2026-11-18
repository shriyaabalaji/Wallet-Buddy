// The dashboard's server-side proxy and owner session: the owner token stays on the server.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify, proxy } from "../src/lib/proxy";
import { SESSION_COOKIE, createSession, verifySession } from "../src/lib/session";

const OWNER_TOKEN = randomBytes(32).toString("base64url");
const env = {
  FIREWALL_URL: "http://firewall.test",
  FIREWALL_OWNER_TOKEN: OWNER_TOKEN,
  DASHBOARD_SESSION_SECRET: randomBytes(32).toString("base64url"),
  DASHBOARD_PASSWORD: "correct horse battery",
};
const ORIGIN = "http://dash.test";

const req = (method: string, path: string, opts: { cookie?: string; origin?: string | null; body?: string } = {}) =>
  new Request(ORIGIN + path, {
    method,
    headers: {
      host: "dash.test",
      ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
      ...(opts.cookie ? { cookie: `other=1; ${SESSION_COOKIE}=${opts.cookie}` } : {}),
    },
    body: opts.body,
  });
const segs = (p: string) => p.split("?")[0]!.split("/").filter(Boolean);

let calls: { url: string; init: RequestInit }[];
const fakeFirewall = (status = 200, body = '{"ok":true}') =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers: { "Content-Type": "application/json", "X-Internal": "secret-ish" } });
  }) as unknown as typeof fetch;
beforeEach(() => (calls = []));

describe("proxy: owner routes", () => {
  it("refuses owner routes without a session and never contacts the firewall", async () => {
    const f = fakeFirewall();
    for (const [m, p] of [["GET", "/v1/agents/research-agent/summary"], ["POST", "/v1/policy"], ["POST", "/v1/agents/research-agent/resume"], ["GET", "/health"]] as const) {
      const r = await proxy(req(m, `/api/fw${p}`, { body: m === "POST" ? "{}" : undefined }), segs(p), env, f);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
    const forged = await proxy(req("POST", "/api/fw/v1/policy", { cookie: "v1.9999999999.abc.forged", body: "{}" }), segs("/v1/policy"), env, f);
    expect(forged.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("adds the owner token server-side and returns nothing of it to the browser", async () => {
    const f = fakeFirewall(200, '{"policy":{"hash":"0x1"}}');
    const body = JSON.stringify({ agentId: "research-agent", confirmed: true, rules: [] });
    const r = await proxy(req("POST", "/api/fw/v1/policy", { cookie: createSession(env), body }), segs("/v1/policy"), env, f);
    expect(r.status).toBe(200);
    expect(calls[0]!.url).toBe("http://firewall.test/v1/policy");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(calls[0]!.init.body).toBe(body);
    // Browser-facing response: firewall body only, no firewall headers, no token anywhere.
    const text = await r.text();
    expect(text).toBe('{"policy":{"hash":"0x1"}}');
    expect(r.headers.get("x-internal")).toBeNull();
    expect([...r.headers].flat().join(" ")).not.toContain(OWNER_TOKEN);
  });

  it("forwards the query string", async () => {
    const f = fakeFirewall();
    await proxy(req("GET", "/api/fw/v1/activity?agentId=research-agent&filter=all&limit=100", { cookie: createSession(env) }), segs("/v1/activity"), env, f);
    expect(calls[0]!.url).toBe("http://firewall.test/v1/activity?agentId=research-agent&filter=all&limit=100");
  });

  it("fails closed when the dashboard has no owner token configured", async () => {
    const f = fakeFirewall();
    const r = await proxy(req("GET", "/api/fw/health", { cookie: createSession(env) }), ["health"], { ...env, FIREWALL_OWNER_TOKEN: "" }, f);
    expect(r.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("proxy: CSRF and path safety", () => {
  it("refuses state-changing requests from another origin or with no Origin", async () => {
    const f = fakeFirewall();
    const cookie = createSession(env);
    for (const origin of ["http://evil.test", null]) {
      const r = await proxy(req("POST", "/api/fw/v1/agents/research-agent/resume", { cookie, origin, body: "{}" }), segs("/v1/agents/research-agent/resume"), env, f);
      expect(r.status).toBe(403);
    }
    const pinned = await proxy(req("POST", "/api/fw/v1/agents/research-agent/resume", { cookie, body: "{}" }), segs("/v1/agents/research-agent/resume"), { ...env, DASHBOARD_ORIGIN: "https://tunnel.example" }, f);
    expect(pinned.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("forwards owner reconciliation with the owner token, and only with a session and same origin", async () => {
    const f = fakeFirewall(200, '{"status":"released"}');
    const p = "/v1/payments/req_1/reconcile";
    const body = '{"outcome":"not_paid"}';
    expect((await proxy(req("POST", `/api/fw${p}`, { body }), segs(p), env, f)).status).toBe(401);
    expect((await proxy(req("POST", `/api/fw${p}`, { cookie: createSession(env), origin: "http://evil.test", body }), segs(p), env, f)).status).toBe(403);
    expect(calls).toHaveLength(0);
    const r = await proxy(req("POST", `/api/fw${p}`, { cookie: createSession(env), body }), segs(p), env, f);
    expect(r.status).toBe(200);
    expect(calls[0]!.url).toBe(`http://firewall.test${p}`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OWNER_TOKEN}`);
  });

  it("never forwards agent payment routes or unknown paths, even with a session", async () => {
    const f = fakeFirewall();
    const cookie = createSession(env);
    for (const p of ["/v1/payments/evaluate", "/v1/payments/req_1/sign", "/v1/payments/req_1/pay", "/v1/payments/req_1/settled", "/v1/twilio/inbound", "/v1/signer", "/nope"]) {
      const r = await proxy(req("POST", `/api/fw${p}`, { cookie, body: "{}" }), segs(p), env, f);
      expect(r.status, p).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("re-encodes segments so traversal can't change the target", () => {
    expect(classify("GET", ["v1", "approvals", "..", "policy"])).toBeNull();
    expect(classify("GET", ["v1", "approvals", "a/../../policy"])).toEqual({ path: "/v1/approvals/a%2F..%2F..%2Fpolicy", access: "link" });
    expect(classify("GET", ["v1", "approvals", "t?x=1"])!.path).toBe("/v1/approvals/t%3Fx%3D1");
    expect(classify("GET", ["v1", "agents", "research-agent", "anomalies"])).toEqual({ path: "/v1/agents/research-agent/anomalies", access: "owner" });
  });
});

describe("proxy: public approval links", () => {
  it("forwards approval-link routes without a session and WITHOUT the owner token", async () => {
    const f = fakeFirewall(200, '{"status":"held"}');
    for (const [m, p] of [["GET", "/v1/approvals/tok123"], ["POST", "/v1/approvals/tok123/deny"], ["POST", "/v1/approvals/tok123/approve/options"], ["POST", "/v1/approvals/tok123/approve"]] as const) {
      const r = await proxy(req(m, `/api/fw${p}`, { body: m === "POST" ? "{}" : undefined, cookie: createSession(env) }), segs(p), env, f);
      expect(r.status, p).toBe(200);
    }
    expect(calls).toHaveLength(4);
    for (const c of calls) expect((c.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("maps an unreachable firewall to 502", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect((await proxy(req("GET", "/api/fw/v1/approvals/t"), segs("/v1/approvals/t"), env, down)).status).toBe(502);
  });
});

describe("session", () => {
  it("rejects tampered, expired, foreign-secret and unconfigured sessions", () => {
    const s = createSession(env);
    expect(verifySession(s, env)).toBe(true);
    const [v, exp, nonce, mac] = s.split(".");
    expect(verifySession(`${v}.${Number(exp) + 3600}.${nonce}.${mac}`, env)).toBe(false);
    expect(verifySession(s, env, Date.now() + 13 * 3600_000)).toBe(false);
    expect(verifySession(s, { ...env, DASHBOARD_SESSION_SECRET: randomBytes(32).toString("base64url") })).toBe(false);
    expect(verifySession(s, { ...env, DASHBOARD_SESSION_SECRET: "too-short" })).toBe(false);
    expect(() => createSession({ DASHBOARD_SESSION_SECRET: "" })).toThrow();
  });
});

describe("session route", () => {
  const saved = { ...process.env };
  beforeEach(() => Object.assign(process.env, env));
  afterEach(() => {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const login = async (password: unknown, origin: string | null = ORIGIN) => {
    const { POST } = await import("../src/app/api/session/route");
    return POST(req("POST", "/api/session", { origin, body: JSON.stringify({ password }) }));
  };

  it("sets an HttpOnly SameSite=Strict cookie on the right password and never returns the owner token", async () => {
    const r = await login(env.DASHBOARD_PASSWORD);
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    const text = await r.text();
    for (const s of [text, cookie]) expect(s).not.toContain(OWNER_TOKEN);
    expect(verifySession(decodeURIComponent(cookie.split(";")[0]!.split("=").slice(1).join("=")), env)).toBe(true);
  });

  it("refuses wrong passwords, cross-site logins, and logins when not configured", async () => {
    expect((await login("wrong password!!")).status).toBe(401);
    expect((await login(env.DASHBOARD_PASSWORD, "http://evil.test")).status).toBe(403);
    process.env.DASHBOARD_PASSWORD = "short";
    expect((await login("short")).status).toBe(503);
  });
});

describe("no firewall credential can reach browser code", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
  const src = files(join(__dirname, "../src"));

  it("no NEXT_PUBLIC_* variable carries a token or secret", () => {
    for (const f of src) expect(readFileSync(f, "utf8"), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(TOKEN|SECRET|PASSWORD|KEY)/);
  });

  it("client components never import the server-only session/proxy modules or read the owner token", () => {
    for (const f of src) {
      const code = readFileSync(f, "utf8");
      if (!code.startsWith('"use client"')) continue;
      expect(code, f).not.toMatch(/lib\/(session|proxy)/);
      expect(code, f).not.toContain("FIREWALL_OWNER_TOKEN");
    }
  });
});
