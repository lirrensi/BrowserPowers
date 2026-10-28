import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import type { Server } from "node:http";
import type { WebSocketServer } from "ws";
import { getRandomPort } from "../setup";

// Shared mock config — createApp() and mountMcpServer() both call loadConfig();
// the mock returns the same reference for every call.
const mockConfig = {
  port: 4199,
  host: "127.0.0.1",
  mcp: { enabled: true, path: "/mcp" },
  rest: { enabled: true, path: "/api" },
  ws: { path: "/ws", heartbeatIntervalMs: 30_000 },
  gates: { defaultPermission: "ask" as const, approvalTimeoutMs: 60_000 },
  queue: { maxDepth: 50, defaultTimeoutMs: 120_000 },
  execution: { commandMode: "sync" as const },
  browsers: {} as Record<string, unknown>,
  auth: { apiKey: "" },
};

vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(() => mockConfig),
}));

interface ExecuteMessage {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
}

interface FakeExtension {
  ws: WebSocket;
  browserId: string;
  received: ExecuteMessage[];
}

/**
 * Fake extension: registers over WS and records every execute command,
 * answering each with a trivial result so the MCP call resolves.
 */
async function connectFakeExtension(wsUrl: string, name: string): Promise<FakeExtension> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  const received: ExecuteMessage[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as { type: string; payload: Record<string, unknown> };
    if (msg.type !== "execute") return;
    const { requestId, tool, params } = msg.payload as unknown as ExecuteMessage;
    received.push({ requestId, tool, params });
    ws.send(JSON.stringify({ type: "result", payload: { requestId, data: { ok: true, tool } } }));
  });

  const registered = new Promise<string>((resolve) => {
    ws.once("message", (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; payload: { browserId?: string } };
      if (msg.type === "registered" && msg.payload.browserId) resolve(msg.payload.browserId);
    });
  });

  ws.send(
    JSON.stringify({
      type: "register",
      payload: {
        name,
        capabilities: [
          { tool: "page.read", description: "page.read", group: "page.read" },
          { tool: "page.js", description: "page.js", group: "page.execute" },
          { tool: "page.cdp", description: "page.cdp", group: "page.execute" },
          { tool: "page.net", description: "page.net", group: "page.execute" },
          { tool: "tabs.update", description: "tabs.update", group: "tabs" },
          { tool: "tabs.navigate", description: "tabs.navigate", group: "tabs" },
        ],
        permissions: { "page.read": "allow", "page.execute": "allow", tabs: "allow" },
      },
    })
  );

  const browserId = await registered;
  return { ws, browserId, received };
}

describe("MCP tab targeting", () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;
  let browserName: string;
  let extension: FakeExtension;

  beforeEach(async () => {
    vi.resetModules();
    port = await getRandomPort();
    browserName = `TabTarget-${port}`;

    const { createApp } = await import("../../src/server.js");
    const app = createApp();
    httpServer = serve({ fetch: app.fetch, port });
    const { createWsServer } = await import("../../src/ws-server.js");
    wss = createWsServer(httpServer);

    extension = await connectFakeExtension(`ws://127.0.0.1:${port}/ws`, browserName);
  });

  afterEach(async () => {
    extension?.ws.close();
    wss?.close();
    await new Promise<void>((resolve) => {
      httpServer?.close(() => resolve());
    });
  });

  function mcpClient() {
    const client = new Client({ name: "tab-target-test", version: "1.0.0" });
    return { client, ready: client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))) };
  }

  it("forwards tab_id as tabId for page_read, page_js, and page_cdp", async () => {
    const { client, ready } = mcpClient();
    await ready;
    try {
      await client.callTool({ name: "page_read", arguments: { browser_name: browserName, action: "inspect", tab_id: 42 } });
      await client.callTool({ name: "page_js", arguments: { browser_name: browserName, code: "1+1", tab_id: 43 } });
      await client.callTool({ name: "page_cdp", arguments: { browser_name: browserName, method: "Runtime.evaluate", params: { expression: "1+1" }, tab_id: 44 } });
    } finally {
      await client.close().catch(() => {});
    }

    expect(extension.received).toHaveLength(3);
    expect(extension.received[0]).toMatchObject({ tool: "page.read", params: { action: "inspect", tabId: 42 } });
    expect(extension.received[0].params).not.toHaveProperty("tab_id");
    expect(extension.received[1]).toMatchObject({ tool: "page.js", params: { code: "1+1", tabId: 43 } });
    expect(extension.received[2]).toMatchObject({ tool: "page.cdp", params: { method: "Runtime.evaluate", tabId: 44 } });
  });

  it("accepts the camelCase tabId alias on page tools and tabs", async () => {
    const { client, ready } = mcpClient();
    await ready;
    try {
      await client.callTool({ name: "page_read", arguments: { browser_name: browserName, action: "inspect", tabId: 51 } });
      await client.callTool({ name: "tabs", arguments: { browser_name: browserName, action: "navigate", url: "https://example.com", tabId: 52 } });
      await client.callTool({ name: "page_net", arguments: { browser_name: browserName, action: "ws_list", tab_id: 53 } });
    } finally {
      await client.close().catch(() => {});
    }

    expect(extension.received[0]).toMatchObject({ tool: "page.read", params: { tabId: 51 } });
    expect(extension.received[1]).toMatchObject({ tool: "tabs.navigate", params: { tabId: 52, url: "https://example.com" } });
    expect(extension.received[2]).toMatchObject({ tool: "page.net", params: { action: "ws_list", tabId: 53 } });
  });

  it("forwards page_js frame targeting instead of dropping it", async () => {
    const { client, ready } = mcpClient();
    await ready;
    try {
      await client.callTool({
        name: "page_js",
        arguments: { browser_name: browserName, code: "document.title", tab_id: 71, frameId: 72, frame_url: "/inner" },
      });
    } finally {
      await client.close().catch(() => {});
    }

    expect(extension.received).toHaveLength(1);
    expect(extension.received[0]).toMatchObject({
      tool: "page.js",
      params: { code: "document.title", tabId: 71, frameId: 72, frame_url: "/inner" },
    });
  });

  it("maps tabs activate/update onto tabs.update with the requested tab", async () => {
    const { client, ready } = mcpClient();
    await ready;
    try {
      await client.callTool({ name: "tabs", arguments: { browser_name: browserName, action: "activate", tab_id: 61 } });
      await client.callTool({ name: "tabs", arguments: { browser_name: browserName, action: "update", tab_id: 62, active: false } });
    } finally {
      await client.close().catch(() => {});
    }

    expect(extension.received).toHaveLength(2);
    expect(extension.received[0]).toMatchObject({ tool: "tabs.update", params: { tabId: 61, active: true } });
    expect(extension.received[1]).toMatchObject({ tool: "tabs.update", params: { tabId: 62, active: false } });
  });

  it("rejects tabs activate without tab_id", async () => {
    const { client, ready } = mcpClient();
    await ready;
    try {
      const result = await client.callTool({ name: "tabs", arguments: { browser_name: browserName, action: "activate" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain("requires tab_id");
    } finally {
      await client.close().catch(() => {});
    }
    expect(extension.received).toHaveLength(0);
  });
});
