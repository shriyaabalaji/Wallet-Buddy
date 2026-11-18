#!/usr/bin/env bash
# Runs the whole demo locally with throwaway keys and MOCK seller settlement (no testnet funds).
# The firewall signer is real; only the seller-side Gateway verify/settle is mocked.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$(mktemp -d)}; mkdir -p "$WORK"
FWP=${FWP:-4300}; SP=${SP:-4301}
# Refuse to run against something already on our ports (a stale seller from an earlier run would answer instead).
for p in $FWP $SP; do if lsof -ti ":$p" >/dev/null 2>&1; then echo "Port $p is in use; stop that process (lsof -ti :$p | xargs kill) and retry." >&2; exit 1; fi; done
cd "$ROOT/apps/firewall"
# The throwaway buyer key goes ONLY to the firewall process (never exported, so the agent can't inherit it).
eval "$(node --input-type=module -e 'import {generatePrivateKey,privateKeyToAccount} from "viem/accounts"; const a=()=>privateKeyToAccount(generatePrivateKey()).address; console.log(`DEMO_BUYER_KEY=${generatePrivateKey()}; export SELLER_ADDRESSES=sportsfeed=${a()},oddsapi=${a()}`)')"
export MOCK_PAYMENTS=1
export PAYMENT_MODE=local-key
# Throwaway firewall credentials for this run: owner (used below to save rules) and one token per agent.
tok() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
OWNER_TOKEN=$(tok); RESEARCH_TOKEN=$(tok); RACE_TOKEN=$(tok)
# Each agent run below gets its own token. Fallback for an older run-agent.sh that doesn't forward
# FIREWALL_AGENT_TOKEN: allow unauthenticated agents for this local run only. Owner routes stay protected either way.
LEGACY_AGENTS=0; grep -q FIREWALL_AGENT_TOKEN "$ROOT/scripts/run-agent.sh" || LEGACY_AGENTS=1
FIREWALL_OWNER_TOKEN="$OWNER_TOKEN" FIREWALL_AGENT_TOKENS="research-agent=$RESEARCH_TOKEN,race-agent=$RACE_TOKEN" FIREWALL_ALLOW_UNAUTHENTICATED_AGENTS=$LEGACY_AGENTS \
BUYER_PRIVATE_KEY="$DEMO_BUYER_KEY" FIREWALL_DB="$WORK/demo.db" FIREWALL_PORT=$FWP npx tsx src/index.ts > "$WORK/firewall.log" 2>&1 & FW_PID=$!
(cd "$ROOT/apps/sellers" && SELLERS_PORT=$SP npx tsx src/index.ts > "$WORK/sellers.log" 2>&1) & S_PID=$!
# Kill by port too: $S_PID is a subshell, and killing it alone leaves the seller's node process running.
cleanup() { set +e; kill "$FW_PID" "$S_PID" 2>/dev/null; for p in "$FWP" "$SP"; do pids=$(lsof -ti ":$p" 2>/dev/null); [ -n "$pids" ] && kill $pids 2>/dev/null; done; return 0; }
trap cleanup EXIT
for i in $(seq 1 30); do curl -sf "localhost:$FWP/health" >/dev/null && curl -sf "localhost:$SP/health" >/dev/null && break; sleep 0.5; done
post() { curl -s "localhost:$FWP$1" -H 'Content-Type: application/json' -H "Authorization: Bearer $OWNER_TOKEN" -d "$2"; }
post /v1/policy '{"agentId":"research-agent","confirmed":true,"notify":{"phone":"+15125550100","events":["hold"]},"rules":[{"id":"task-budget","kind":"taskBudget","taskId":"*","maxMicro":10000000},{"id":"day-budget","kind":"periodBudget","period":"day","maxMicro":5000000},{"id":"ask-first","kind":"approvalThreshold","aboveMicro":1000000},{"id":"approved-recipients","kind":"allowlist","recipients":["sportsfeed","oddsapi"]}]}' >/dev/null
# Race demo needs exactly $1.00 left: give the race its own agent+task with a $1.00 budget.
post /v1/policy '{"agentId":"race-agent","confirmed":true,"rules":[{"id":"task-budget","kind":"taskBudget","taskId":"*","maxMicro":1000000},{"id":"approved-recipients","kind":"allowlist","recipients":["sportsfeed","oddsapi"]}]}' >/dev/null
export FIREWALL_URL="http://localhost:$FWP" SELLERS_URL="http://localhost:$SP"
AGENT="$ROOT/scripts/run-agent.sh"
FIREWALL_AGENT_TOKEN="$RESEARCH_TOKEN" "$AGENT" normal 3
AGENT_ID=race-agent TASK_ID=race FIREWALL_AGENT_TOKEN="$RACE_TOKEN" "$AGENT" race
FIREWALL_AGENT_TOKEN="$RESEARCH_TOKEN" "$AGENT" attack
echo; echo "── text message that would be sent ──"; grep "sms:dry" "$WORK/firewall.log" || true
echo; echo "logs in $WORK"
