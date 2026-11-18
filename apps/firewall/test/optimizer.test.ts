// Payment optimizer: deterministic recommendation, eligibility filters, evidence for realized savings, and the
// HTTP route's auth. Quotes here are test fixtures; the live 402 parsing is exercised against a local fake seller.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { policyHash, type Rule, type SpendState } from "@agent-firewall/policy";

const ADDR = { statline: privateKeyToAccount(generatePrivateKey()).address, sportsfeed: privateKeyToAccount(generatePrivateKey()).address, oddsapi: privateKeyToAccount(generatePrivateKey()).address };
process.env.PAYMENT_MODE = "local-key";
process.env.SELLER_ADDRESSES = Object.entries(ADDR).map(([k, v]) => `${k}=${v}`).join(",");

const { DEMO_PROVIDERS, QUOTE_TTL_MS, fetchQuote, recommend, requirementsChanged, saveRecommendation, recommendationOutcome, listRecommendations } = await import("../src/optimizer");
const { openDb } = await import("../src/db");
const { evaluateAndReserve, markFailed, markSettled, savePolicy } = await import("../src/engine");
const { createApp } = await import("../src/server");
const { loadAuth } = await import("../src/auth");

const NOW = 1_800_000_000_000;
const resolve = (r: string) => (ADDR as Record<string, string>)[r] ?? null;
const state = (over: Partial<SpendState> = {}): SpendState => ({ taskSpentMicro: 0, periodSpentMicro: { day: 0, week: 0, month: 0 }, requestsLastMinute: 0, paused: false, ...over });
const rules = (recipients = ["statline", "sportsfeed", "oddsapi"], extra: Rule[] = []): Rule[] => [
  { id: "task", kind: "taskBudget", taskId: "*", maxMicro: 3_000_000 },
  { id: "approved", kind: "allowlist", recipients },
  ...extra,
];
const q = (providerId: keyof typeof ADDR, amountMicro: number, over: Record<string, unknown> = {}) =>
  ({ ok: true as const, quote: { providerId, source: "x402-402" as const, amountMicro, payTo: ADDR[providerId], network: "eip155:5042002", fetchedAt: NOW - 1_000, latencyMs: 12, ...over } });
const input = (over: Record<string, unknown> = {}) => ({ agentId: "research-agent", taskId: "t1", need: { category: "data" as const, sku: "injury-report" }, maxAmountMicro: 1_000_000, ...over });
const ctx = (over: Record<string, unknown> = {}) => ({ rules: rules(), state: state(), now: NOW, resolve, ...over });
const cand = (rec: ReturnType<typeof recommend>, id: string) => rec.candidates.find((c) => c.providerId === id)!;

