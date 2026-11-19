// Child process for budget-property.test.ts: opens its own connection to the shared DB file and fires its share of
// every seed's request stream. Args: dbPath specPath workerIndex startAtMs. Prints [{ id, outcome }] as JSON.
import { readFileSync } from "node:fs";
import { openDb } from "../src/db";
import { evaluateAndReserve, markFailed, markSettled } from "../src/engine";

interface Req { id: string; taskId: string; amountMicro: number; recipient: string; worker: number; after: "settle" | "fail" | null }
interface Seed { agentId: string; requests: Req[] }

const [dbPath, specPath, idxStr, startAtStr] = process.argv.slice(2);
const db = openDb(dbPath!);
const seeds = JSON.parse(readFileSync(specPath!, "utf8")) as Seed[];
const me = Number(idxStr);
const startAt = Number(startAtStr);
while (Date.now() < startAt) {} // spin so all processes start together

const out: { id: string; outcome: string }[] = [];
for (const s of seeds) {
  for (const r of s.requests) {
    if (r.worker !== me) continue;
    const res = evaluateAndReserve(db, {
      requestId: r.id, agentId: s.agentId, taskId: r.taskId, recipient: r.recipient, amountMicro: r.amountMicro, category: "data", purpose: "property",
    });
    out.push({ id: r.id, outcome: res.decision.outcome });
    if (res.decision.outcome === "allow" && !res.duplicate) {
      if (r.after === "settle") markSettled(db, r.id);
      else if (r.after === "fail") markFailed(db, r.id); // unsigned → released: budget goes back mid-stream
    }
  }
}
process.stdout.write(JSON.stringify(out));
