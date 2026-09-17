import { describe, it, expect, vi, afterEach } from "vitest";
import { BrowserPowersClient, BrowserPowersError } from "../../src/client.js";
import type { BrowserSummary, ToolResult } from "../../src/client.js";
import {
  resolveApiKey,
  resolveBaseUrl,
} from "../../src/client.js";

// The client is pure transport: fetch is injected, so no browser, no daemon,
// no filesystem. Each test asserts a contract a script relies on: correct
// URL, correct auth header, correct body, correct unwrapping.

interface Captured {
  url: string;
  init: RequestInit;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
  const captured: Captured[] = [];
  // Test seam: minimal Response-shaped stub carrying the handler payload.
  const fetchImpl = (async (url: string, init: RequestInit): Promise<JsonResponse> => {
    captured.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => handler(url, init),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

function okJson(body: unknown, status = 200): JsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

function readBody(init: RequestInit): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(init.body));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected the posted body to be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

interface WireAnchor {
  anchor: string;
  tag: string;
}

interface InspectData {
  anchors: WireAnchor[];
}

function isInspectData(value: unknown): value is InspectData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("anchors" in value) || !Array.isArray(value.anchors)) return false;
  return value.anchors.every(
    (a): a is WireAnchor =>
      a !== null &&
      typeof a === "object" &&
      "anchor" in a &&
      typeof a.anchor === "string" &&
      "tag" in a &&
      typeof a.tag === "string",
  );
}

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("client: base URL resolution", () => {
  it("prefers BROWSERPOWERS_BASE over BP_BASE and BP_CORE", () => {
    process.env.BROWSERPOWERS_BASE = "http://a:1111/api";
    process.env.BP_BASE = "http://b:2222/api";
    process.env.BP_CORE = "http://c:3333";
    expect(resolveBaseUrl()).toBe("http://a:1111/api");
  });

  it("appends /api to a BP_CORE-style origin", () => {
    delete process.env.BROWSERPOWERS_BASE;
    delete process.env.BP_BASE;
    process.env.BP_CORE = "http://127.0.0.1:4199/";
    expect(resolveBaseUrl()).toBe("http://127.0.0.1:4199/api");
  });

  it("keeps a BP_BASE-style value that already ends in /api", () => {
    delete process.env.BROWSERPOWERS_BASE;
    delete process.env.BP_CORE;
    process.env.BP_BASE = "http://127.0.0.1:4199/api";
    expect(resolveBaseUrl()).toBe("http://127.0.0.1:4199/api");
  });
});

describe("client: api key resolution", () => {
  it("prefers BROWSERPOWERS_API_KEY over BP_API_KEY", () => {
    process.env.BROWSERPOWERS_API_KEY = "first";
    process.env.BP_API_KEY = "second";
    expect(resolveApiKey()).toBe("first");
  });

  it("falls back to BP_API_KEY so eval-smoke env keeps working", () => {
    delete process.env.BROWSERPOWERS_API_KEY;
    process.env.BP_API_KEY = "eval-key";
    expect(resolveApiKey()).toBe("eval-key");
  });
});

