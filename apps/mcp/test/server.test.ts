import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { FirewallClient, PaymentRequest } from "@agent-firewall/client";
import { createMcpServer } from "../src/server";

function stubClient() {
  const calls: PaymentRequest[] = [];
  const client: FirewallClient = {
    requestPayment: async (req) => {
      calls.push(req);
      return { outcome: "block", reason: "Recipient not allowed", requestId: "req_1", flags: ["NEW_RECIPIENT"], amountMicro: 10000, decisionMs: 3 };
    },
    quote: async () => null,
    summary: async () => ({ agent: { id: "a" } }),
  };
  return { client, calls };
}

async function connect(fc: FirewallClient) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(fc).connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

describe("MCP server", () => {
  it("lists pay_with_firewall and firewall_summary", async () => {
    const client = await connect(stubClient().client);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["firewall_summary", "pay_with_firewall"]);
    const pay = tools.find((t) => t.name === "pay_with_firewall")!;
    expect(pay.inputSchema.required?.slice().sort()).toEqual(["purpose", "taskId", "url"]);
    expect(tools.find((t) => t.name === "firewall_summary")!.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("pay_with_firewall defaults category to data and returns the decision as JSON text", async () => {
    const { client: fc, calls } = stubClient();
    const client = await connect(fc);
    const res = await client.callTool({ name: "pay_with_firewall", arguments: { url: "http://seller.test/item", purpose: "p", taskId: "t" } });
    expect(calls[0]).toMatchObject({ url: "http://seller.test/item", purpose: "p", taskId: "t", category: "data" });
    const content = res.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({ outcome: "block", reason: "Recipient not allowed", flags: ["NEW_RECIPIENT"] });
    expect(res.isError).toBe(false);
    await client.close();
  });

  it("firewall_summary returns the summary", async () => {
    const client = await connect(stubClient().client);
    const res = await client.callTool({ name: "firewall_summary", arguments: {} });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual({ agent: { id: "a" } });
    await client.close();
  });
});
