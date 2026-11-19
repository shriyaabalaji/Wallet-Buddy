// stdio entrypoint. stdout is the MCP channel: log only to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFirewallClient } from "@agent-firewall/client";
import { createMcpServer } from "./server";

// Same isolation guard as the demo agent: this process speaks for an agent and must never see a signing key or secret.
const LEAKED = Object.keys(process.env).filter((k) => /PRIVATE_KEY|SECRET|AUTH_TOKEN|API_KEY|MNEMONIC/i.test(k) && process.env[k]);
if (LEAKED.length) {
  console.error(`Refusing to start: the MCP server can see secrets (${LEAKED.join(", ")}). Pass only FIREWALL_URL, FIREWALL_AGENT_ID, FIREWALL_AGENT_TOKEN.`);
  process.exit(78);
}

const firewallUrl = process.env.FIREWALL_URL ?? "http://localhost:4000";
const agentId = process.env.FIREWALL_AGENT_ID ?? "research-agent";
const token = process.env.FIREWALL_AGENT_TOKEN?.trim() || undefined;
if (!token) console.error("FIREWALL_AGENT_TOKEN is not set; the firewall will refuse payments unless it allows unauthenticated agents (testnet only).");

const client = createFirewallClient({ firewallUrl, agentId, token, mockPayments: process.env.MOCK_PAYMENTS === "1" });
await createMcpServer(client).connect(new StdioServerTransport());
console.error(`wallet-buddy MCP server on stdio · agent ${agentId} · firewall ${firewallUrl}`);
