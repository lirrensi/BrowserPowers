/**
 * FILE: extension/src/capability-router.ts
 * PURPOSE: Maps tool calls from the core into chrome.* API calls.
 *          v2: page tools dispatch to page-read/page-act/page-js v2 modules.
 *          Non-page tools (tabs, windows, history, bookmarks, etc.) unchanged.
 *          Every chrome.scripting.executeScript call site is wrapped with an
 *          ExecutionVerdict: world, durationMs, value, error.
 * OWNS: Single routing layer between WebSocket commands and browser APIs.
 * EXPORTS: routeExecute, ExecuteRequest, ExecuteResult
 * DOCS: agent_chat/plan_adr001_v2_2026-05-12.md (Phase 3),
 *       .agents/reports/plan_runtime-verdict_2026-06-22.md §2.7
 */

import { dispatchReadAction } from "./v2/page-read.js";
import { dispatchActAction } from "./v2/page-act.js";
import { dispatchJsAction } from "./v2/page-js.js";
import { diffSnapshots } from "./v2/snapshot-diff.js";
import { captureWithOverlay } from "./screenshot.js";
import type { ExecutionVerdict } from "./types.js";

// ═══════════════════════════════════════════
// Network request ring buffer (#002)
// ═══════════════════════════════════════════

interface RequestEvent {
  url: string;
  method: string;
  statusCode: number;
  type: string;
  timestamp: number;
  tabId: number;
  requestId: string;
}

const MAX_REQUESTS_PER_TAB = 200;
const requestBuffer = new Map<number, RequestEvent[]>();

/** Actions that mutate the page — eligible for pre/post snapshot diff in sync mode */
const MUTATION_ACTIONS = new Set([
  "click", "fill", "check", "select_option", "press", "scroll", "submit",
  "type", "smart_click", "fill_form", "drag", "dblclick", "hover",
  "click_at", "dblclick_at", "hover_at",
]);

function addRequestToBuffer(entry: RequestEvent): void {
  let entries = requestBuffer.get(entry.tabId);
  if (!entries) {
    entries = [];
    requestBuffer.set(entry.tabId, entries);
  }
  entries.push(entry);
  if (entries.length > MAX_REQUESTS_PER_TAB) {
    entries.splice(0, entries.length - MAX_REQUESTS_PER_TAB);
  }
}

// Module-level webRequest listeners — registered once on worker startup
// Guarded with try/catch: WXT build mock has chrome.webRequest but onBeforeRequest may throw
try {
  if (typeof chrome !== "undefined" && chrome.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return; // Ignore non-tab requests (e.g. service worker)
      addRequestToBuffer({
        url: details.url,
        method: details.method ?? "GET",
        statusCode: 0, // Not known yet
        type: details.type ?? "other",
        timestamp: details.timeStamp,
        tabId: details.tabId,
        requestId: details.requestId,
      });
    },
    { urls: ["<all_urls>"] },
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const entries = requestBuffer.get(details.tabId);
      if (entries) {
        // Find the matching request by requestId and update statusCode
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].requestId === details.requestId) {
            entries[i].statusCode = details.statusCode;
            break;
          }
        }
      }
    },
    { urls: ["<all_urls>"] },
  );
  }
} catch {
  // WXT build mock doesn't implement webRequest — silently ignore
}

export interface ExecuteRequest {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
  commandMode: "sync" | "async";
}

export interface ExecuteResult {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
  /** Additive — every chrome.scripting.executeScript call site emits one of these. */
  executionVerdict?: ExecutionVerdict;
}

/**
 * Run a chrome.scripting.executeScript call wrapped with timing + verdict
 * construction. The default world is isolated; pass `world: "MAIN"` for
 * surface that genuinely needs MAIN (we currently have zero such call sites).
 */
async function runExecuteScript(
  opts: {
    tabId: number;
    frameId?: number;
    // Chrome's executeScript API types the func as (...args: any[]) => any.
    // We mirror that here so callers can pass any concrete signature.
    func: (...args: any[]) => any;
    args?: unknown[];
    callSite: string; // for the verdict's `path` field
    world?: "isolated" | "main";
  },
): Promise<{ result: unknown; verdict: ExecutionVerdict }> {
  const world: "isolated" | "main" = opts.world ?? "isolated";
  const start = performance.now();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: opts.tabId, ...(opts.frameId !== undefined ? { frameIds: [opts.frameId] } : {}) },
      func: opts.func,
      args: (opts.args ?? []) as any[],
      // Only set the world field if we actually need MAIN. Isolated is the
      // default and is the right default — page CSP only applies to MAIN.
      ...(world === "main" ? { world: "MAIN" as const } : {}),
    });
    const result = (results && results[0]) ? results[0].result : undefined;
    return {
      result,
      verdict: {
        executed: true,
        world,
        value: result,
        durationMs: performance.now() - start,
        path: `sw.executeScript.${world}.${opts.callSite}`,
      },
    };
  } catch (e) {
    const err = e as Error;
    return {
      result: undefined,
      verdict: {
        executed: false,
        world,
        durationMs: performance.now() - start,
        path: `sw.executeScript.${world}.${opts.callSite}`,
        error: { name: err.name || "Error", message: err.message || String(e) },
      },
    };
  }
}

