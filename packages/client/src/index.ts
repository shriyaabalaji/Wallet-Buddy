// @agent-firewall/client: pay for x402 resources through the Wallet Buddy firewall from any agent framework.
//
// The caller never holds a key. Every payment goes:
//   seller 402 → firewall /v1/payments/evaluate (allow | hold | block) → firewall pays (/pay) or signs (/sign) → seller.
//
// Policy outcomes (block, hold) and failures are returned as values; nothing here throws for them.
import { randomUUID } from "node:crypto";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import type { Category } from "@agent-firewall/policy";
import type { Address, Hex } from "viem";

export type { Category };

export interface FirewallClientOptions {
  /** Base URL of the firewall, e.g. http://localhost:4000 */
  firewallUrl: string;
  /** The agent id this client pays as. Must match the token's agent on the firewall. */
  agentId: string;
  /** The agent's own firewall credential (FIREWALL_AGENT_TOKEN). */
  token?: string;
  /** MOCK_PAYMENTS=1 on the firewall: send a mock payment header when the firewall has no signer. */
  mockPayments?: boolean;
  /** Custom fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface PaymentRequest {
  /** Full URL of the x402 resource. */
  url: string;
  /** Who the firewall should treat as the payee. Defaults to the seller's 402 `payTo` address. */
  recipient?: string;
  category: Category;
  purpose: string;
  taskId: string;
  sourceContext?: string;
  /** Idempotency key for /evaluate. Generated when omitted. */
  requestId?: string;
}

export interface PaymentResult {
  outcome: "allow" | "block" | "hold" | "error";
  reason: string;
  requestId: string;
  /** decision.flags from /evaluate. */
  flags?: string[];
  amountMicro?: number;
  /** Parsed seller JSON on a successful payment. */
  data?: unknown;
  /** Wall-clock milliseconds of the /v1/payments/evaluate call. */
  decisionMs?: number;
}

export interface FirewallClient {
  requestPayment(req: PaymentRequest): Promise<PaymentResult>;
  quote(url: string): Promise<{ amountMicro: number; payTo: string } | null>;
  summary(): Promise<unknown>;
}

export interface PayerInfo { address: Address | null; mode: "local-key" | "circle-agent-wallet"; network: string }

// Gateway rejects authorizations valid for < ~7 days ("authorization_validity_too_short"), but
// @circle-fin/x402-batching 2.0.4 sellers advertise 4 days. Sign for 8 days. See docs/RESEARCH.md.
export const MIN_VALIDITY_S = 8 * 24 * 3600;

const toJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Low-level firewall HTTP helpers bound to one agent credential. `post` throws on a non-2xx with the
 * firewall's `{ error }` message. Useful for routes the high-level client doesn't wrap (e.g. the optimizer).
 */
export function createFirewallApi(opts: Pick<FirewallClientOptions, "firewallUrl" | "token" | "fetch">) {
  const f = opts.fetch ?? globalThis.fetch;
  const base = opts.firewallUrl.replace(/\/+$/, "");
  const token = opts.token?.trim();
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const parse = async (r: Response) => {
    const text = await r.text();
    let j: any;
    try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text }; }
    if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
    return j;
  };
  let payerInfo: Promise<PayerInfo> | null = null;
  return {
    auth,
    fetch: f,
    post: async (path: string, body: unknown): Promise<any> =>
      parse(await f(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) })),
    get: async (path: string): Promise<any> => parse(await f(base + path, { headers: auth })),
    /** GET /v1/signer, cached. A failed lookup is not cached. */
    payer: (): Promise<PayerInfo> =>
      (payerInfo ??= f(`${base}/v1/signer`).then(parse).catch((e) => { payerInfo = null; throw e; })),
  };
}

interface Required402 { required: any; option: any }

/** Read the seller's 402 and pick the Arc Gateway option for the firewall's network. */
async function read402(f: typeof fetch, url: string, network: string): Promise<Required402 | { error: string }> {
  const first = await f(url);
  if (first.status !== 402) return { error: `expected 402, got ${first.status}` };
  const required = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
  const option = (required.accepts ?? []).find((o: any) => o.network === network && o.extra?.name === "GatewayWalletBatched");
  if (!option) return { error: "seller has no Arc Gateway option" };
  return { required, option };
}

