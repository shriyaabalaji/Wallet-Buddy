// B3 reservation timeout + reconciliation, and B4 settlement evidence, over the real ledger.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyHash, usdToMicro, type Rule } from "@agent-firewall/policy";
import { openDb, type DB } from "../src/db";
import { evaluateAndReserve, markFailed, markSettled, reconcilePayment, releaseStaleReservations, savePolicy, spendState } from "../src/engine";
import { settlementOf, todayTotals } from "../src/overview";

const MIN = 60_000;
const TTL = 15 * MIN;
let dir: string;
let db: DB;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resv-"));
  db = openDb(join(dir, "t.db"));
  const rules: Rule[] = [
    { id: "task", kind: "taskBudget", taskId: "*", maxMicro: usdToMicro(10) },
    { id: "ask", kind: "approvalThreshold", aboveMicro: usdToMicro(1) },
  ];
  savePolicy(db, "a", rules, policyHash(rules));
});
afterEach(() => {
  delete process.env.MOCK_PAYMENTS;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const ev = (usd: number, at = Date.now()) =>
  evaluateAndReserve(db, { requestId: `r${++seq}`, agentId: "a", taskId: "t", recipient: "sportsfeed", amountMicro: usdToMicro(usd), category: "data", purpose: `p${seq}` }, { now: new Date(at) }).decision.requestId;
const row = (id: string) => db.prepare("SELECT r.*, h.resolve_tx FROM requests r LEFT JOIN holds h ON h.request_id=r.request_id WHERE r.request_id=?").get(id) as any;
const sign = (id: string) => db.prepare("UPDATE requests SET signed_ms=? WHERE request_id=?").run(Date.now(), id);
const spent = () => spendState(db, "a", "t", new Date()).taskSpentMicro;

describe("B3 reservation timeout", () => {
  it("releases an unsigned, unpaid reservation only after the TTL", () => {
    const old = ev(0.5, Date.now() - 20 * MIN);
    const fresh = ev(0.5, Date.now() - 5 * MIN);
    expect(spent()).toBe(1_000_000);
    expect(releaseStaleReservations(db, { ttlMs: TTL })).toEqual([old]);
    expect(row(old)).toMatchObject({ status: "released", signed_ms: null });
    expect(row(old).failure_reason).toMatch(/expired unused/);
    expect(row(fresh).status).toBe("reserved");
    expect(spent()).toBe(500_000);
    expect(releaseStaleReservations(db, { ttlMs: TTL })).toEqual([]); // idempotent
  });

  it("never releases a payment that was signed, reported failed after signing, settled, or is held", () => {
    const long = Date.now() - 30 * 24 * 3600_000;
    const signed = ev(0.5, long); sign(signed);
    const uncertain = ev(0.5, long); sign(uncertain); markFailed(db, uncertain);
    const settled = ev(0.5, long); markSettled(db, settled);
    const held = ev(2, long);
    expect(row(held).status).toBe("held");
    expect(releaseStaleReservations(db, { ttlMs: TTL })).toEqual([]);
    expect([row(signed).status, row(uncertain).status, row(settled).status, row(held).status]).toEqual(["reserved", "unconfirmed", "settled", "held"]);
  });

  it("skips a reservation a /pay call is working on", () => {
    const id = ev(0.5, Date.now() - 20 * MIN);
    expect(releaseStaleReservations(db, { ttlMs: TTL, inFlight: new Set([id]) })).toEqual([]);
    expect(row(id).status).toBe("reserved");
  });

  it("a released reservation can't be signed or settled afterwards", async () => {
    const id = ev(0.5, Date.now() - 20 * MIN);
    releaseStaleReservations(db, { ttlMs: TTL });
    expect(markSettled(db, id)).toBe(false);
    expect(markFailed(db, id)).toBe(false);
    expect(row(id).status).toBe("released");
  });
});

describe("B3 owner reconciliation of uncertain outcomes", () => {
  it("paid keeps it counted as settled (with the reference); not_paid returns the budget", () => {
    const a = ev(0.5); sign(a); markFailed(db, a);
    const b = ev(0.5); sign(b); // signed, never reported
    expect(spent()).toBe(1_000_000);
    expect(reconcilePayment(db, a, "paid", { txHash: "0xabc", note: "seen in Gateway history" })).toEqual({ status: "settled" });
    expect(row(a)).toMatchObject({ status: "settled", settled_tx: "0xabc" });
    expect(row(a).reconciled_ms).toBeTypeOf("number");
    expect(reconcilePayment(db, b, "not_paid")).toEqual({ status: "released" });
    expect(spent()).toBe(500_000);
  });

  it("refuses rows that aren't uncertain, and payments still in flight", () => {
    const unsigned = ev(0.5);
    expect(() => reconcilePayment(db, unsigned, "not_paid")).toThrow(/never signed/);
    const done = ev(0.5); markSettled(db, done);
    expect(() => reconcilePayment(db, done, "not_paid")).toThrow(/settled/);
    const busy = ev(0.5); sign(busy);
    expect(() => reconcilePayment(db, busy, "not_paid", { inFlight: new Set([busy]) })).toThrow(/still being made/);
    expect(() => reconcilePayment(db, "nope", "paid")).toThrow(/Unknown/);
    expect([row(unsigned).status, row(done).status, row(busy).status]).toEqual(["reserved", "settled", "reserved"]);
  });
});

describe("B4 settlement evidence", () => {
  it("labels each state by what is actually known", () => {
    const pending = ev(0.1);
    const awaiting = ev(0.1); sign(awaiting);
    const uncertain = ev(0.1); sign(uncertain); markFailed(db, uncertain);
    const noRef = ev(0.1); markSettled(db, noRef);
    const withRef = ev(0.1); markSettled(db, withRef, "0xfeed");
    process.env.MOCK_PAYMENTS = "1";
    const mock = ev(0.1); markSettled(db, mock);
    delete process.env.MOCK_PAYMENTS;
    const held = ev(2);
    const blocked = (() => { const id = ev(0.1); db.prepare("UPDATE requests SET status='blocked' WHERE request_id=?").run(id); return id; })();
    const states = [pending, awaiting, uncertain, noRef, withRef, mock, held, blocked].map((id) => settlementOf(row(id)).state);
    expect(states).toEqual(["pending_signature", "awaiting_outcome", "uncertain", "accepted_no_reference", "accepted_with_reference", "simulated", "held", "not_paid"]);
    expect(settlementOf(row(withRef))).toMatchObject({ reference: "0xfeed", verifiedOnchain: false, simulated: false });
    expect(settlementOf(row(mock))).toMatchObject({ simulated: true, verifiedOnchain: false, label: expect.stringMatching(/no money moved/) });
    expect(settlementOf(row(uncertain)).needsReconciliation).toBe(true);
    // Signed and silent: only flagged once it's been quiet longer than the reservation TTL.
    expect(settlementOf(row(awaiting)).needsReconciliation).toBe(false);
    expect(settlementOf(row(awaiting), Date.now() + 20 * MIN).needsReconciliation).toBe(true);
  });

  it("only a vault release we sent and saw succeed counts as confirmed onchain", () => {
    const approved = ev(2);
    db.prepare("UPDATE requests SET status='approved' WHERE request_id=?").run(approved);
    expect(settlementOf(row(approved)).state).toBe("approved_unrecorded");
    db.prepare("UPDATE holds SET resolve_tx='0x1234' WHERE request_id=?").run(approved);
    expect(settlementOf(row(approved))).toMatchObject({ state: "confirmed_onchain", verifiedOnchain: true, reference: "0x1234" });
  });

  it("today's totals split paid and in-progress money by evidence, and the old fields are unchanged", () => {
    const noRef = ev(0.1); markSettled(db, noRef);
    const withRef = ev(0.2); markSettled(db, withRef, "0xfeed");
    process.env.MOCK_PAYMENTS = "1";
    const mock = ev(0.3); markSettled(db, mock);
    delete process.env.MOCK_PAYMENTS;
    ev(0.4); // pending signature
    const awaiting = ev(0.5); sign(awaiting);
    const unc = ev(0.6); sign(unc); markFailed(db, unc);
    const t = todayTotals(db, "a");
    expect(t.paidMicro).toBe(600_000);
    expect(t.inProgressMicro).toBe(1_500_000);
    expect(t.evidence).toEqual({
      simulatedMicro: 300_000, acceptedNoReferenceMicro: 100_000, acceptedWithReferenceMicro: 200_000, confirmedOnchainMicro: 0, approvedUnrecordedMicro: 0,
      pendingSignatureMicro: 400_000, awaitingOutcomeMicro: 500_000, uncertainMicro: 600_000, uncertainCount: 1,
    });
  });
});

describe("reconcile API", () => {
  it("is owner-only; activity carries settlement evidence; ?status=reconcile lists what needs the owner", async () => {
    const { createApp } = await import("../src/server");
    const { loadAuth } = await import("../src/auth");
    const tok = () => randomBytes(32).toString("base64url");
    const OWNER = tok();
    const AGENT = tok();
    const server = createApp(db, loadAuth({ FIREWALL_OWNER_TOKEN: OWNER, FIREWALL_AGENT_TOKENS: `a=${AGENT}` }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: (await r.json()) as any };
    };
    try {
      const id = ev(0.5); sign(id); markFailed(db, id);
      const fine = ev(0.1); markSettled(db, fine);
      expect((await call("POST", `/v1/payments/${id}/reconcile`, AGENT, { outcome: "not_paid" })).status).toBe(403);
      expect((await call("POST", `/v1/payments/${id}/reconcile`, undefined, { outcome: "not_paid" })).status).toBe(401);
      expect((await call("POST", `/v1/payments/${id}/reconcile`, OWNER, { outcome: "maybe" })).status).toBe(400);
      expect((await call("POST", `/v1/payments/${fine}/reconcile`, OWNER, { outcome: "not_paid" })).status).toBe(409);

      const todo = await call("GET", "/v1/activity?agentId=a&status=reconcile", OWNER);
      expect(todo.json.items.map((i: any) => i.requestId)).toEqual([id]);
      expect(todo.json.items[0].settlement).toMatchObject({ state: "uncertain", needsReconciliation: true });

      expect((await call("POST", `/v1/payments/${id}/reconcile`, OWNER, { outcome: "not_paid", note: "not in Gateway history" })).json).toEqual({ status: "released" });
      const after = await call("GET", "/v1/activity?agentId=a", OWNER);
      const item = after.json.items.find((i: any) => i.requestId === id);
      expect(item).toMatchObject({ status: "released", settlement: { state: "not_paid", reconciledByOwner: true } });
      expect((await call("GET", "/v1/activity?agentId=a&status=reconcile", OWNER)).json.items).toEqual([]);
      // Additive fields only: the existing ones are still there.
      expect(Object.keys(item)).toEqual(expect.arrayContaining(["requestId", "status", "outcome", "sentence", "arcTx", "settlement"]));
      const health = await call("GET", "/health", OWNER);
      expect(health.json).toMatchObject({ mockPayments: false, reservationTtlMinutes: 15 });
      expect((await call("GET", "/health")).json).toEqual({ ok: true });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
