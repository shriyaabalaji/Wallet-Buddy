#!/usr/bin/env bash
# Start the demo agent with a CLEAN environment: nothing from the caller's shell except an allowlist
# of harmless settings. The agent never sees the firewall's keys, even if they are exported in this shell.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Its own empty HOME, so it can't pick up the firewall user's Circle CLI session (~/.circle-cli) by default.
AGENT_HOME=$(mktemp -d "${TMPDIR:-/tmp}/agent-home.XXXXXX")
ARGS=(PATH="$PATH" HOME="$AGENT_HOME")
# FIREWALL_AGENT_TOKEN is the agent's own credential (bound to AGENT_ID), not a firewall secret.
for v in FIREWALL_URL SELLERS_URL AGENT_ID TASK_ID MOCK_PAYMENTS FIREWALL_AGENT_TOKEN; do
  if [ -n "${!v:-}" ]; then ARGS+=("$v=${!v}"); fi
done
cd "$ROOT/apps/agent"
exec env -i "${ARGS[@]}" "$ROOT/node_modules/.bin/tsx" --env-file-if-exists="$ROOT/.env.agent" src/index.ts "$@"