/**
 * Route a tool execution request to the appropriate chrome.* API.
 */
export async function routeExecute(req: ExecuteRequest): Promise<ExecuteResult> {
  try {
    const out = await execute(req.tool, req.params, req.commandMode);
    // If a tool's error path returned `{ success: false, error }` instead
    // of throwing (older pattern, kept for compat), propagate it. Otherwise
    // routeExecute would lie and say success:true with no data.
    const data = out.data as { success?: boolean; error?: string } | null | undefined;
    if (data && data.success === false) {
      return {
        requestId: req.requestId,
        success: false,
        error: data.error ?? `tool "${req.tool}" returned success:false with no error message`,
      };
    }
    return {
      requestId: req.requestId,
      success: true,
      data: out.data,
      executionVerdict: out.executionVerdict,
    };
  } catch (err) {
    return {
      requestId: req.requestId,
      success: false,
      error: (err as Error).message,
    };
  }
}

/** Resolve frame_url or frame_name to a numeric frameId by querying the content script. */
async function resolveFrameId(tabId: number, params: Record<string, unknown>): Promise<number | undefined> {
  const frameUrl = params.frame_url as string | undefined;
  const frameName = params.frame_name as string | undefined;
  if (!frameUrl && !frameName) return params.frameId as number | undefined;

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      source: "browserpowers",
      type: "bp:read",
      action: "frames",
      params: {},
    }) as Record<string, unknown>;

    const frames = (response?.frames as Array<Record<string, unknown>>) ?? [];
    for (const frame of frames) {
      if (frameUrl && typeof frame.src === "string" && frame.src.includes(frameUrl)) {
        return frame.index as number;
      }
      if (frameName && frame.name === frameName) {
        return frame.index as number;
      }
    }
    return params.frameId as number | undefined;
  } catch {
    return params.frameId as number | undefined;
  }
}

/** Strip frame_url/frame_name from params (resolved to frameId above, no longer needed downstream). */
function stripFrameParams(p: Record<string, unknown>): Record<string, unknown> {
  const { frame_url: _fu, frame_name: _fn, ...rest } = p as Record<string, unknown>;
  return rest;
}

