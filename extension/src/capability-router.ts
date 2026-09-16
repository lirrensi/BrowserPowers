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
import { captureFullPageScreenshot, captureViewportScreenshot } from "./cdp.js";
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
  "click", "fill", "check", "select_option", "press", "scroll", "scroll_to", "wheel", "focus", "blur", "submit",
  "type", "smart_click", "fill_form", "drag", "dblclick", "hover",
  "click_at", "dblclick_at", "hover_at", "visual_click",
]);

// ── Visual capture store (single-use screenshot-bound clicks, TTL 2m, max 32) ──
interface VisualCapture {
  id: string;
  tabId: number;
  ref: string;
  pngWidth: number;
  pngHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  generation: number;
  createdAt: number;
}
const visualCaptures = new Map<string, VisualCapture>();
const VISUAL_TTL_MS = 120_000;
const VISUAL_MAX = 32;

function pruneVisualCaptures(now = Date.now()): void {
  for (const [id, c] of visualCaptures) {
    if (now - c.createdAt > VISUAL_TTL_MS) visualCaptures.delete(id);
  }
  while (visualCaptures.size > VISUAL_MAX) {
    const oldest = [...visualCaptures.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    visualCaptures.delete(oldest[0]);
  }
}

function parsePngSize(base64: string): { w: number; h: number } | null {
  try {
    const bin = atob(base64.slice(0, 100));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // PNG IHDR width/height at bytes 16-24 (8 sig + 4 len + 4 type).
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer);
    const w = view.getUint32(16);
    const h = view.getUint32(20);
    if (!w || !h || w > 16000 || h > 16000) return null;
    return { w, h };
  } catch { return null; }
}

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
    const data = out.data as { success?: boolean; error?: string; message?: string; errorCode?: string } | null | undefined;
    if (data && data.success === false) {
      // ActionResult failures carry `message` + `errorCode` (not `error`) —
      // surface those so callers see WHY inspect/act failed, not a shrug.
      const why = data.error ?? data.message;
      return {
        requestId: req.requestId,
        success: false,
        error: why
          ? `${data.errorCode ? `[${data.errorCode}] ` : ""}${why}`
          : `tool "${req.tool}" returned success:false with no error message`,
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
      try {
        appendRecordOp("page.read", cleanParams, result.status, result.errorCode, result.targetSummary);
        if ((cleanParams.action === "inspect" || cleanParams.action === "snapshot") && result.success && result.data) {
          appendRecordState(result.data as Record<string, unknown>);
        }
      } catch { /* record best-effort */ }
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

      // Screenshot-bound point click (single-use capture_id, ORIGINAL PNG coords).
      if (actAction === "visual_click") {
        const captureId = cleanParams.capture_id as string;
        const imageX = Number(cleanParams.image_x ?? cleanParams.imageX);
        const imageY = Number(cleanParams.image_y ?? cleanParams.imageY);
        if (!captureId || !Number.isFinite(imageX) || !Number.isFinite(imageY)) {
          throw new Error(`page.act visual_click requires capture_id + image_x/image_y (ORIGINAL PNG coords)`);
        }
        pruneVisualCaptures();
        const cap = visualCaptures.get(captureId);
        if (cap) visualCaptures.delete(captureId);
        if (!cap) throw new Error(`visual_capture_stale: capture ${captureId} expired/consumed — screenshot again, then click with fresh capture_id`);
        const { getGeneration: genOf } = await import("./v2/anchor-manager.js");
        if (genOf(cap.tabId) !== cap.generation) {
          throw new Error(`visual_capture_stale: ref map replaced since capture — screenshot again`);
        }
        const scaleX = cap.pngWidth && cap.viewportWidth ? cap.pngWidth / cap.viewportWidth : (cap.dpr || 1);
        const scaleY = cap.pngHeight && cap.viewportHeight ? cap.pngHeight / cap.viewportHeight : (cap.dpr || 1);
        const vx = imageX / (scaleX || 1);
        const vy = imageY / (scaleY || 1);
        const { dispatchMouseEvent: dme, ensureAttached: ea } = await import("./cdp.js");
        const attach = await ea(cap.tabId, "input.visualClick");
        if (!attach.attached) throw new Error(`CDP attach failed: ${attach.error}`);
        const down = await dme(cap.tabId, "mousePressed", vx, vy, { button: "left", clickCount: 1 });
        if (!down.ok) throw new Error(`Mouse-down failed: ${down.error}`);
        const up = await dme(cap.tabId, "mouseReleased", vx, vy, { button: "left", clickCount: 1 });
        if (!up.ok) throw new Error(`Mouse-up failed: ${up.error}`);
        const { performed: perfVisual } = await import("./v2/action-result.js");
        const vRes = perfVisual("visual_click", `Clicked capture ${captureId} at viewport (${Math.round(vx)}, ${Math.round(vy)})`, {
          evidence: { viewport: { x: Math.round(vx), y: Math.round(vy) }, image: { x: imageX, y: imageY }, ref: cap.ref },
          data: { viewport: { x: vx, y: vy }, image: { x: imageX, y: imageY }, ref: cap.ref },
        });
        return { data: vRes, executionVerdict: vRes.executionVerdict };
      }

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
          try { appendRecordOp("page.act", cleanParams, result.status, result.errorCode, result.targetSummary); } catch { /* ignore */ }
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
      try { appendRecordOp("page.act", cleanParams, actResult.status, actResult.errorCode, actResult.targetSummary); } catch { /* ignore */ }
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
      const fullPage = params.full_page === true || (params as Record<string, unknown>).fullPage === true;
      const ref = (params.ref as string | undefined) ?? (params.anchor as string | undefined);
      if (fullPage && overlay !== "none") {
        throw new Error(`screenshots.capture: full_page and overlay="${overlay}" are exclusive — capture full_page raw, then viewport overlay separately for coords.`);
      }
      if (fullPage && ref) {
        throw new Error(`screenshots.capture: full_page and ref are exclusive — use viewport ref crop OR full_page.`);
      }
      if (fullPage) {
        const fp = await captureFullPageScreenshot(tabId);
        if (fp.ok && fp.base64) {
          return { data: { base64: fp.base64, format: "png", overlay: "none", full_page: true } };
        }
        // Honest fallback: return viewport + guidance instead of fake stitching.
        const base64 = await captureViewportPng(tabId);
        return {
          data: {
            base64,
            format: "png",
            overlay: "none",
            full_page: false,
            fullPageFallback: `CDP full-page failed (${fp.error ?? "unknown"}) — returned viewport instead. For long content use page.read readable + scroll, or retry on ordinary HTTP(S) page. Virtualized/nested scrollers unsupported.`,
          },
        };
      }
      if (overlay === "none" || overlay === undefined) {
        // Fast path — no overlay, backward compat. Optional ref crop issues capture_id.
        const base64 = await captureViewportPng(tabId);
        if (!ref) return { data: { base64, format: "png", overlay: "none" } };
        // Ref element screenshot: capture viewport + issue single-use capture_id with mapping.
        const pngSize = parsePngSize(base64);
        let viewport = { w: pngSize?.w ?? 0, h: pngSize?.h ?? 0, dpr: 1 };
        try {
          const vp = await chrome.tabs.sendMessage(tabId, { source: "browserpowers", type: "bp:read", action: "viewport", params: {} }) as Record<string, unknown> | undefined;
          if (vp && typeof vp.width === "number") viewport = { w: vp.width as number, h: vp.height as number, dpr: (vp.dpr as number) || 1 };
        } catch { /* viewport best-effort; mapping falls back to PNG size */ }
        pruneVisualCaptures();
        const { getGeneration } = await import("./v2/anchor-manager.js");
        const captureId = `cap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        visualCaptures.set(captureId, {
          id: captureId, tabId, ref,
          pngWidth: pngSize?.w ?? viewport.w, pngHeight: pngSize?.h ?? viewport.h,
          viewportWidth: viewport.w, viewportHeight: viewport.h, dpr: viewport.dpr,
          generation: getGeneration(tabId), createdAt: Date.now(),
        });
        return { data: { base64, format: "png", overlay: "none", ref, capture_id: captureId, mapping: { png: pngSize, viewport }, generation: getGeneration(tabId), ttl_ms: VISUAL_TTL_MS, hint: "Use ORIGINAL PNG coords with click image_x/image_y + capture_id. Single-use, 2m TTL, invalidated by re-inspect." } };
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

    // ══════════════════════════════════════════
    // Human-loop (no borrow — dedicated automation browser)
    // ══════════════════════════════════════════

    case "human.requestHelp": {
      const prompt = params.prompt as string;
      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        throw new Error(`human.requestHelp requires 'prompt' (e.g. "Please complete sign-in")`);
      }
      const completion = params.completion_criteria as
        | { url_contains?: string; url_matches?: string }
        | undefined;
      if (completion && (completion as Record<string, unknown>).text_exists !== undefined) {
        throw new Error(`human.requestHelp: completion_criteria.text_exists not supported in this version — use url_contains/url_matches, or omit criteria for manual Continue.`);
      }
      if (completion && (completion as Record<string, unknown>).selector_exists !== undefined) {
        throw new Error(`human.requestHelp: completion_criteria.selector_exists not supported in this version — use url_contains/url_matches, or omit criteria for manual Continue.`);
      }
      const targetSummary = params.target
        ? JSON.stringify(params.target)
        : params.anchor
          ? `anchor ${params.anchor}`
          : undefined;
      const deadlineMs = Math.max(10_000, Math.min(Number(params.deadline_ms ?? 300_000) || 300_000, 600_000));
      return { data: await requestHumanHelp({ prompt, deadlineMs, completion, targetSummary }) };
    }

    case "human.helpStatus": {
      const notifId = params.notif_id as string;
      if (!notifId) throw new Error(`human.helpStatus requires 'notif_id' from human.requestHelp`);
      return { data: await humanHelpStatus(notifId) };
    }

    // ══════════════════════════════════════════
    // Record lite (trace.json textbook, no overlay)
    // ══════════════════════════════════════════

    case "record.start": {
      const purpose = (params.purpose as string) ?? "";
      // Never record banking/SSO/password-manager pages (lite guard).
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = (tab?.url ?? "").toLowerCase();
        if (/bank|secure.*login|sso|password|vault|1password|lastpass/.test(url)) {
          throw new Error(`record.start refused on sensitive page (${tab?.url}) — never record banking/SSO/password-manager`);
        }
      } catch (e) {
        if ((e as Error).message.startsWith("record.start refused")) throw e;
        // URL check best-effort; proceed if tabs unavailable.
      }
      if (recording) throw new Error(`record.start: already recording since ${new Date(recording.startedAt).toISOString()} — stop first`);
      recording = { startedAt: Date.now(), purpose: String(purpose).slice(0, 200), ops: [], states: [] };
      return { data: { recording: true, startedAt: recording.startedAt, purpose: recording.purpose } };
    }

    case "record.status": {
      if (!recording) return { data: { recording: false, ops: 0 } };
      return { data: { recording: true, startedAt: recording.startedAt, purpose: recording.purpose, ops: recording.ops.length } };
    }

    case "record.stop": {
      if (!recording) throw new Error(`record.stop: not recording — call record.start first`);
      const rec = recording;
      recording = null;
      const trace = {
        version: "3-lite",
        startedAt: new Date(rec.startedAt).toISOString(),
        stoppedAt: new Date().toISOString(),
        purpose: rec.purpose,
        ops: rec.ops,
        states: rec.states.slice(-10),
        note: "Lite textbook: semantic ops + last 10 VOM states. Follow trace targets/values in order, not old refs. Trace grants no extra auth.",
      };
      return { data: trace };
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// ── Recorder buffer (in-memory, SW lifetime) ──
interface RecordOp {
  seq: number;
  ts: string;
  tool: string;
  action?: string;
  targetSummary?: string;
  outcome?: string;
  errorCode?: string;
}
interface Recording {
  startedAt: number;
  purpose: string;
  ops: RecordOp[];
  states: Array<Record<string, unknown>>;
}
let recording: Recording | null = null;
let recordSeq = 0;

function redactRecordParams(tool: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (["value", "text", "code", "file_data", "password", "token"].includes(k)) out[k] = "[redacted]";
    else if (k === "target" && typeof v === "object" && v !== null) {
      const t = v as Record<string, unknown>;
      out[k] = { ...(t.css ? { css: t.css } : {}), ...(t.text ? { text: String(t.text).slice(0, 80) } : {}), ...(t.role ? { role: t.role } : {}) };
    } else if (typeof v === "string" && v.length > 200) out[k] = v.slice(0, 200) + "...(truncated)";
    else out[k] = v;
  }
  void tool;
  return out;
}

function appendRecordOp(tool: string, params: Record<string, unknown>, status?: string, errorCode?: string, targetSummary?: string): void {
  if (!recording) return;
  if (tool.startsWith("record.")) return;
  recordSeq += 1;
  recording.ops.push({
    seq: recordSeq,
    ts: new Date().toISOString(),
    tool,
    action: (params.action as string) ?? undefined,
    targetSummary: (targetSummary ?? (params.anchor as string) ?? (params.target ? JSON.stringify(redactRecordParams(tool, { target: params.target }).target) : undefined)) as string | undefined,
    outcome: status,
    errorCode,
  });
  if (recording.ops.length > 500) recording.ops.splice(0, recording.ops.length - 500);
}

function appendRecordState(state: Record<string, unknown>): void {
  if (!recording) return;
  recording.states.push({ ts: new Date().toISOString(), url: state.url, title: state.title, anchorCount: (state.anchors as unknown[])?.length ?? 0 });
  if (recording.states.length > 20) recording.states.splice(0, recording.states.length - 20);
}

/**
 * Ask the human to complete an in-page step (login, CAPTCHA, OTP, confirm).
 * Dedicated automation browser model — no borrow, walk-away by default.
 *
 * UX: OS notification (requireInteraction) with [Continue] [Cancel] buttons
 * + badge dot. Human does the task in the browser, then clicks Continue.
 * Optional completion_criteria.url_contains/url_matches polls the active tab
 * URL every 500ms and auto-completes (completed_by: "system").
 *
 * Outcomes: continued (human clicked Continue) | completed (criteria met) |
 * cancelled (human clicked Cancel / closed) | timed_out.
 * Caller must re-inspect after continued/completed — refs are stale.
 */
/**
 * Termination-proof human wait (MV3 service workers do NOT survive a minutes
 * long `await`: timers die with them and the core never gets an answer).
 *
 * `requestHumanHelp` shows the notification, persists `{status:"pending"}`
 * to `chrome.storage.session`, arms a deadline alarm, and returns
 * IMMEDIATELY with `{outcome:"pending", notif_id}`. The CORE polls
 * `human.helpStatus` until a terminal outcome or its own deadline — the
 * core clock never sleeps, so the agent always gets an answer even if the
 * worker is terminated and restarted ten times in between.
 *
 * Outcomes: continued (human clicked Continue) | completed (criteria met) |
 * cancelled (human clicked Cancel / dismissed) | timed_out.
 * Caller must re-inspect after continued/completed — refs are stale.
 */
async function requestHumanHelp(opts: {
  prompt: string;
  deadlineMs: number;
  completion?: { url_contains?: string; url_matches?: string };
  targetSummary?: string;
}): Promise<Record<string, unknown>> {
  const start = Date.now();
  if (opts.completion?.url_matches) {
    try { void new RegExp(opts.completion.url_matches); }
    catch {
      throw new Error(`human.requestHelp: completion_criteria.url_matches is not a valid regex: ${opts.completion.url_matches}`);
    }
  }
  const notifId = `bp-help:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
  const message = [opts.prompt, opts.targetSummary ? `Target: ${opts.targetSummary}` : ""]
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);

  ensureHelpLoop();
  try {
    await chrome.storage.session.set({
      [`help:${notifId}`]: {
        status: "pending",
        prompt: opts.prompt.slice(0, 500),
        startedAt: start,
        deadline: start + opts.deadlineMs,
        completion: opts.completion ?? null,
        targetSummary: opts.targetSummary ?? null,
      },
    });
  } catch (e) {
    throw new Error(`human.requestHelp: cannot persist wait state (${(e as Error)?.message ?? e})`);
  }
  try { void chrome.alarms.create(`bp-help-deadline:${notifId}`, { when: start + opts.deadlineMs }); } catch { /* alarms best-effort; core deadline still enforced */ }

  // Fire-and-forget: notification/badge calls can hang in some profiles and
  // must never wedge the (already returned) wait.
  void chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icon-128.png",
    title: "BrowserPowers needs your help",
    message,
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: "Continue" }, { title: "Cancel" }],
  }).catch(() => { /* notification failed — human can still be reached via badge/popup; wait stands */ });
  void (async () => {
    try {
      await chrome.action.setBadgeText({ text: "•" });
      await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    } catch { /* badge best-effort */ }
  })();

  return {
    outcome: "pending",
    notif_id: notifId,
    elapsed_ms: Date.now() - start,
    hint: "Poll human.helpStatus with notif_id until a terminal outcome (continued/completed/cancelled/timed_out).",
  };
}

