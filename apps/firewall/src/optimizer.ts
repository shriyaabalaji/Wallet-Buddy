// Payment optimizer: recommends the cheapest SUITABLE provider for a capability. It never signs, pays or
// reserves anything. The agent still goes through /v1/payments/evaluate (policy + atomic reservation) and the
// payer still checks the seller's live 402 (payTo + amount) against that reservation before paying (payer.ts).
// A recommendation is advice; the firewall decides.
//
// HONESTY: there are no external x402 providers selling a comparable product on Arc testnet (docs/RESEARCH.md Q6).
// The registry below lists OUR self-hosted demo sellers, labelled `demo: true`. "Savings" only ever means the price
// difference between two of our demo sellers for the same product.
//
//   providers        trusted config (DEMO_PROVIDERS): id, capability, endpoint, recipient id, configured price
//   quotes           fetched from the provider's real unpaid x402 402 response (no payment), timed (latency measured)
//   recommend()      pure + deterministic: compatibility → availability/fresh quote → recipient matches config →
//                    price ≤ max → firewall policy pre-check (allow only) → cheapest; ties → measured latency (only if
//                    every tied provider was measured) → provider id
//   realized saving  only when the agent's linked payment SETTLED with exactly the recommended recipient + amount
import { randomUUID } from "node:crypto";
import { evaluate, type Category, type PaymentRequest, type Rule, type SpendState } from "@agent-firewall/policy";
import { getAddress, isAddress } from "viem";
import type { DB } from "./db";
import { resolveRecipient } from "./arc";

export interface Provider {
  id: string;
  name: string;
  /** Capability / SKU: providers are only comparable when this matches exactly. */
  sku: string;
  category: Category;
  /** Path on the sellers base URL. */
  path: string;
  /** Recipient id the firewall's allowlist and SELLER_ADDRESSES use. */
  recipient: string;
  /** Price in our trusted config, integer micro-USDC. A live 402 must agree with it. */
  configuredMicro: number;
  /** Response fields the product must contain (output compatibility). */
  schema: string[];
  /** Self-hosted hackathon demo seller, not an external provider. */
  demo: boolean;
  /** The provider an agent uses when nobody optimizes (the baseline). */
  defaultFor?: string;
}

export const DEMO_PROVIDERS: Provider[] = [
  { id: "statline", name: "Statline (demo)", sku: "injury-report", category: "data", path: "/statline/injuries", recipient: "statline", configuredMicro: 50_000, schema: ["source", "report", "at"], demo: true, defaultFor: "injury-report" },
  { id: "sportsfeed", name: "Sportsfeed (demo)", sku: "injury-report", category: "data", path: "/sportsfeed/injuries", recipient: "sportsfeed", configuredMicro: 20_000, schema: ["source", "report", "at"], demo: true },
  { id: "oddsapi", name: "Odds API (demo)", sku: "odds-line", category: "data", path: "/oddsapi/odds", recipient: "oddsapi", configuredMicro: 10_000, schema: ["source", "line", "at"], demo: true, defaultFor: "odds-line" },
];

export const QUOTE_TTL_MS = Number(process.env.OPTIMIZER_QUOTE_TTL_MS ?? 60_000);

export interface Quote {
  providerId: string;
  /** "x402-402": read from the provider's live 402 PAYMENT-REQUIRED header. */
  source: "x402-402";
  amountMicro: number;
  payTo: string;
  network: string;
  fetchedAt: number;
  /** Round-trip time of the quote request, measured. */
  latencyMs: number;
}
export type QuoteResult = { ok: true; quote: Quote } | { ok: false; providerId: string; error: string; fetchedAt: number };