describe("optimizer: recommend (pure, deterministic)", () => {
  it("compatible cheaper provider: picks sportsfeed ($0.02) over the usual statline ($0.05), estimates $0.03", () => {
    const rec = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000)], ctx());
    expect(rec.recommended?.providerId).toBe("sportsfeed");
    expect(rec.baseline).toEqual({ providerId: "statline", amountMicro: 50_000, eligible: true });
    expect(rec.estimatedSavingsMicro).toBe(30_000);
    expect(rec.demoProvidersOnly).toBe(true);
    // Same inputs, same answer.
    expect(recommend(input(), DEMO_PROVIDERS, [q("sportsfeed", 20_000), q("statline", 50_000)], ctx()).recommended).toEqual(rec.recommended);
  });

  it("provider unavailable: falls back to the remaining eligible one, no saving claimed", () => {
    const rec = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), { ok: false, providerId: "sportsfeed", error: "unavailable: ECONNREFUSED", fetchedAt: NOW }], ctx());
    expect(rec.recommended?.providerId).toBe("statline");
    expect(cand(rec, "sportsfeed")).toMatchObject({ eligible: false, reason: "unavailable: ECONNREFUSED" });
    expect(rec.estimatedSavingsMicro).toBe(0);
  });

  it("incompatible capability: a cheaper provider of a different product is never chosen", () => {
    const rec = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("oddsapi", 10_000)], ctx());
    expect(cand(rec, "oddsapi")).toMatchObject({ compatible: false, eligible: false });
    expect(cand(rec, "oddsapi").reason).toMatch(/sells odds-line/);
    expect(rec.recommended?.providerId).toBe("statline");
    // Output-field requirements also gate compatibility.
    const needsLine = recommend(input({ need: { category: "data", sku: "injury-report", fields: ["line"] } }), DEMO_PROVIDERS, [q("statline", 50_000)], ctx());
    expect(needsLine.recommended).toBeNull();
  });

  it("price greater than budget: excluded by maxAmountMicro and by the task budget rule", () => {
    const overMax = recommend(input({ maxAmountMicro: 30_000 }), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000)], ctx());
    expect(cand(overMax, "statline").reason).toMatch(/over the \$0\.03 maximum/);
    expect(overMax.recommended?.providerId).toBe("sportsfeed");
    expect(overMax.estimatedSavingsMicro).toBeNull(); // baseline wasn't an eligible option
    const overTask = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000)], ctx({ state: state({ taskSpentMicro: 2_990_000 }) }));
    expect(overTask.recommended).toBeNull();
    expect(cand(overTask, "sportsfeed").reason).toMatch(/your rules block it/);
  });

  it("unauthorized payment recipient: not on the allowlist, or the 402 pays a different address", () => {
    const notAllowed = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000)], ctx({ rules: rules(["statline"]) }));
    // Not on the allowlist: the engine's default for an unknown recipient is "hold" (ask the owner); either way it's
    // never auto-recommended.
    expect(cand(notAllowed, "sportsfeed")).toMatchObject({ eligible: false, policyOutcome: "hold" });
    expect(notAllowed.recommended?.providerId).toBe("statline");
    const swapped = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000, { payTo: privateKeyToAccount(generatePrivateKey()).address })], ctx());
    expect(cand(swapped, "sportsfeed").reason).toMatch(/payee isn't the configured recipient/);
    expect(swapped.recommended?.providerId).toBe("statline");
  });

  it("missing or stale quote: never recommended", () => {
    const missing = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000)], ctx());
    expect(cand(missing, "sportsfeed").reason).toBe("no quote");
    const stale = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000, { fetchedAt: NOW - QUOTE_TTL_MS - 1 })], ctx());
    expect(cand(stale, "sportsfeed").reason).toMatch(/stale/);
    expect(stale.recommended?.providerId).toBe("statline");
  });

  it("changed payment requirements: live price ≠ configured price is ineligible; a change after recommending forces a new ask", () => {
    const drift = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 25_000)], ctx());
    expect(cand(drift, "sportsfeed").reason).toMatch(/differs from configured/);
    const rec = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000)], ctx());
    expect(requirementsChanged(rec, q("sportsfeed", 20_000).quote)).toBeNull();
    expect(requirementsChanged(rec, q("sportsfeed", 40_000).quote)).toMatch(/price changed/);
  });

  it("equal-price providers: deterministic tie-break (measured latency, else provider id)", () => {
    const providers = DEMO_PROVIDERS.map((p) => (p.id === "statline" ? { ...p, configuredMicro: 20_000 } : p));
    const byLatency = recommend(input(), providers, [q("statline", 20_000, { latencyMs: 5 }), q("sportsfeed", 20_000, { latencyMs: 40 })], ctx());
    expect(byLatency.recommended?.providerId).toBe("statline");
    const byId = recommend(input(), providers, [q("statline", 20_000, { latencyMs: Number.NaN }), q("sportsfeed", 20_000, { latencyMs: 40 })], ctx());
    expect(byId.recommended?.providerId).toBe("sportsfeed"); // latency not measured for both → id order
    expect(byLatency.estimatedSavingsMicro).toBe(0);
  });

  it("no eligible provider: paused agent, or no rules saved", () => {
    const paused = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000)], ctx({ state: state({ paused: true }) }));
    expect(paused.recommended).toBeNull();
    expect(paused.explanation).toMatch(/No eligible provider/);
    const noRules = recommend(input(), DEMO_PROVIDERS, [q("sportsfeed", 20_000)], ctx({ rules: null }));
    expect(noRules.recommended).toBeNull();
  });

  it("a payment the firewall would only HOLD is not auto-recommended", () => {
    const rec = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000)], ctx({ rules: rules(undefined, [{ id: "ask", kind: "approvalThreshold", aboveMicro: 10_000 }]) }));
    expect(rec.recommended).toBeNull();
    expect(cand(rec, "sportsfeed").reason).toMatch(/would need your approval/);
  });
});

describe("optimizer: realized savings need evidence", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "opt-")), "o.db"));
  const r = rules();
  savePolicy(db, "research-agent", r, policyHash(r));
  const rec = recommend(input(), DEMO_PROVIDERS, [q("statline", 50_000), q("sportsfeed", 20_000)], ctx());
  const req = (id: string, recipient = "sportsfeed", amountMicro = 20_000) =>
    evaluateAndReserve(db, { requestId: id, agentId: "research-agent", taskId: "t1", recipient, amountMicro, category: "data", purpose: "injury report" });

  it("settled payment that followed the recommendation → realized saving", () => {
    req("r-ok");
    const id = saveRecommendation(db, rec, "r-ok");
    expect(recommendationOutcome(db, id)).toMatchObject({ status: "payment reserved", realizedSavingsMicro: null });
    markSettled(db, "r-ok");
    expect(recommendationOutcome(db, id)).toMatchObject({ status: "settled", realizedSavingsMicro: 30_000 });
  });

  it("failed purchase → no realized saving", () => {
    req("r-fail");
    const id = saveRecommendation(db, rec, "r-fail");
    markFailed(db, "r-fail");
    expect(recommendationOutcome(db, id)).toMatchObject({ status: "payment released", realizedSavingsMicro: null });
  });

  it("payment to a different provider than recommended → no realized saving", () => {
    req("r-other", "statline", 50_000);
    const id = saveRecommendation(db, rec, "r-other");
    markSettled(db, "r-other");
    expect(recommendationOutcome(db, id)).toMatchObject({ status: "payment didn't follow the recommendation", realizedSavingsMicro: null });
  });

  it("unlinked recommendation → estimate only; list totals only realized", () => {
    const id = saveRecommendation(db, rec);
    expect(recommendationOutcome(db, id)?.status).toBe("not linked to a payment");
    expect(listRecommendations(db, "research-agent").realizedSavingsMicro).toBe(30_000);
  });
});