interface HelpRecord {
  status: "pending" | "continued" | "completed" | "cancelled" | "timed_out";
  prompt: string;
  startedAt: number;
  deadline: number;
  completion: { url_contains?: string; url_matches?: string } | null;
  targetSummary: string | null;
  decidedAt?: number;
  completedBy?: "human" | "system";
}

function helpEnvelope(rec: HelpRecord, outcome: HelpRecord["status"]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    outcome,
    prompt: rec.prompt,
    elapsed_ms: Date.now() - rec.startedAt,
  };
  switch (outcome) {
    case "continued":
      return { ...base, completed_by: "human", hint: "Re-inspect before next action — refs are stale." };
    case "completed":
      return { ...base, completed_by: "system", hint: "Completion criteria met — re-inspect before next action." };
    case "cancelled":
      return { ...base, hint: "Human cancelled — respect rejection, do not repeat request." };
    case "timed_out":
      return { ...base, hint: "No human response in time — report blocker, do not loop request." };
    default:
      return { ...base, hint: "Wait still pending." };
  }
}

/**
 * First-writer-wins transition pending → terminal. Returns the envelope for
 * the (possibly pre-existing) terminal state, or null if still pending.
 */
async function settleHelp(notifId: string, outcome: "continued" | "completed" | "cancelled" | "timed_out", completedBy?: "human" | "system"): Promise<Record<string, unknown> | null> {
  const key = `help:${notifId}`;
  let rec: HelpRecord | null = null;
  try {
    const got = await chrome.storage.session.get(key) as Record<string, unknown>;
    rec = (got?.[key] as HelpRecord | undefined) ?? null;
  } catch { /* storage hiccup — treat as unknown below */ }
  if (!rec) return null;
  if (rec.status !== "pending") return helpEnvelope(rec, rec.status);
  const settled: HelpRecord = { ...rec, status: outcome, decidedAt: Date.now(), completedBy };
  try { await chrome.storage.session.set({ [key]: settled }); } catch { /* keep going — answer from memory */ }
  try { void chrome.notifications.clear(notifId); } catch { /* ignore */ }
  try { void chrome.action.setBadgeText({ text: "" }); } catch { /* ignore */ }
  try { void chrome.alarms.clear(`bp-help-deadline:${notifId}`); } catch { /* ignore */ }
  return helpEnvelope(settled, outcome);
}