/** Read the provider's real 402 terms (an unpaid GET: nothing is signed or paid). */
export async function fetchQuote(p: Provider, baseUrl: string, network: string, fetcher: typeof fetch = fetch): Promise<QuoteResult> {
  const t0 = Date.now();
  try {
    const res = await fetcher(baseUrl + p.path, { signal: AbortSignal.timeout(5_000) });
    const latencyMs = Date.now() - t0;
    if (res.status !== 402) return { ok: false, providerId: p.id, error: `expected a 402 quote, got HTTP ${res.status}`, fetchedAt: t0 };
    const required = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8") || "{}");
    const opt = (required.accepts ?? []).find((o: any) => o.network === network && o.extra?.name === "GatewayWalletBatched");
    if (!opt) return { ok: false, providerId: p.id, error: `no Gateway payment option on ${network}`, fetchedAt: t0 };
    return { ok: true, quote: { providerId: p.id, source: "x402-402", amountMicro: Number(opt.amount), payTo: String(opt.payTo), network, fetchedAt: t0, latencyMs } };
  } catch (e) {
    return { ok: false, providerId: p.id, error: `unavailable: ${(e as Error).message}`, fetchedAt: t0 };
  }
}

export interface Need {
  category: Category;
  sku: string;
  /** Output fields the task needs; every one must be in the provider's schema. */
  fields?: string[];
}
export interface RecommendInput {
  agentId: string;
  taskId: string;
  need: Need;
  maxAmountMicro: number;
  /** Provider the agent would use without optimizing. Defaults to the provider configured as defaultFor the sku. */
  baselineProviderId?: string;
}
export interface Candidate {
  providerId: string;
  name: string;
  demo: boolean;
  sku: string;
  compatible: boolean;
  quote: { amountMicro: number; source: string; ageMs: number; fresh: boolean; latencyMs: number } | null;
  eligible: boolean;
  /** Why it isn't eligible, or "eligible". */
  reason: string;
  /** Firewall pre-check outcome (allow | hold | block) when it got that far. */
  policyOutcome: string | null;
}
export interface Recommendation {
  agentId: string;
  taskId: string;
  need: Need;
  candidates: Candidate[];
  recommended: { providerId: string; name: string; amountMicro: number; path: string; recipient: string } | null;
  baseline: { providerId: string; amountMicro: number; eligible: boolean } | null;
  /** baseline − recommended, only when the baseline itself was a fresh, eligible option. Not a realized saving. */
  estimatedSavingsMicro: number | null;
  explanation: string;
  demoProvidersOnly: boolean;
  generatedAt: string;
}

