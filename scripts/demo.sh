#!/usr/bin/env bash
# npm run demo: the full Wallet Buddy scenario on Arc testnet (real payments, real Arc txs). Repeatable.
# Starts the firewall and sellers if they aren't already running (and stops the ones it started), then runs scripts/demo.ts.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
[ -f .env.firewall ] || { echo "Missing .env.firewall (copy .env.firewall.example and fill it in; see README → Judge quickstart)." >&2; exit 1; }
[ -f .env.agent ] || cp .env.agent.example .env.agent
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/wallet-buddy-demo.XXXXXX")
STARTED=()
up() { curl -sf -o /dev/null --max-time 2 "$1"; }
if ! up localhost:4000/health; then
  echo "Starting firewall (logs: $LOGS/firewall.log)…"; npm run dev:firewall > "$LOGS/firewall.log" 2>&1 & STARTED+=(4000)
fi
if ! up localhost:4200/health; then
  echo "Starting sellers (logs: $LOGS/sellers.log)…"; npm run dev:sellers > "$LOGS/sellers.log" 2>&1 & STARTED+=(4200)
fi
cleanup() { set +e; for p in "${STARTED[@]:-}"; do [ -n "$p" ] && pids=$(lsof -ti ":$p" 2>/dev/null) && [ -n "$pids" ] && kill $pids 2>/dev/null; done; return 0; }
trap cleanup EXIT
for i in $(seq 1 60); do up localhost:4000/health && up localhost:4200/health && break; sleep 1; done
up localhost:4000/health || { echo "Firewall didn't start; see $LOGS/firewall.log" >&2; exit 1; }
# Warm the sellers (first ESPN fetch) so the first paid call isn't slow.
curl -s -o /dev/null --max-time 10 "localhost:4200/oddsapi/odds" || true
curl -s -o /dev/null --max-time 10 "localhost:4200/sportsfeed/injuries" || true
set -a; . ./.env.firewall; set +a
npx tsx scripts/demo.ts