async function humanHelpStatus(notifId: string): Promise<Record<string, unknown>> {
  const key = `help:${notifId}`;
  let rec: HelpRecord | null = null;
  try {
    const got = await chrome.storage.session.get(key) as Record<string, unknown>;
    rec = (got?.[key] as HelpRecord | undefined) ?? null;
  } catch { /* storage hiccup */ }
  // Unknown id: a finished wait is cleaned up, an orphaned one swept — either
  // way there is no human action to wait for. Safe default, never a retry loop.
  if (!rec) {
    return { outcome: "timed_out", elapsed_ms: 0, hint: "Unknown or expired help id — no human action pending; do not re-request." };
  }
  if (rec.status !== "pending") return helpEnvelope(rec, rec.status);
  if (Date.now() >= rec.deadline) {
    return (await settleHelp(notifId, "timed_out")) ?? helpEnvelope({ ...rec, status: "timed_out" }, "timed_out");
  }
  // Completion criteria are evaluated lazily on poll (core-driven cadence) —
  // no SW-side loop needed, so nothing dies with the worker.
  const urlContains = rec.completion?.url_contains;
  const urlMatches = rec.completion?.url_matches;
  if (urlContains || urlMatches) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url ?? "";
      let done = false;
      if (urlContains && url.includes(urlContains)) done = true;
      if (!done && urlMatches) { try { done = new RegExp(urlMatches).test(url); } catch { /* bad regex validated at request time */ } }
      if (done) {
        return (await settleHelp(notifId, "completed", "system")) ?? helpEnvelope({ ...rec, status: "completed" }, "completed");
      }
    } catch { /* tab query best-effort */ }
  }
  return { outcome: "pending", prompt: rec.prompt, elapsed_ms: Date.now() - rec.startedAt, hint: "Still waiting — poll again." };
}

