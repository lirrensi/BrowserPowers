/**
 * FILE: extension/src/capability-router.ts
 * PURPOSE: Maps tool calls from the core into chrome.* API calls.
 *          v2: page tools dispatch to page-read/page-act/page-js v2 modules.
 *          Non-page tools (tabs, windows, history, bookmarks, etc.) unchanged.
 * OWNS: Single routing layer between WebSocket commands and browser APIs.
 * EXPORTS: routeExecute, ExecuteRequest, ExecuteResult
 * DOCS: agent_chat/plan_adr001_v2_2026-05-12.md (Phase 3)
 */

import { dispatchReadAction } from "./v2/page-read.js";
import { dispatchActAction } from "./v2/page-act.js";
import { dispatchJsAction } from "./v2/page-js.js";

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
}

export interface ExecuteResult {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Route a tool execution request to the appropriate chrome.* API.
 */
export async function routeExecute(req: ExecuteRequest): Promise<ExecuteResult> {
  try {
    const data = await execute(req.tool, req.params);
    return { requestId: req.requestId, success: true, data };
  } catch (err) {
    return {
      requestId: req.requestId,
      success: false,
      error: (err as Error).message,
    };
  }
}

async function execute(tool: string, params: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    // ══════════════════════════════════════════
    // V2 Page Tools
    // ══════════════════════════════════════════

    case "page.read": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const frameId = params.frameId as number | undefined;
      return dispatchReadAction(params.action as any, params, tabId, frameId);
    }

    case "page.act": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const frameId = params.frameId as number | undefined;
      return dispatchActAction(params.action as any, params, tabId, frameId);
    }

    case "page.js": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const frameId = params.frameId as number | undefined;
      return dispatchJsAction(params.code as string, tabId, frameId);
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
      const results = await chrome.tabs.query(params as chrome.tabs.QueryInfo);
      const totalCount = results.length;
      const sliced = results.slice(offset, offset + limit);
      return {
        tabs: sliced,
        totalCount,
        truncated: totalCount > limit,
        limit,
        offset,
      };
    }

    case "tabs.create":
      return chrome.tabs.create(params as chrome.tabs.CreateProperties);

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
      if (!tabId) return { tabId: null, navigated: true, url, wait_until: waitUntil, elapsed_ms: 0 };

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

      // Optional snapshot — run compact inspect after navigation and attach anchors
      if (params.snapshot && tabId) {
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

      return result;
    }

    case "tabs.goBack": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      await chrome.tabs.goBack(tabId);
      return { navigated: true, direction: "back" };
    }

    case "tabs.goForward": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      await chrome.tabs.goForward(tabId);
      return { navigated: true, direction: "forward" };
    }

    case "tabs.close": {
      const tabId = params.tabId as number;
      if (tabId) await chrome.tabs.remove(tabId);
      else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) await chrome.tabs.remove(tab.id);
      }
      return { closed: true };
    }

    case "tabs.update": {
      const { tabId, ...updateProps } = params as any;
      const targetId = tabId ?? (await getActiveTabId());
      return chrome.tabs.update(targetId, updateProps);
    }

    // ══════════════════════════════════════════
    // Screenshots
    // ══════════════════════════════════════════

    case "screenshots.capture": {
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const dataUrl = await chrome.tabs.captureVisibleTab(
        (tabId as any)?.windowId,
        { format: "png" },
      );
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      return { base64, format: "png" };
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
      return chrome.history.search(query);
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
      return { deleted: true };
    }

    // ══════════════════════════════════════════
    // Bookmarks
    // ══════════════════════════════════════════

    case "bookmarks.list": {
      const limit = (params.limit as number) ?? 100;
      const offset = (params.offset as number) ?? 0;
      const results = await chrome.bookmarks.search(params as chrome.bookmarks.BookmarkSearchQuery);
      return results.slice(offset, offset + limit);
    }

    case "bookmarks.create":
      return chrome.bookmarks.create(params as chrome.bookmarks.BookmarkCreateArg);

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
      return { deleted: true };
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
      return chrome.downloads.search(query);
    }

    case "downloads.open": {
      const downloadId = params.downloadId as number;
      if (downloadId) await chrome.downloads.open(downloadId);
      return { opened: true };
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
      return { requests: sliced };
    }

    // ══════════════════════════════════════════
    // Storage
    // ══════════════════════════════════════════

    case "storage.get": {
      const keys = params.keys as string | string[] | undefined;
      if (keys) {
        const tabId = (params.tabId as number) ?? (await getActiveTabId());
        const frameId = params.frameId as number | undefined;
        const results = await chrome.scripting.executeScript({
          target: { tabId, ...(frameId !== undefined ? { frameIds: [frameId] } : {}) },
          func: (k: string | string[]) => {
            const keysArr = Array.isArray(k) ? k : [k];
            const result: Record<string, unknown> = {};
            for (const key of keysArr) result[key] = localStorage.getItem(key);
            return result;
          },
          args: [keys],
        });
        return results[0]?.result;
      }
      return {};
    }

    case "storage.set": {
      const data = params.data as Record<string, string>;
      const tabId = (params.tabId as number) ?? (await getActiveTabId());
      const frameId = params.frameId as number | undefined;
      await chrome.scripting.executeScript({
        target: { tabId, ...(frameId !== undefined ? { frameIds: [frameId] } : {}) },
        func: (d: Record<string, string>) => {
          for (const [key, val] of Object.entries(d)) localStorage.setItem(key, val);
        },
        args: [data],
      });
      return { stored: true };
    }

    // ══════════════════════════════════════════
    // Windows
    // ══════════════════════════════════════════

    case "windows.list": {
      const results = await chrome.windows.getAll({ populate: true });
      return results;
    }

    case "windows.create": {
      const createParams: chrome.windows.CreateData = {};
      if (params.url) createParams.url = params.url as string;
      return chrome.windows.create(createParams);
    }

    case "windows.focus": {
      const windowId = params.window_id as number;
      await chrome.windows.update(windowId, { focused: true });
      return { focused: true };
    }

    case "windows.close": {
      const windowId = params.window_id as number;
      if (!windowId) throw new Error("windows.close requires a 'window_id' parameter");
      await chrome.windows.remove(windowId);
      return { closed: true };
    }

    // ══════════════════════════════════════════
    // Cookies
    // ══════════════════════════════════════════

    case "cookies.get": {
      const url = params.url as string;
      const name = params.name as string;
      const cookie = await chrome.cookies.get({ url, name });
      return cookie ?? { error: "Cookie not found" };
    }

    case "cookies.set": {
      const url = params.url as string;
      const name = params.name as string;
      const value = params.value as string;
      const cookie = await chrome.cookies.set({ url, name, value });
      return cookie;
    }

    case "cookies.remove": {
      const url = params.url as string;
      const name = params.name as string;
      await chrome.cookies.remove({ url, name });
      return { removed: true };
    }

    case "cookies.list": {
      const limit = (params.limit as number) ?? 100;
      const offset = (params.offset as number) ?? 0;
      const url = params.url as string;
      const cookies = await chrome.cookies.getAll({ url });
      return cookies.slice(offset, offset + limit);
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
