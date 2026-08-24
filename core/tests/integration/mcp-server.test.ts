import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { getRandomPort } from "../setup";

// Shared mock config — used by ALL tests in this file because createApp()
// (server.ts) and mountMcpServer (adapters/mcp.ts) both call loadConfig().
// Mutations to this object are visible to every call because the mock
// returns the same reference.
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

/** All 11 MCP tools the server must expose. */
const EXPECTED_TOOL_NAMES = [
  "browsers",
  "screenshot",
  "tabs",
  "execute_all",
  "execute_batch",
  "page_read",
  "page_act",
  "page_js",
  "cookies",
  "windows",
  "help",
];

/**
 * Run one full MCP client session against the running server:
 * connect → listTools (11 tools) → callTool("browsers", {}) success.
 * Regression for the shared-McpServer double-connect bug: with the old
 * sessionful wiring, the SECOND such session 500'd ("Already connected").
 */
async function runFullSession(port: number): Promise<void> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`)
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await client.connect(transport);

    // listTools returns all 11 registered tools
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([...EXPECTED_TOOL_NAMES].sort());

    // callTool("browsers", {}) succeeds — no browsers connected, so we
    // expect a success envelope containing "(no browsers connected)",
    // NOT an isError result.
    const result = await client.callTool({ name: "browsers", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    expect(content[0].text).toContain("(no browsers connected)");
  } finally {
    await client.close().catch(() => {});
  }
}

describe("MCP Server Integration (stateless per-request serving)", () => {
  let httpServer: Server;
  let port: number;

  beforeEach(async () => {
    vi.resetModules();
    port = await getRandomPort();

    // Build the real Hono app (REST + MCP mounts) and serve it over HTTP
    const { createApp } = await import("../../src/server.js");
    const app = createApp();
    httpServer = serve({ fetch: app.fetch, port });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer?.close(() => resolve());
    });
  });

  it("serves TWO SEQUENTIAL full client sessions (multi-session bug regression)", async () => {
    await runFullSession(port);
    // Session #2 must succeed against the same process — this is the exact
    // scenario that 500'd with the old shared-McpServer + transports Map.
    await runFullSession(port);
  });

  it("negotiates a legacy 2025-06-18 initialize handshake (older-client compatibility)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);

    // The stateless legacy fallback may answer either a plain JSON body or
    // an SSE-framed response (client advertised Accept: text/event-stream).
    // Parse both the way a real 2025-era client would.
    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    let payload: {
      result?: {
        protocolVersion?: string;
        serverInfo?: { name?: string };
      };
    };
    if (contentType.includes("text/event-stream")) {
      const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
      expect(dataLine).toBeDefined();
      payload = JSON.parse(dataLine!.slice("data:".length).trim());
    } else {
      payload = JSON.parse(raw);
    }

    expect(payload.result).toBeDefined();
    expect(payload.result?.protocolVersion).toBe("2025-06-18");
    expect(payload.result?.serverInfo?.name).toBe("browserpowers");
  });
});
