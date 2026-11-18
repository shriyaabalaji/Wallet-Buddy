// Child process: opens its own connection to the shared DB file and fires requests.
import { openDb } from "../src/db";
import { evaluateAndReserve } from "../src/engine";

const [dbPath, prefix, countStr, amountStr, startAtStr, taskMode] = process.argv.slice(2);
const db = openDb(dbPath!);
const startAt = Number(startAtStr);
while (Date.now() < startAt) {} // spin so all processes start together
const outcomes: string[] = [];
for (let i = 0; i < Number(countStr); i++) {
  const r = evaluateAndReserve(db, {
    requestId: `${prefix}-${i}`, agentId: "race-agent", taskId: taskMode === "distinct" ? `${prefix}-task-${i}` : "race-task",
    recipient: "sportsfeed", amountMicro: Number(amountStr), category: "data", purpose: "race",
  });
  outcomes.push(r.decision.outcome);
}
process.stdout.write(JSON.stringify(outcomes));