describe("client: transport", () => {
  it("posts execute to /browsers/:id/execute with the tool envelope", async () => {
    const { fetchImpl, captured } = stubFetch(() => ({
      browserId: "b-1",
      tool: "page.read",
      success: true,
      data: { anchors: [] },
    }));
    const client = new BrowserPowersClient({ baseUrl: "http://127.0.0.1:4199/api", fetchImpl });
    const result: ToolResult = await client.execute("b-1", "page.read", { action: "inspect" });

    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("http://127.0.0.1:4199/api/browsers/b-1/execute");
    expect(readBody(captured[0].init)).toEqual({
      tool: "page.read",
      params: { action: "inspect" },
    });
  });

  it("normalizes wire capability objects to strings in listBrowsers", async () => {
    const { fetchImpl } = stubFetch(() => ({
      browsers: [
        {
          id: "b-1",
          name: "alpha",
          capabilities: [{ tool: "page.read" }, { tool: "tabs.list" }],
          permissions: {},
          connectedAt: 1,
          lastHeartbeat: Date.now(),
        },
      ],
    }));
    const client = new BrowserPowersClient({ baseUrl: "http://x/api", fetchImpl });
    await expect(client.listBrowsers()).resolves.toEqual([
      expect.objectContaining({ id: "b-1", capabilities: ["page.read", "tabs.list"] }),
    ]);
  });

  it("sends the API key as a Bearer header", async () => {
    const { fetchImpl, captured } = stubFetch(() => ({ browsers: [] }));
    const client = new BrowserPowersClient({
      baseUrl: "http://127.0.0.1:4199/api",
      apiKey: "secret",
      fetchImpl,
    });
    await client.listBrowsers();
    const headers = new Headers(captured[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret");
  });

  it("maps transport failure to BrowserPowersError, not a bare TypeError", async () => {
    const client = new BrowserPowersClient({
      baseUrl: "http://127.0.0.1:4199/api",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(client.listBrowsers()).rejects.toBeInstanceOf(BrowserPowersError);
  });

  it("maps HTTP 404 bodies to BrowserPowersError with status", async () => {
    const client = new BrowserPowersClient({
      baseUrl: "http://127.0.0.1:4199/api",
      fetchImpl: (async () => okJson({ error: "Browser not found" }, 404)) as unknown as typeof fetch,
    });
    const err: unknown = await client.getBrowser("ghost").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserPowersError);
    if (!(err instanceof BrowserPowersError)) throw new Error("expected BrowserPowersError");
    expect(err.status).toBe(404);
  });
});

describe("client: scripting contracts", () => {
  it("conveniences wrap execute with the wire tool names", async () => {
    const seen: string[] = [];
    const { fetchImpl } = stubFetch((url: string, init: RequestInit) => {
      seen.push(`${url} :: ${String(init.body)}`);
      return { browserId: "b-1", tool: "x", success: true, data: {} };
    });
    const client = new BrowserPowersClient({ baseUrl: "http://x/api", fetchImpl });

    await client.navigate("b-1", "https://example.com");
    await client.pageRead("b-1", "inspect", { limit: 20 });
    await client.pageAct("b-1", "click", { anchor: "a3" });
    await client.pageJs("b-1", "1+1");

    expect(seen[0]).toContain("tabs.navigate");
    expect(seen[0]).toContain("https://example.com");
    expect(seen[0]).toContain("wait_until");
    expect(seen[1]).toContain("page.read");
    expect(seen[2]).toContain("page.act");
    expect(seen[3]).toContain("page.js");
  });

  it("waitForBrowser resolves by name and rejects after the deadline", async () => {
    const browsers: BrowserSummary[] = [
      { id: "b-1", name: "quick-fox-a3b2", capabilities: [], lastHeartbeat: Date.now() },
    ];
    const { fetchImpl } = stubFetch(() => ({ browsers }));
    const client = new BrowserPowersClient({ baseUrl: "http://x/api", fetchImpl });

    await expect(client.waitForBrowser("quick-fox-a3b2")).resolves.toMatchObject({ id: "b-1" });
    await expect(
      client.waitForBrowser("missing", { timeoutMs: 30, intervalMs: 5 }),
    ).rejects.toThrow(/missing/);
  });

  it("executeBatch posts browser-alias commands and preserves order", async () => {
    const { fetchImpl, captured } = stubFetch(() => ({
      results: [
        { browserId: "b-1", tool: "page.read", success: true, data: { anchors: [{ tag: "button" }] } },
        { browserId: "b-2", tool: "page.read", success: true, data: { anchors: [] } },
      ],
    }));
    const client = new BrowserPowersClient({ baseUrl: "http://x/api", fetchImpl });

    const results = await client.executeBatch([
      { browser: "alpha", tool: "page.read", params: { action: "inspect" } },
      { browser: "beta", tool: "page.read", params: { action: "inspect" } },
    ]);

    expect(results.map((r) => r.browserId)).toEqual(["b-1", "b-2"]);
    const posted = readBody(captured[0].init) as {
      commands: Array<{ browserId: string; tool: string }>;
    };
    expect(posted.commands.map((c) => c.browserId)).toEqual(["alpha", "beta"]);
  });

  it("supports the script shape: inspect, filter in-process, fan out in parallel", async () => {
    const queued: ToolResult[] = [
      {
        browserId: "b-1",
        tool: "page.read",
        success: true,
        data: { anchors: [{ anchor: "a1", tag: "button" }, { anchor: "a2", tag: "a" }] },
      },
      { browserId: "b-1", tool: "page.read", success: true, data: "hello" },
      { browserId: "b-1", tool: "page.read", success: true, data: { title: "t" } },
    ];
    let calls = 0;
    const { fetchImpl } = stubFetch(() => queued[Math.min(calls++, queued.length - 1)]);
    const client = new BrowserPowersClient({ baseUrl: "http://x/api", fetchImpl });

    const tree = await client.pageRead("b-1", "inspect");
    if (!isInspectData(tree.data)) throw new Error("inspect returned no anchors array");
    expect(tree.data.anchors.filter((a) => a.tag === "button")).toHaveLength(1);

    const [content, meta] = await Promise.all([
      client.pageRead("b-1", "content"),
      client.pageRead("b-1", "meta"),
    ]);
    expect(content.success).toBe(true);
    expect(meta.success).toBe(true);
  });
});