describe("optimizer: live quotes and HTTP route", () => {
  // A fake seller that serves real-shaped x402 402s (no payment ever happens in these tests).
  const prices: Record<string, number> = { "/statline/injuries": 50_000, "/sportsfeed/injuries": 20_000 };
  const payTo: Record<string, string> = { "/statline/injuries": ADDR.statline, "/sportsfeed/injuries": ADDR.sportsfeed };
  const seller = createServer((rq, rs) => {
    const path = new URL(rq.url ?? "/", "http://x").pathname;
    if (!(path in prices)) return rs.writeHead(404).end();
    const required = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:5042002", amount: String(prices[path]), payTo: payTo[path], extra: { name: "GatewayWalletBatched", version: "1" } }] };
    rs.writeHead(402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") }).end("{}");
  });
  const tok = () => randomBytes(32).toString("base64url");
  const OWNER = tok(), ALICE = tok(), BOB = tok();
  const db = openDb(join(mkdtempSync(join(tmpdir(), "opt-http-")), "h.db"));
  const app = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `research-agent=${ALICE},race-agent=${BOB}` }));
  let fw = "", sellers = "";
  beforeAll(async () => {
    await new Promise<void>((r) => seller.listen(0, "127.0.0.1", r));
    sellers = `http://127.0.0.1:${(seller.address() as AddressInfo).port}`;
    process.env.SELLERS_URL = sellers;
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    fw = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const r = rules();
    savePolicy(db, "research-agent", r, policyHash(r));
  });
  afterAll(async () => {
    await new Promise<void>((r) => seller.close(() => r()));
    await new Promise<void>((r) => app.close(() => r()));
  });
  const post = (token: string | undefined, body: unknown) =>
    fetch(`${fw}/v1/optimizer/recommend`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const body = { agentId: "research-agent", taskId: "t1", need: { category: "data", sku: "injury-report" }, maxAmountMicro: 1_000_000 };

  it("fetchQuote reads a real 402 and measures latency; an unreachable provider is reported unavailable", async () => {
    const ok = await fetchQuote(DEMO_PROVIDERS.find((p) => p.id === "sportsfeed")!, sellers, "eip155:5042002");
    expect(ok.ok && ok.quote.amountMicro).toBe(20_000);
    expect(ok.ok && ok.quote.latencyMs).toBeGreaterThanOrEqual(0);
    const down = await fetchQuote(DEMO_PROVIDERS[0]!, "http://127.0.0.1:1", "eip155:5042002");
    expect(down.ok).toBe(false);
  });

  it("agent gets a recommendation for itself from live quotes; nothing is reserved", async () => {
    const r = await post(ALICE, body);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.recommended.providerId).toBe("sportsfeed");
    expect(j.estimatedSavingsMicro).toBe(30_000);
    expect(j.candidates.find((c: any) => c.providerId === "sportsfeed").quote.source).toBe("x402-402");
    expect((db.prepare("SELECT COUNT(*) n FROM requests").get() as any).n).toBe(0);
  });

  it("auth: no token → 401; another agent's token → 403; recommendation history is owner-only", async () => {
    expect((await post(undefined, body)).status).toBe(401);
    expect((await post(BOB, body)).status).toBe(403);
    expect((await fetch(`${fw}/v1/optimizer/recommendations`, { headers: { Authorization: `Bearer ${ALICE}` } })).status).toBe(403);
    const list = await fetch(`${fw}/v1/optimizer/recommendations?agentId=research-agent`, { headers: { Authorization: `Bearer ${OWNER}` } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).items.length).toBeGreaterThan(0);
  });

  it("bad input → 400", async () => {
    expect((await post(ALICE, { ...body, maxAmountMicro: -1 })).status).toBe(400);
    expect((await post(ALICE, { ...body, need: { category: "nope", sku: "injury-report" } })).status).toBe(400);
  });
});
