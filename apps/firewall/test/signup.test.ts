// Website signup: the owner adds an agent and gets its key (stored only as a digest), and can rotate it.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createApp } from "../src/server";
import { loadAuth } from "../src/auth";

const tok = () => randomBytes(32).toString("base64url");
const OWNER = tok();
const ALICE = tok(); // research-agent
const BOB = tok(); // race-agent
const db = openDb(join(mkdtempSync(join(tmpdir(), "signup-")), "d.db"));
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

describe("agent keys issued from the website", () => {
  it("key works only for that agent, is stored as a digest, rotates, and agents can't mint keys", async () => {
    const r = await call("POST", "/v1/agents", OWNER, { id: "web-agent", issueKey: true });
    expect(r.status).toBe(200);
    const key = r.json.key as string;
    expect(key).toMatch(/^wb_/);
    expect(JSON.stringify(db.prepare("SELECT * FROM agent_keys").all())).not.toContain(key);
    expect((await call("GET", "/v1/agents/web-agent/summary", key)).status).toBe(200);
    expect((await call("GET", "/v1/agents/research-agent/summary", key)).status).toBe(403);
    expect((await call("POST", "/v1/agents/web-agent/key", key, {})).status).toBe(403);
    expect((await call("POST", "/v1/agents/web-agent/key", ALICE, {})).status).toBe(403);
    const rotated = await call("POST", "/v1/agents/web-agent/key", OWNER, {});
    expect(rotated.status).toBe(200);
    expect((await call("GET", "/v1/agents/web-agent/summary", key)).status).toBe(401);
    expect((await call("GET", "/v1/agents/web-agent/summary", rotated.json.key)).status).toBe(200);
    expect((await call("POST", "/v1/agents/ghost/key", OWNER, {})).status).toBe(404);
    const list = await call("GET", "/v1/agents", OWNER);
    expect(list.json.agents.find((a: any) => a.id === "web-agent").credentialConfigured).toBe(true);
    expect(JSON.stringify(list.json)).not.toContain(rotated.json.key);
  });
});

describe("text-message settings on their own", () => {
  it("owner saves phone + events without a rules save; validates; agents can't", async () => {
    const r = await call("POST", "/v1/agents/web-agent/notify", OWNER, { phone: "+16045550100", events: ["hold", "paused", "bogus"] });
    expect(r.status).toBe(200);
    expect(r.json.notify).toEqual({ phone: "+16045550100", events: ["hold", "paused"] });
    expect(db.prepare("SELECT COUNT(*) n FROM policies WHERE agent_id='web-agent'").get()).toMatchObject({ n: 0 });
    expect((await call("POST", "/v1/agents/web-agent/notify", OWNER, { phone: "604-555-0100" })).status).toBe(400);
    expect((await call("POST", "/v1/agents/web-agent/notify", ALICE, { phone: "+16045550100" })).status).toBe(403);
    expect((await call("POST", "/v1/agents/ghost/notify", OWNER, { phone: "+16045550100" })).status).toBe(404);
  });
});
