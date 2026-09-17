// FILE: core/src/client.ts
// PURPOSE: Zero-dependency Node REST client for scripts — import, sequence,
//          chain, filter, and parallelize browser calls in-process.
// OWNS: HTTP transport, auth headers, async polling, browser convenience wrappers.
// EXPORTS: BrowserPowersClient, BrowserPowersError, client option/result types.
// DOCS: README.md (Scripting from Node), examples/quickstart.mjs
//
// The CLI is one-shot per process (spawn, one call, exit); this is the
// in-process equivalent — one import, many calls, no subprocess churn:
//   const bp = new BrowserPowersClient();
//   const b = await bp.waitForBrowser("my-browser");       // ID or name
//   await bp.navigate(b.id, "https://example.com");
//   const tree = await bp.pageRead(b.id, "inspect", { limit: 20 });
//   const anchors = (tree.data as { anchors?: Array<{ tag?: string }> })?.anchors ?? [];
//   const buttons = anchors.filter((a) => a.tag === "button"); // filter in-process
//   const [content, meta] = await Promise.all([            // parallel fan-out
//     bp.pageRead(b.id, "content"),
//     bp.pageRead(b.id, "meta"),
//   ]);

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ClientOptions {
  /** Full API base, e.g. "http://127.0.0.1:4199/api". Defaults from env (see below) or 127.0.0.1:4199. */
  baseUrl?: string;
  /** API key. Defaults to BROWSERPOWERS_API_KEY || BP_API_KEY (eval smoke honors BP_API_KEY). */
  apiKey?: string;
  /** Per-request timeout in ms. Default 120_000 (matches queue.defaultTimeoutMs). */
  timeoutMs?: number;
  /** fetch implementation override (tests, custom agents). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface BrowserSummary {
  id: string;
  name: string;
  capabilities: string[];
  permissions?: Record<string, string>;
  connectedAt?: number;
  lastHeartbeat?: number;
}

export interface BrowserDetail extends Omit<BrowserSummary, "capabilities"> {
  /** GET /browsers/:id returns capability objects; listBrowsers() normalizes to strings. */
  capabilities: Array<string | { tool: string }>;
  commandMode?: string;
}

export interface ToolResult {
  browserId: string;
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface BatchCommand {
  /** Browser ID or name — the server resolves names (same as other endpoints). */
  browser: string;
  tool: string;
  params?: Record<string, unknown>;
}

export interface AsyncTicket {
  requestId: string;
  status: string;
}

export interface PollResult {
  status: "pending" | "complete" | "error";
  result?: ToolResult;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface Health {
  status: string;
  browsers: number;
  uptime: number;
  wsConnected: number;
}

export interface ScreenshotData {
  base64?: string;
  format?: string;
  overlay?: string;
  drawn?: number;
  full_page?: boolean;
  [key: string]: unknown;
}

export class BrowserPowersError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "BrowserPowersError";
  }
}

/** Resolve the API base: explicit > BROWSERPOWERS_BASE > BP_BASE > BP_CORE > default. */
export function resolveBaseUrl(explicit?: string): string {
  const raw =
    explicit?.trim() ||
    process.env.BROWSERPOWERS_BASE?.trim() ||
    process.env.BP_BASE?.trim() ||
    process.env.BP_CORE?.trim() ||
    "http://127.0.0.1:4199";
  const stripped = raw.replace(/\/+$/, "");
  // BP_CORE-style values are the core origin; BP_BASE-style already include /api.
  return stripped.endsWith("/api") ? stripped : `${stripped}/api`;
}

