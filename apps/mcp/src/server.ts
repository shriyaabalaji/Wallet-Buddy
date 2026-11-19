// MCP server exposing the Wallet Buddy firewall as tools, so any MCP-capable agent (Claude Desktop, Claude Code,
// IDE agents, ...) pays for x402 resources only through the firewall. The server holds no key: it holds only the
// agent's own firewall credential, which can request payments but never change rules or approve holds.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { CATEGORIES } from "@agent-firewall/policy";
import type { FirewallClient } from "@agent-firewall/client";

export const SERVER_NAME = "wallet-buddy-firewall";
export const SERVER_VERSION = "0.1.0";

const text = (v: unknown) => [{ type: "text" as const, text: JSON.stringify(v, null, 2) }];

export function createMcpServer(client: FirewallClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "pay_with_firewall",
    {
      title: "Pay for an x402 resource through the firewall",
      description:
        "Fetch a paid (HTTP 402 / x402) URL. The payment is checked against the owner's spending policy first; " +
        "outcome is allow (paid; data holds the seller's JSON), block (refused), hold (waiting for the owner's approval; " +
        "do not retry), or error. Never try to pay by other means after a block or hold.",
      inputSchema: {
        url: z.string().url().describe("Full URL of the x402 resource"),
        purpose: z.string().min(1).describe("Why this purchase is needed, in a sentence"),
        taskId: z.string().min(1).describe("The task this spend belongs to (budgets are per task)"),
        category: z.enum(CATEGORIES).default("data").describe("Spend category"),
        recipient: z.string().optional().describe("Payee name or address; defaults to the seller's 402 payTo address"),
        sourceContext: z.string().optional().describe("What led to this payment (e.g. which response suggested it)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, purpose, taskId, category, recipient, sourceContext }) => {
      const r = await client.requestPayment({ url, purpose, taskId, category, recipient, sourceContext });
      return {
        content: text({ outcome: r.outcome, reason: r.reason, flags: r.flags ?? [], data: r.data, requestId: r.requestId, amountMicro: r.amountMicro, decisionMs: r.decisionMs }),
        isError: r.outcome === "error",
      };
    },
  );

  server.registerTool(
    "firewall_summary",
    {
      title: "Firewall spending summary",
      description: "Read-only: this agent's status, task and daily spend vs. budgets, pending holds, recent activity and active rules.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return { content: text(await client.summary()) };
      } catch (e) {
        return { content: text({ error: e instanceof Error ? e.message : String(e) }), isError: true };
      }
    },
  );

  return server;
}