async function execute(
  tool: string,
  params: Record<string, unknown>,
  commandMode: "sync" | "async",
): Promise<{ data: unknown; executionVerdict?: ExecutionVerdict }> {
  switch (tool) {
    // ══════════════════════════════════════════
    // V2 Page Tools
    // ══════════════════════════════════════════

    case "page.read": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const frameId = await resolveFrameId(tabId, params);
      const cleanParams = stripFrameParams(params);
      const result = await dispatchReadAction(cleanParams.action as any, cleanParams, tabId, frameId);
      // The runtimeStatus field is additive — every content-script response
      // carries the isolated-world self-test verdict so callers can prove the
      // script is alive and able to evaluate JS.
      return {
        data: result,
        executionVerdict: result.executionVerdict ?? result.runtimeStatus,
      };
    }

    case "page.act": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const frameId = await resolveFrameId(tabId, params);
      const cleanParams = stripFrameParams(params);
      const actAction = cleanParams.action as string;

      // In sync mode: capture pre/post inspect snapshots for mutation actions
      if (commandMode === "sync" && MUTATION_ACTIONS.has(actAction)) {
        let beforeSnapshot: Record<string, unknown> | undefined;
        try {
          const before = await dispatchReadAction("inspect", { compact: true, limit: 30 }, tabId, frameId);
          if (before.success && before.data) {
            beforeSnapshot = before.data as Record<string, unknown>;
          }
        } catch {
          // Pre-inspect is best-effort; proceed even if it fails
        }

        // Execute the action
        const result = await dispatchActAction(actAction as any, cleanParams, tabId, frameId);

        // If action failed or didn't perform, skip post-inspect and diff
        const actionStatus = result.status;
        if (actionStatus !== "performed" && actionStatus !== "already_in_desired_state") {
          return { data: result, executionVerdict: result.executionVerdict };
        }

        // Post-inspect
        let afterSnapshot: Record<string, unknown> | undefined;
        try {
          const after = await dispatchReadAction("inspect", { compact: true, limit: 30 }, tabId, frameId);
          if (after.success && after.data) {
            afterSnapshot = after.data as Record<string, unknown>;
          }
        } catch {
          // Post-inspect is best-effort
        }

        // Compute diff if we have both snapshots
        if (beforeSnapshot && afterSnapshot) {
          try {
            const diff = diffSnapshots(beforeSnapshot.anchors as any[], afterSnapshot.anchors as any[], {
              urlBefore: beforeSnapshot.url as string,
              urlAfter: afterSnapshot.url as string,
              titleBefore: beforeSnapshot.title as string,
              titleAfter: afterSnapshot.title as string,
              documentIdBefore: beforeSnapshot.documentId as string,
              documentIdAfter: afterSnapshot.documentId as string,
            });
            result.data = {
              ...(result.data ?? {}),
              diff,
            };
          } catch {
            // Diff is best-effort
          }
        }

        return { data: result, executionVerdict: result.executionVerdict };
      }

      const actResult = await dispatchActAction(actAction as any, cleanParams, tabId, frameId);
      return { data: actResult, executionVerdict: actResult.executionVerdict };
    }

    case "page.js": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const frameId = await resolveFrameId(tabId, params);
      const cleanParams = stripFrameParams(params);
      const result = await dispatchJsAction(cleanParams.code as string, tabId, frameId);
      return { data: result, executionVerdict: result.executionVerdict };
    }

    case "self.reload": {
      // Ask the running extension to reload itself. Used by the manual-test
      // harness after `node scripts/install.mjs` copies a new build into the
      // extension folder — the user shouldn't have to open chrome://extensions
      // and click reload manually.
      //
      // We delay 500ms so the response can reach the caller before the SW
      // tears down. If `confirm: true` is passed and the user has unsaved
      // popup state, we ask first.
      const confirm = params?.confirm === true;
      if (confirm && typeof chrome !== "undefined" && chrome.notifications) {
        try {
          await chrome.notifications.create({
            type: "basic",
            iconUrl: "icon-128.png",
            title: "BrowserPowers reloading",
            message: "The extension is reloading to pick up a new build.",
          });
        } catch {
          // notifications may not be available in all builds
        }
      }
      setTimeout(() => {
        try { chrome.runtime.reload(); } catch (e) { console.error("[bp-ext] reload failed:", e); }
      }, 500);
      return { data: { reloading: true, delayMs: 500 } };
    }

    // ══════════════════════════════════════════
    // Tabs
    // ══════════════════════════════════════════

    case "tabs.list": {
      const MAX_TABS = 500;
      let limit = (params.limit as number) ?? 100;
      const offset = (params.offset as number) ?? 0;
      if (limit > MAX_TABS) {
        console.warn(`[bp-ext] tabs.list limit ${limit} exceeds max ${MAX_TABS}, capping`);
        limit = MAX_TABS;
      }
      // Strip non-QueryInfo fields (limit, offset) before passing to Chrome API
      const { limit: _skipL, offset: _skipO, ...queryInfo } = params as Record<string, unknown>;
      const results = await chrome.tabs.query(queryInfo as unknown as chrome.tabs.QueryInfo);
      const totalCount = results.length;
      const sliced = results.slice(offset, offset + limit);
      return {
        data: {
          tabs: sliced,
          totalCount,
          truncated: totalCount > limit,
          limit,
          offset,
        },
      };
    }

    case "tabs.create":
      return { data: await chrome.tabs.create(params as chrome.tabs.CreateProperties) };

    case "tabs.navigate": {
      // Navigate to URL — in existing tab if tabId given, else creates new tab
      const url = params.url as string;
      const waitUntil = (params.wait_until as string) ?? "complete";
      const timeoutMs = (params.timeout_ms as number) ?? 30_000;

      if (!url) throw new Error("tabs.navigate requires a 'url' parameter");

      const explicitTabId = params.tabId as number | undefined;
      let tab: chrome.tabs.Tab;
      if (explicitTabId) {
        tab = await chrome.tabs.update(explicitTabId, { url, active: params.active !== false });
      } else {
        tab = await chrome.tabs.create({ url, active: params.active !== false });
      }
      const tabId = tab.id;
      if (!tabId) return { data: { tabId: null, navigated: true, url, wait_until: waitUntil, elapsed_ms: 0 } };

      const startTime = Date.now();

      // Wait for the requested load state
      if (waitUntil !== "none") {
        try {
          await new Promise<void>((resolve, reject) => {
            const listener = (tId: number, _info: chrome.tabs.TabChangeInfo) => {
              if (tId === tabId) {
                chrome.tabs.onUpdated.removeListener(listener);
                // Resolve once the tab fires any update after navigation starts
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);

            setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              reject(new Error(`Navigation timeout after ${Date.now() - startTime}ms`));
            }, timeoutMs);
          });
        } catch (err) {
          console.warn(`[bp-ext] Navigation wait timed out: ${(err as Error).message}`);
        }
      }

      const result: Record<string, unknown> = { tabId, navigated: true, url, wait_until: waitUntil, elapsed_ms: Date.now() - startTime };

      // Optional snapshot — in sync mode, always run compact inspect after navigation
      const needsSnapshot = params.snapshot || commandMode === "sync";
      if (needsSnapshot && tabId) {
        try {
          const snapshotResult = await dispatchReadAction("inspect", { compact: true, limit: 30 }, tabId);
          if (snapshotResult.success && snapshotResult.data) {
            result.snapshot = snapshotResult.data;
            const anchors = (snapshotResult.data as Record<string, unknown>).anchors as Array<Record<string, unknown>> | undefined;
            if (anchors) {
              result.anchors = anchors;
            }
          }
        } catch {
          console.warn("[bp-ext] Navigation snapshot failed (non-critical)");
        }
      }

      return { data: result };
    }

    case "tabs.goBack": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      await chrome.tabs.goBack(tabId);
      return { data: { navigated: true, direction: "back" } };
    }

    case "tabs.goForward": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      await chrome.tabs.goForward(tabId);
      return { data: { navigated: true, direction: "forward" } };
    }

    case "tabs.close": {
      const tabId = params.tabId as number;
      if (tabId) await chrome.tabs.remove(tabId);
      else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) await chrome.tabs.remove(tab.id);
      }
      return { data: { closed: true } };
    }

    case "tabs.update": {
      const { tabId, ...updateProps } = params as any;
      const targetId = tabId ?? (await getActiveTabId());
      return { data: await chrome.tabs.update(targetId, updateProps) };
    }

    // ══════════════════════════════════════════
    // Screenshots
    // ══════════════════════════════════════════

    case "screenshots.capture": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const overlay = (params.overlay as string | undefined) ?? "none";
      if (overlay === "none" || overlay === undefined) {
        // Fast path — no overlay, backward compat.
        const dataUrl = await chrome.tabs.captureVisibleTab(
          (tabId as any)?.windowId,
          { format: "png" },
        );
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        return { data: { base64, format: "png", overlay: "none" } };
      }
      // Overlay path — capture + canvas-paint annotations.
      const limit = (params.overlay_limit as number | undefined) ?? 50;
      const colorByType = (params.overlay_color_by_type as boolean | undefined) ?? true;
      const result = await captureWithOverlay(tabId, {
        mode: overlay as "labels" | "coords" | "both" | "anchors_only",
        limit,
        colorByType,
      });
      return { data: { base64: result.base64, format: "png", overlay, drawn: result.drawn } };
    }

    // ══════════════════════════════════════════
    // History
    // ══════════════════════════════════════════

    case "history.search": {
      const limit = (params.limit as number) ?? 100;
      const query: chrome.history.HistoryQuery = {
        text: params.text as string ?? "",
        maxResults: limit,
        ...(params.startTime ? { startTime: params.startTime as number } : {}),
        ...(params.endTime ? { endTime: params.endTime as number } : {}),
      };
      return { data: await chrome.history.search(query) };
    }

    case "history.delete": {
      if (params.url) {
        await chrome.history.deleteUrl({ url: params.url as string });
      } else if (params.delete_all === true) {
        try {
          await chrome.history.deleteAll();
        } catch (e) {
          throw new Error(`Failed to delete history: ${(e as Error).message}. Note: Chrome may block deleteAll() without user gesture in MV3.`);
        }
      } else {
        throw new Error("Specify `url` to delete a single entry or `delete_all: true` to wipe all history.");
      }
      return { data: { deleted: true } };
    }

    // ══════════════════════════════════════════
    // Bookmarks
    // ══════════════════════════════════════════

    case "bookmarks.list": {
      const limit = (params.limit as number) ?? 100;
      const offset = (params.offset as number) ?? 0;
      const results = await chrome.bookmarks.search(params as chrome.bookmarks.BookmarkSearchQuery);
      return { data: results.slice(offset, offset + limit) };
    }

    case "bookmarks.create":
      return { data: await chrome.bookmarks.create(params as chrome.bookmarks.BookmarkCreateArg) };

    case "bookmarks.delete": {
      const id = params.id as string;
      const tree = params.tree as string | undefined;
      if (id) {
        await chrome.bookmarks.remove(id);
      } else if (tree) {
        await chrome.bookmarks.removeTree(tree);
      } else {
        throw new Error("bookmarks.delete requires either 'id' (single bookmark) or 'tree' (subtree root). Calling without params does NOT wipe all bookmarks.");
      }
      return { data: { deleted: true } };
    }

    // ══════════════════════════════════════════
    // Downloads
    // ══════════════════════════════════════════

    case "downloads.list": {
      const limit = (params.limit as number) ?? 100;
      const query: chrome.downloads.DownloadQuery = {
        ...(params as chrome.downloads.DownloadQuery),
        limit,
      };
      return { data: await chrome.downloads.search(query) };
    }

    case "downloads.open": {
      const downloadId = params.downloadId as number;
      if (downloadId) await chrome.downloads.open(downloadId);
      return { data: { opened: true } };
    }

    // ══════════════════════════════════════════
    // Network
    // ══════════════════════════════════════════

    case "network.requests": {
      const filterTabId = params.tabId as number | undefined;
      const limit = (params.limit as number) ?? 100;

      let entries: RequestEvent[] = [];
      if (filterTabId !== undefined) {
        entries = requestBuffer.get(filterTabId) ?? [];
      } else {
        // Flatten all tabs' entries, sorted by timestamp descending
        for (const tabEntries of requestBuffer.values()) {
          entries.push(...tabEntries);
        }
        entries.sort((a, b) => b.timestamp - a.timestamp);
      }

      const sliced = entries.slice(0, limit);
      return { data: { requests: sliced } };
    }

    // ══════════════════════════════════════════
    // Storage
    // ══════════════════════════════════════════

    case "storage.get": {
      const keys = params.keys as string | string[] | undefined;
      if (keys) {
        const tabId = (params.tabId as number) ?? (await getActiveTabId());
        const frameId = params.frameId as number | undefined;
        const { result, verdict } = await runExecuteScript({
          tabId,
          frameId,
          callSite: "storage.get",
          func: (k: string | string[]) => {
            const keysArr = Array.isArray(k) ? k : [k];
            const result: Record<string, unknown> = {};
            for (const key of keysArr) result[key] = localStorage.getItem(key);
            return result;
          },
          args: [keys],
        });
        return { data: result, executionVerdict: verdict };
      }
      return { data: {} };
    }

    case "storage.set": {
      const data = params.data as Record<string, string>;
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const frameId = params.frameId as number | undefined;
      const { result, verdict } = await runExecuteScript({
        tabId,
        frameId,
        callSite: "storage.set",
        func: (d: Record<string, string>) => {
          for (const [key, val] of Object.entries(d)) localStorage.setItem(key, val);
        },
        args: [data],
      });
      return { data: { stored: true, writeResult: result }, executionVerdict: verdict };
    }

    // ══════════════════════════════════════════
    // Windows
    // ══════════════════════════════════════════

    case "windows.list": {
      const results = await chrome.windows.getAll({ populate: true });
      return { data: results };
    }

    case "windows.create": {
      const createParams: chrome.windows.CreateData = {};
      if (params.url) createParams.url = params.url as string;
      return { data: await chrome.windows.create(createParams) };
    }

    case "windows.focus": {
      const windowId = params.window_id as number;
      await chrome.windows.update(windowId, { focused: true });
      return { data: { focused: true } };
    }

    case "windows.close": {
      const windowId = params.window_id as number;
      if (!windowId) throw new Error("windows.close requires a 'window_id' parameter");
      await chrome.windows.remove(windowId);
      return { data: { closed: true } };
    }

    // ══════════════════════════════════════════
    // Cookies
    // ══════════════════════════════════════════

    case "cookies.get": {
      const url = params.url as string;
      const name = params.name as string;
      const cookie = await chrome.cookies.get({ url, name });
      return { data: cookie ?? { error: "Cookie not found" } };
    }

    case "cookies.set": {
      const url = params.url as string;
      const name = params.name as string;
      const value = params.value as string;
      const cookie = await chrome.cookies.set({ url, name, value });
      return { data: cookie };
    }

    case "cookies.remove": {
      const url = params.url as string;
      const name = params.name as string;
      await chrome.cookies.remove({ url, name });
      return { data: { removed: true } };
    }

    case "cookies.list": {
      const limit = (params.limit as number) ?? 100;
      const offset = (params.offset as number) ?? 0;
      const url = params.url as string;
      const cookies = await chrome.cookies.getAll({ url });
      return { data: cookies.slice(offset, offset + limit) };
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}
