import { config } from "./config";
import { openDb } from "./db";
import { createApp, flushDecisionsToArc, paymentsInFlight } from "./server";
import { expireHolds } from "./approvals";
import { releaseStaleReservations } from "./engine";
import { arcStatus } from "./arc";
import { smsConfigured } from "./sms";
import { sweepBuyerWallet, topUpGateway } from "./funding";
import { authConfig, authSummary } from "./auth";

const db = openDb(config.dbPath);
createApp(db).listen(config.port, () => {
  console.log(`Agent Firewall listening on http://localhost:${config.port}`);
  console.log(`  db=${config.dbPath} arc=${JSON.stringify(arcStatus())} sms=${smsConfigured() ? "twilio" : "dry-run (console)"} llm=${config.llmApiKey ? "claude" : "offline parser"}`);
  const a = authSummary(authConfig);
  console.log(`  auth: owner=${a.owner ? "on" : "NOT CONFIGURED (owner routes return 503)"} agents=[${a.agents.join(", ") || "none"}] service=${a.service ? "on" : "off"}`);
  for (const p of authConfig.problems) console.warn(`  [auth] ${p}`);
  if (a.unauthenticatedAgents) console.warn("  [auth] WARNING: FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS=1, so agent routes accept requests with no token (testnet migration only).");
});

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await expireHolds(db);
    // Unsigned, unpaid reservations past their TTL give their budget back. Signed or uncertain payments never do:
    // they wait for an outcome report or owner reconciliation.
    const released = releaseStaleReservations(db, { ttlMs: config.reservationTtlMinutes * 60_000, inFlight: paymentsInFlight });
    if (released.length) console.log(`[reservations] released ${released.length} unused reservation(s) older than ${config.reservationTtlMinutes} min`);
    await flushDecisionsToArc(db);
  } finally {
    busy = false;
  }
}, 10_000);

// Buyer exposure cap: sweep idle buyer USDC to the treasury, then top up Gateway (<= daily cap per UTC day).
let funding = false;
async function fundingTick() {
  if (funding) return;
  funding = true;
  try {
    await sweepBuyerWallet();
    await topUpGateway(db);
  } catch (e) {
    console.error("[funding]", e instanceof Error ? e.message.split("\n")[0] : e);
  } finally {
    funding = false;
  }
}
void fundingTick();
setInterval(fundingTick, 60_000);