/** Pure and deterministic: same inputs → same recommendation. Nothing here can sign or pay. */
export function recommend(
  input: RecommendInput,
  providers: Provider[],
  quotes: QuoteResult[],
  ctx: { rules: Rule[] | null; state: SpendState; now: number; resolve: (recipient: string) => string | null },
): Recommendation {
  const byId = new Map(quotes.map((q) => [q.ok ? q.quote.providerId : q.providerId, q]));
  const fields = input.need.fields ?? [];
  const candidates: Candidate[] = [];
  const priced: { c: Candidate; p: Provider; q: Quote }[] = [];

  for (const p of providers) {
    const base = { providerId: p.id, name: p.name, demo: p.demo, sku: p.sku, quote: null, policyOutcome: null } as const;
    const compatible = p.sku === input.need.sku && p.category === input.need.category && fields.every((f) => p.schema.includes(f));
    if (!compatible) {
      candidates.push({ ...base, compatible: false, eligible: false, reason: p.sku !== input.need.sku ? `sells ${p.sku}, not ${input.need.sku}` : p.category !== input.need.category ? `category ${p.category}, not ${input.need.category}` : `response lacks ${fields.filter((f) => !p.schema.includes(f)).join(", ")}` });
      continue;
    }
    const qr = byId.get(p.id);
    if (!qr) { candidates.push({ ...base, compatible, eligible: false, reason: "no quote" }); continue; }
    if (!qr.ok) { candidates.push({ ...base, compatible, eligible: false, reason: qr.error }); continue; }
    const q = qr.quote;
    const ageMs = ctx.now - q.fetchedAt;
    const c: Candidate = { ...base, compatible, quote: { amountMicro: q.amountMicro, source: q.source, ageMs, fresh: ageMs <= QUOTE_TTL_MS, latencyMs: q.latencyMs }, eligible: false, reason: "", policyOutcome: null };
    candidates.push(c);
    if (!c.quote!.fresh) { c.reason = `quote is stale (${Math.round(ageMs / 1000)}s old)`; continue; }
    const expected = ctx.resolve(p.recipient);
    if (!expected || !isAddress(q.payTo) || getAddress(q.payTo) !== getAddress(expected)) { c.reason = "the 402's payee isn't the configured recipient address"; continue; }
    if (q.amountMicro !== p.configuredMicro) { c.reason = `live price $${(q.amountMicro / 1e6).toFixed(2)} differs from configured $${(p.configuredMicro / 1e6).toFixed(2)}`; continue; }
    if (q.amountMicro > input.maxAmountMicro) { c.reason = `$${(q.amountMicro / 1e6).toFixed(2)} is over the $${(input.maxAmountMicro / 1e6).toFixed(2)} maximum`; continue; }
    if (!ctx.rules) { c.reason = "no rules saved for this agent (everything is blocked)"; c.policyOutcome = "block"; continue; }
    const req: PaymentRequest = { requestId: "optimizer-precheck", agentId: input.agentId, taskId: input.taskId, recipient: p.recipient, amountMicro: q.amountMicro, category: p.category, purpose: `Optimizer pre-check: ${p.sku}` };
    const d = evaluate(ctx.rules, req, ctx.state, { now: new Date(ctx.now) });
    c.policyOutcome = d.outcome;
    if (d.outcome !== "allow") { c.reason = d.outcome === "hold" ? `would need your approval: ${d.reason}` : `your rules block it: ${d.reason}`; continue; }
    c.eligible = true;
    c.reason = "eligible";
    priced.push({ c, p, q });
  }

  const allMeasured = (xs: typeof priced) => xs.every((x) => Number.isFinite(x.q.latencyMs));
  priced.sort((a, b) => a.q.amountMicro - b.q.amountMicro || (allMeasured([a, b]) ? a.q.latencyMs - b.q.latencyMs : 0) || a.p.id.localeCompare(b.p.id));
  const best = priced[0];

  const baselineId = input.baselineProviderId ?? providers.find((p) => p.defaultFor === input.need.sku)?.id;
  const baseC = candidates.find((c) => c.providerId === baselineId);
  const baseline = baseC?.quote ? { providerId: baseC.providerId, amountMicro: baseC.quote.amountMicro, eligible: baseC.eligible } : null;
  const estimatedSavingsMicro = best && baseline?.eligible ? Math.max(0, baseline.amountMicro - best.q.amountMicro) : null;

  let explanation: string;
  if (!best) explanation = "No eligible provider: every compatible option was unavailable, over budget, stale, mismatched, or not allowed by your rules.";
  else {
    const ties = priced.filter((x) => x.q.amountMicro === best.q.amountMicro).length;
    explanation = `${best.p.name} is the cheapest eligible provider at $${(best.q.amountMicro / 1e6).toFixed(2)}${ties > 1 ? ` (tied on price with ${ties - 1} other; ${allMeasured(priced.slice(0, ties)) ? "lower measured quote latency" : "provider id"} breaks the tie)` : ""}.`;
    if (baseline && !baseline.eligible) explanation += ` The usual provider (${baseline.providerId}) isn't an eligible option, so no saving is claimed.`;
    else if (estimatedSavingsMicro) explanation += ` Estimated $${(estimatedSavingsMicro / 1e6).toFixed(2)} less than the usual provider (${baseline!.providerId}), based on both providers' live quotes.`;
    explanation += " The firewall still evaluates and reserves the payment, and the payer re-checks the seller's terms before paying.";
  }

  return {
    agentId: input.agentId, taskId: input.taskId, need: input.need, candidates,
    recommended: best ? { providerId: best.p.id, name: best.p.name, amountMicro: best.q.amountMicro, path: best.p.path, recipient: best.p.recipient } : null,
    baseline, estimatedSavingsMicro, explanation,
    demoProvidersOnly: providers.every((p) => p.demo),
    generatedAt: new Date(ctx.now).toISOString(),
  };
}