/** Resolve the API key: explicit > BROWSERPOWERS_API_KEY > BP_API_KEY > "". */
export function resolveApiKey(explicit?: string): string {
  return (
    explicit ??
    process.env.BROWSERPOWERS_API_KEY ??
    process.env.BP_API_KEY ??
    ""
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class BrowserPowersClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.apiKey = resolveApiKey(options.apiKey);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async req<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const { timeoutMs, ...rest } = init ?? {};
    const headers = new Headers(rest.headers);
    if (rest.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...rest,
        headers,
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BrowserPowersError(`request ${path} failed: ${detail}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const serverMsg =
        body !== null && typeof body === "object" && "error" in body
          ? String(body.error)
          : res.statusText || "request failed";
      throw new BrowserPowersError(`${res.status} ${path}: ${serverMsg}`, res.status, body);
    }
    return body as T;
  }

  // ── Browsers ──

  async listBrowsers(): Promise<BrowserSummary[]> {
    const { browsers } = await this.req<{ browsers: BrowserDetail[] }>("/browsers");
    return (browsers ?? []).map((b) => ({
      ...b,
      capabilities: (b.capabilities ?? []).map((c) => (typeof c === "string" ? c : c.tool)),
    }));
  }

  async getBrowser(idOrName: string): Promise<BrowserDetail> {
    return this.req<BrowserDetail>(`/browsers/${encodeURIComponent(idOrName)}`);
  }

  /** Poll until a browser is connected (and heartbeat-fresh). No arg = first available. */
  async waitForBrowser(
    idOrName?: string,
    opts?: WaitOptions & { maxHeartbeatAgeMs?: number },
  ): Promise<BrowserSummary> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const intervalMs = opts?.intervalMs ?? 500;
    const maxAge = opts?.maxHeartbeatAgeMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const browsers = await this.listBrowsers();
      const found = idOrName
        ? browsers.find((b) => b.id === idOrName || b.name === idOrName)
        : browsers[0];
      if (
        found &&
        (found.lastHeartbeat === undefined || Date.now() - found.lastHeartbeat <= maxAge)
      ) {
        return found;
      }
      if (Date.now() >= deadline) {
        throw new BrowserPowersError(
          idOrName
            ? `timed out waiting for browser "${idOrName}" after ${timeoutMs}ms`
            : `timed out waiting for any browser after ${timeoutMs}ms`,
        );
      }
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  async health(): Promise<Health> {
    return this.req<Health>("/health");
  }

  // ── Execution (sync envelope: check .success, don't catch) ──
  //
  // Wire shape, end to end: routeExecute returns ExecuteResult { requestId,
  // success, data?, executionVerdict? }. The extension posts `data` back as
  // the WS `result` payload; the registry stamps browserId/tool and the REST
  // layer returns it verbatim as { browserId, tool, success, data?, error? }.
  // For page.read/page.act, `data` IS the ActionResult envelope
  // ({ success, status, action, message, data? }) — so `toolResult.success`
  // tells you the transport worked, and `toolResult.data.success` tells you
  // the page action worked. Check both; a click that missed still arrives
  // as success:true with data.success:false.

  /** Execute a tool and wait for the result. Returns the envelope as-is — check `.success`. */
  async execute(
    browser: string,
    tool: string,
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    return this.req<ToolResult>(`/browsers/${encodeURIComponent(browser)}/execute`, {
      method: "POST",
      body: JSON.stringify({ tool, params }),
    });
  }

  async executeAsync(
    browser: string,
    tool: string,
    params: Record<string, unknown> = {},
  ): Promise<AsyncTicket> {
    return this.req<AsyncTicket>(`/browsers/${encodeURIComponent(browser)}/execute-async`, {
      method: "POST",
      body: JSON.stringify({ tool, params }),
    });
  }

  async getResult(requestId: string): Promise<PollResult> {
    return this.req<PollResult>(`/results/${encodeURIComponent(requestId)}`);
  }

  /** Poll an async ticket until complete. Throws on error status or timeout. */
  async waitForResult(requestId: string, opts?: WaitOptions): Promise<ToolResult> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const intervalMs = opts?.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const poll = await this.getResult(requestId);
      if (poll.status === "complete" && poll.result) return poll.result;
      if (poll.status === "error") {
        throw new BrowserPowersError(
          `async request ${requestId} failed: ${poll.result?.error ?? "unknown error"}`,
          undefined,
          poll.result,
        );
      }
      if (Date.now() >= deadline) {
        throw new BrowserPowersError(
          `timed out waiting for ${requestId} after ${timeoutMs}ms`,
        );
      }
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  /** Same tool on every connected browser, in parallel. */
  async executeAll(tool: string, params: Record<string, unknown> = {}): Promise<ToolResult[]> {
    const { results } = await this.req<{ results: ToolResult[] }>("/execute-all", {
      method: "POST",
      body: JSON.stringify({ tool, params }),
    });
    return results ?? [];
  }

  /** Different tools across browsers, in parallel. Order matches input. */
  async executeBatch(commands: BatchCommand[]): Promise<ToolResult[]> {
    const { results } = await this.req<{ results: ToolResult[] }>("/execute-batch", {
      method: "POST",
      body: JSON.stringify({
        commands: commands.map((c) => ({
          browserId: c.browser,
          tool: c.tool,
          params: c.params ?? {},
        })),
      }),
    });
    return results ?? [];
  }

  // ── Conveniences (thin wrappers over execute) ──

  async tabsList(browser: string): Promise<ToolResult> {
    return this.execute(browser, "tabs.list", {});
  }

  /** Navigate (new tab unless tabId given), waiting for load. Same default as manual-tests helper. */
  async navigate(
    browser: string,
    url: string,
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    return this.execute(browser, "tabs.navigate", { url, wait_until: "complete", ...params });
  }

  async pageRead(
    browser: string,
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    return this.execute(browser, "page.read", { action, ...params });
  }

  async pageAct(
    browser: string,
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    return this.execute(browser, "page.act", { action, ...params });
  }

  async pageJs(browser: string, code: string): Promise<ToolResult> {
    return this.execute(browser, "page.js", { code });
  }

  /** Screenshot payload (validates the envelope — throws on failure or wrong shape). */
  async screenshot(
    browser: string,
    params: Record<string, unknown> = {},
  ): Promise<ScreenshotData> {
    const result = await this.execute(browser, "screenshots.capture", params);
    if (!result.success) {
      throw new BrowserPowersError(`screenshot failed: ${result.error ?? "unknown error"}`);
    }
    if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
      throw new BrowserPowersError("screenshot returned an unexpected payload (expected an object)");
    }
    return result.data as ScreenshotData;
  }

  /** Screenshot written to filepath (mkdir -p). Returns the path plus capture metadata. */
  async saveScreenshot(
    browser: string,
    filepath: string,
    params: Record<string, unknown> = {},
  ): Promise<ScreenshotData & { filepath: string }> {
    const data = await this.screenshot(browser, params);
    if (!data.base64) throw new BrowserPowersError("screenshot returned no image bytes");
    mkdirSync(dirname(filepath), { recursive: true });
    writeFileSync(filepath, Buffer.from(data.base64, "base64"));
    const { base64: _bytes, ...meta } = data;
    return { ...meta, filepath };
  }
}