export function createFirewallClient(opts: FirewallClientOptions): FirewallClient {
  const api = createFirewallApi(opts);
  const f = api.fetch;

  /** A BatchEvmSigner whose signTypedData is a call to the firewall. The key never leaves the firewall. */
  async function firewallScheme(requestId: string) {
    const { address } = await api.payer();
    if (!address) return null;
    return new BatchEvmScheme({
      address,
      signTypedData: async (td) => (await api.post(`/v1/payments/${requestId}/sign`, { typedData: toJson(td) })).signature as Hex,
    });
  }

  async function requestPayment(req: PaymentRequest): Promise<PaymentResult> {
    const requestId = req.requestId ?? `req_${randomUUID()}`;
    let amountMicro: number | undefined;
    let mode: PayerInfo["mode"];
    let found: Required402;
    try {
      const payer = await api.payer();
      mode = payer.mode;
      const r = await read402(f, req.url, payer.network);
      if ("error" in r) return { outcome: "error", reason: r.error, requestId };
      found = r;
      amountMicro = Number(r.option.amount);
    } catch (e) {
      return { outcome: "error", reason: errMsg(e), requestId };
    }
    const { required, option } = found;

    let decision: any;
    let decisionMs: number;
    const t0 = performance.now();
    try {
      decision = await api.post("/v1/payments/evaluate", {
        requestId, agentId: opts.agentId, taskId: req.taskId, recipient: req.recipient ?? option.payTo,
        amountMicro, category: req.category, purpose: req.purpose, sourceContext: req.sourceContext,
      });
      decisionMs = Math.round(performance.now() - t0);
    } catch (e) {
      return { outcome: "error", reason: errMsg(e), requestId, amountMicro, decisionMs: Math.round(performance.now() - t0) };
    }
    const base = { requestId, amountMicro, decisionMs, flags: Array.isArray(decision.flags) ? (decision.flags as string[]) : undefined };
    if (decision.outcome !== "allow") {
      const outcome = decision.outcome === "block" || decision.outcome === "hold" ? decision.outcome : "error";
      return { ...base, outcome, reason: String(decision.reason ?? `unexpected decision: ${decision.outcome}`) };
    }

    if (mode === "circle-agent-wallet") {
      // Mainnet: the firewall pays from the Circle Agent Wallet and hands back the response body.
      // On failure the firewall has already recorded the outcome itself.
      try {
        const { body } = await api.post(`/v1/payments/${requestId}/pay`, { url: req.url });
        return { ...base, outcome: "allow", reason: decision.reason, data: JSON.parse(body) };
      } catch (e) {
        return { ...base, outcome: "error", reason: errMsg(e) };
      }
    }

    try {
      let header: string;
      const scheme = await firewallScheme(requestId);
      if (scheme) {
        // Gateway rejects authorizations valid for < ~7 days ("authorization_validity_too_short"), but
        // @circle-fin/x402-batching 2.0.4 sellers advertise 4 days. Sign for 8 days. See docs/RESEARCH.md.
        const signOption = { ...option, maxTimeoutSeconds: Math.max(option.maxTimeoutSeconds ?? 0, MIN_VALIDITY_S) };
        const payload = await scheme.createPaymentPayload(required.x402Version ?? 2, signOption);
        header = Buffer.from(JSON.stringify({ ...payload, resource: required.resource, accepted: option })).toString("base64");
      } else if (opts.mockPayments) {
        header = Buffer.from(JSON.stringify({ mock: true, requestId })).toString("base64");
      } else {
        throw new Error("firewall has no signer configured");
      }
      const paid = await f(req.url, { headers: { "Payment-Signature": header } });
      if (!paid.ok) throw new Error(`seller rejected payment: ${paid.status} ${await paid.text()}`);
      const settle = paid.headers.get("PAYMENT-RESPONSE");
      const tx = settle ? JSON.parse(Buffer.from(settle, "base64").toString("utf8")).transaction : undefined;
      await api.post(`/v1/payments/${requestId}/settled`, { txHash: tx || undefined });
      return { ...base, outcome: "allow", reason: decision.reason, data: await paid.json() };
    } catch (e) {
      await api.post(`/v1/payments/${requestId}/failed`, {}).catch(() => {});
      return { ...base, outcome: "error", reason: errMsg(e) };
    }
  }

  async function quote(url: string) {
    try {
      const { network } = await api.payer();
      const r = await read402(f, url, network);
      if ("error" in r) return null;
      return { amountMicro: Number(r.option.amount), payTo: String(r.option.payTo) };
    } catch {
      return null;
    }
  }

  return {
    requestPayment,
    quote,
    summary: () => api.get(`/v1/agents/${encodeURIComponent(opts.agentId)}/summary`),
  };
}

/** One-shot convenience: create a client and make one payment request. */
export async function requestPayment(opts: FirewallClientOptions & PaymentRequest): Promise<PaymentResult> {
  const { firewallUrl, agentId, token, mockPayments, fetch, ...req } = opts;
  return createFirewallClient({ firewallUrl, agentId, token, mockPayments, fetch }).requestPayment(req);
}