// ── Help-request global plumbing (registered once, survives restarts) ──
// Button/close/alarm handlers live GLOBALY (not per-request) so a human click
// is honored even if the worker was terminated and restarted mid-wait — the
// decision lands in storage, where the core's next poll finds it.

let helpLoopHooked = false;

function ensureHelpLoop(): void {
  if (helpLoopHooked) return;
  helpLoopHooked = true;
  try {
    chrome.notifications.onButtonClicked.addListener((id, btnIdx) => {
      if (!id.startsWith("bp-help:")) return;
      void settleHelp(id, btnIdx === 0 ? "continued" : "cancelled", "human");
    });
  } catch { /* notifications unavailable */ }
  try {
    chrome.notifications.onClosed.addListener((id) => {
      if (!id.startsWith("bp-help:")) return;
      void settleHelp(id, "cancelled", "human");
    });
  } catch { /* ignore */ }
  try {
    chrome.notifications.onClicked.addListener((id) => {
      if (!id.startsWith("bp-help:")) return;
      try { void chrome.action.openPopup?.(); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm.name.startsWith("bp-help-deadline:")) return;
      const notifId = alarm.name.slice("bp-help-deadline:".length);
      // Backstop for abandoned waits (core gone): settle so nothing lingers.
      void settleHelp(notifId, "timed_out").catch(() => {});
    });
  } catch { /* alarms unavailable */ }
  // Rehydrate: sweep storage left by a terminated worker.
  try {
    void chrome.storage.session.get(null).then((all) => {
      const now = Date.now();
      for (const [k, v] of Object.entries((all ?? {}) as Record<string, unknown>)) {
        if (!k.startsWith("help:")) continue;
        const rec = v as HelpRecord | null;
        const notifId = k.slice("help:".length);
        if (!rec || rec.status !== "pending" || (rec.deadline ?? 0) <= now) {
          try { void chrome.notifications.clear(notifId); } catch { /* ignore */ }
          try { void chrome.storage.session.remove(k); } catch { /* ignore */ }
        } else {
          try { void chrome.alarms.create(`bp-help-deadline:${notifId}`, { when: rec.deadline }); } catch { /* ignore */ }
        }
      }
    });
  } catch { /* persistence best-effort */ }
}

/**
 * Call once at service-worker startup: hooks global help handlers and sweeps
 * orphans left by a terminated worker.
 */
export function rehydrateHelpRequests(): void {
  ensureHelpLoop();
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab.id;
}

/**
 * Viewport PNG as base64. Primary: `captureVisibleTab` (fast, compositor).
 * Fallback: CDP renderer source (survives occluded windows / Windows
 * readback failures). Throws an honest combined error if both fail —
 * caller should suggest focusing the window and retrying once.
 */
async function captureViewportPng(tabId: number): Promise<string> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(
      (tabId as any)?.windowId,
      { format: "png" },
    );
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  } catch (visibleErr) {
    const fb = await captureViewportScreenshot(tabId);
    if (fb.ok && fb.base64) return fb.base64;
    throw new Error(
      `Viewport capture failed (visibleTab: ${(visibleErr as Error)?.message ?? visibleErr}; CDP: ${fb.error ?? "unknown"}) — focus the browser window and retry once`,
    );
  }
}