/** If the seller's live terms changed after the recommendation, the agent must ask again (and the firewall re-evaluates). */
export function requirementsChanged(rec: Recommendation, live: Quote): string | null {
  if (!rec.recommended) return "nothing was recommended";
  if (live.amountMicro !== rec.recommended.amountMicro) return `price changed from $${(rec.recommended.amountMicro / 1e6).toFixed(2)} to $${(live.amountMicro / 1e6).toFixed(2)}`;
  return null;
}

// ---------- storage: recommendations and realized savings ----------
export function initOptimizerTables(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS optimizer_recs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT NOT NULL, sku TEXT NOT NULL,
    provider_id TEXT, recipient TEXT, amount_micro INTEGER, baseline_provider_id TEXT, baseline_micro INTEGER,
    estimated_savings_micro INTEGER, request_id TEXT, json TEXT NOT NULL, created_at TEXT NOT NULL)`);
}

export function saveRecommendation(db: DB, rec: Recommendation, requestId?: string): string {
  initOptimizerTables(db);
  const id = `rec_${randomUUID()}`;
  db.prepare("INSERT INTO optimizer_recs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id, rec.agentId, rec.taskId, rec.need.sku, rec.recommended?.providerId ?? null, rec.recommended?.recipient ?? null, rec.recommended?.amountMicro ?? null,
    rec.baseline?.providerId ?? null, rec.baseline?.amountMicro ?? null, rec.estimatedSavingsMicro, requestId ?? null, JSON.stringify(rec), rec.generatedAt,
  );
  return id;
}

/**
 * Outcome of a recommendation. Realized saving needs evidence: the linked payment request SETTLED, to exactly the
 * recommended recipient and amount, and the baseline was a fresh eligible quote at recommendation time.
 */
export function recommendationOutcome(db: DB, recId: string) {
  initOptimizerTables(db);
  const r = db.prepare("SELECT * FROM optimizer_recs WHERE id=?").get(recId) as any;
  if (!r) return null;
  const req = r.request_id ? (db.prepare("SELECT status, recipient, amount_micro FROM requests WHERE request_id=?").get(r.request_id) as any) : null;
  const followed = Boolean(req && req.recipient === r.recipient && Number(req.amount_micro) === Number(r.amount_micro));
  const settled = followed && req.status === "settled";
  const realizedSavingsMicro = settled && r.estimated_savings_micro != null ? Number(r.estimated_savings_micro) : null;
  const status = !r.request_id ? "not linked to a payment" : !req ? "payment not found" : !followed ? "payment didn't follow the recommendation" : settled ? "settled" : `payment ${req.status}`;
  return { id: r.id, agentId: r.agent_id, taskId: r.task_id, sku: r.sku, providerId: r.provider_id, amountMicro: r.amount_micro, baselineProviderId: r.baseline_provider_id, baselineMicro: r.baseline_micro, estimatedSavingsMicro: r.estimated_savings_micro, requestId: r.request_id, status, realizedSavingsMicro, createdAt: r.created_at };
}

export function listRecommendations(db: DB, agentId?: string, limit = 20) {
  initOptimizerTables(db);
  const rows = (agentId ? db.prepare("SELECT id FROM optimizer_recs WHERE agent_id=? ORDER BY created_at DESC LIMIT ?").all(agentId, limit) : db.prepare("SELECT id FROM optimizer_recs ORDER BY created_at DESC LIMIT ?").all(limit)) as { id: string }[];
  const items = rows.map((x) => recommendationOutcome(db, x.id)!);
  return { items, realizedSavingsMicro: items.reduce((s, i) => s + (i.realizedSavingsMicro ?? 0), 0) };
}

export const optimizerResolve = (recipient: string) => resolveRecipient(recipient);
