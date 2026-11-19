# @agent-firewall/mcp: Wallet Buddy as an MCP server

Lets any MCP-capable agent (Claude Desktop, Claude Code, IDE agents) pay for x402 resources **only through the
firewall**. The server holds no signing key, just the agent's own firewall credential, which can request payments for
that one agent but can't change rules, approve holds or resume a paused agent.

It is a thin stdio wrapper around [`@agent-firewall/client`](../../packages/client/src/index.ts).

## Tools

| Tool | Inputs | Returns (JSON text) |
|---|---|---|
| `pay_with_firewall` | `url`, `purpose`, `taskId`, `category` (`data` \| `inference` \| `compute` \| `other`, default `data`), `recipient?` (defaults to the seller's 402 `payTo`), `sourceContext?` | `{ outcome: "allow"\|"block"\|"hold"\|"error", reason, flags, data?, requestId, amountMicro?, decisionMs? }`. `data` is the seller's JSON on `allow`. `isError` is set only for `error`; `block`/`hold` are normal policy answers |
| `firewall_summary` | none | The agent's `GET /v1/agents/:agentId/summary` (read-only): status, task and daily spend vs. budgets, pending holds, recent activity, rules |

## Config (environment)

| Variable | Default | |
|---|---|---|
| `FIREWALL_URL` | `http://localhost:4000` | The firewall |
| `FIREWALL_AGENT_ID` | `research-agent` | The agent id this server pays as (must match the token) |
| `FIREWALL_AGENT_TOKEN` | none | The agent's credential (`FIREWALL_AGENT_TOKENS` on the firewall) |
| `MOCK_PAYMENTS` | unset | `1` only when the firewall runs with `MOCK_PAYMENTS=1` and has no signer |

Like the demo agent, the server refuses to start if it can see anything that looks like a secret
(`*PRIVATE_KEY*`, `*SECRET*`, `*AUTH_TOKEN*`, `*API_KEY*`, `*MNEMONIC*`). Pass it only the variables above.

## Run

```bash
npm install                       # at the repo root
npm start -w @agent-firewall/mcp  # speaks MCP on stdio
```

MCP clients should launch `tsx` directly, not `npm start`: npm prints a banner to stdout, which is the MCP channel.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "wallet-buddy": {
      "command": "/ABS/PATH/TO/repo/node_modules/.bin/tsx",
      "args": ["/ABS/PATH/TO/repo/apps/mcp/src/index.ts"],
      "env": {
        "FIREWALL_URL": "http://localhost:4000",
        "FIREWALL_AGENT_ID": "research-agent",
        "FIREWALL_AGENT_TOKEN": "<the agent's token>"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add wallet-buddy \
  -e FIREWALL_URL=http://localhost:4000 \
  -e FIREWALL_AGENT_ID=research-agent \
  -e FIREWALL_AGENT_TOKEN=<the agent's token> \
  -- /ABS/PATH/TO/repo/node_modules/.bin/tsx /ABS/PATH/TO/repo/apps/mcp/src/index.ts
```

or the same entry as above in a project `.mcp.json` (`{ "mcpServers": { "wallet-buddy": { ... } } }`).

## Test

`npm test -w @agent-firewall/mcp` connects an SDK `Client` over `InMemoryTransport`, lists both tools and calls them
against a stub firewall client. No firewall, seller or money involved.
