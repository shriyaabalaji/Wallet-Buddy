// Seller registry: names agents pay map to registered wallets; the owner manages them; env entries seed once and
// stay removed once the owner removes them.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SPORTS = "0x1111111111111111111111111111111111111111";
const ODDS = "0x2222222222222222222222222222222222222222";
process.env.SELLER_ADDRESSES = `sportsfeed=${SPORTS},oddsapi=${ODDS},bad=nope`;
const { openDb } = await import("../src/db");
const { createApp } = await import("../src/server");
const { loadAuth } = await import("../src/auth");
const { resolveRecipient } = await import("../src/arc");
const { loadSellers } = await import("../src/sellers");

const tok = () => randomBytes(32).toString("base64url");
const OWNER = tok(), AGENT = tok();
const db = openDb(join(mkdtempSync(join(tmpdir(), "sellers-")), "t.db"));
const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${AGENT}` }));
let base = "";
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("seller registry", () => {
  it("seeds valid SELLER_ADDRESSES entries and resolves names to them", async () => {
    const r = await call("GET", "/v1/sellers", OWNER);
    expect(r.json.items.map((s: any) => [s.name, s.source])).toEqual([["oddsapi", "env"], ["sportsfeed", "env"]]);
    expect(resolveRecipient("sportsfeed")).toBe(SPORTS);
    expect(resolveRecipient("SportsFeed")).toBe(SPORTS);
    expect(resolveRecipient("shadyapi")).toBeNull();
    expect(resolveRecipient(ODDS)).toBe(ODDS); // raw addresses are themselves
  });

  it("owner adds, updates and removes sellers; agents can't", async () => {
    const addr = "0x3333333333333333333333333333333333333333";
    expect((await call("POST", "/v1/sellers", AGENT, { name: "weatherapi", address: addr })).status).toBe(403);
    const add = await call("POST", "/v1/sellers", OWNER, { name: "WeatherAPI", address: addr, url: "https://weather.example/" });
    expect(add.status).toBe(200);
    expect(add.json).toMatchObject({ name: "weatherapi", address: addr, url: "https://weather.example", source: "dashboard" });
    expect(resolveRecipient("weatherapi")).toBe(addr);
    const moved = "0x4444444444444444444444444444444444444444";
    await call("POST", "/v1/sellers", OWNER, { name: "weatherapi", address: moved });
    expect(resolveRecipient("weatherapi")).toBe(moved);
    expect((await call("DELETE", "/v1/sellers/weatherapi", AGENT)).status).toBe(403);
    expect((await call("DELETE", "/v1/sellers/weatherapi", OWNER)).status).toBe(200);
    expect(resolveRecipient("weatherapi")).toBeNull();
    expect((await call("DELETE", "/v1/sellers/weatherapi", OWNER)).status).toBe(404);
  });

  it("rejects bad names, addresses and URLs", async () => {
    for (const body of [
      { name: "", address: SPORTS },
      { name: "has space", address: SPORTS },
      { name: SPORTS, address: SPORTS },
      { name: "ok", address: "0x123" },
      { name: "ok", address: SPORTS, url: "javascript:alert(1)" },
    ]) expect((await call("POST", "/v1/sellers", OWNER, body)).status).toBe(400);
  });

  it("a removed env seller stays removed after a restart", async () => {
    await call("DELETE", "/v1/sellers/oddsapi", OWNER);
    loadSellers(db); // what createApp does on startup
    expect(resolveRecipient("oddsapi")).toBeNull();
    expect(resolveRecipient("sportsfeed")).toBe(SPORTS);
  });
});
