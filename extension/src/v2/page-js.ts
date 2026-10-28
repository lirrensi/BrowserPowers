/**
 * FILE: extension/src/v2/page-js.ts
 * PURPOSE: Execute arbitrary JavaScript on the page — the `page.js` escape hatch.
 *          Top frame: CDP `Runtime.evaluate` via `extension/src/cdp.ts` (main
 *          world, full page-variable access, CSP-immune).
 *          Subframes: CDP `Page.createIsolatedWorld({frameId})` + `Runtime.evaluate`
 *          with that contextId. DOM access works; page JS globals do not — the
 *          verdict says `world: "isolated"`, path `cdp.runtime.evaluate.frame`.
 *          This replaced the content-script `new Function` path for frames,
 *          which MV3's CSP blocks (unsafe-eval).
 *          Fallback for the top frame only: if CDP attach fails (consent denied,
 *          DevTools lock, etc.), evaluate in the content script's isolated world.
 *
 *          The verdict names the actual path taken:
 *            - world: "main", path: "cdp.runtime.evaluate"       — top frame via CDP
 *            - world: "isolated", path: "cdp.runtime.evaluate.frame" — subframe via CDP
 *            - world: "isolated", path: "isolated.newFunction"   — top-frame CDP fallback
 *
 * OWNS: page.js dispatch — CDP primary, isolated-world fallback.
 * EXPORTS: dispatchJsAction
 * DOCS: .agents/reports/plan_cdp-max-authority_2026-06-22.md
 */

import { performed, blocked } from "./action-result.js";
import { ensureAttached, runtimeEvaluate, sendCommand, type EvalResult } from "../cdp.js";
import type { ActionResult, ExecutionVerdict } from "../types.js";

export async function dispatchJsAction(code: string, tabId: number, frameId?: number): Promise<ActionResult> {
  if (!code) {
    return blocked("js", "No code provided", {
      errorCode: "MISSING_PARAM",
      suggestions: ["Provide JavaScript code to execute"],
      executionVerdict: { executed: false, world: "isolated", durationMs: 0, path: "isolated.newFunction" },
    });
  }

  if (frameId !== undefined && frameId !== 0) {
    return await dispatchFrameJs(code, tabId, frameId);
  }

  // Lazy-attach. If this fails (consent denied, DevTools lock, etc.) we fall
  // back to the content-script isolated-world `new Function` path.
  const attach = await ensureAttached(tabId, "page.js");
  if (!attach.attached) {
    return await fallbackToIsolated(code, tabId, attach.error);
  }

  const result = await runtimeEvaluate(tabId, code);
  return evalResultToAction(result, { world: "main", path: "cdp.runtime.evaluate" });
}

/**
 * Evaluate inside a subframe through CDP. `Page.createIsolatedWorld` gives a
 * frame-scoped execution context; `Runtime.evaluate` with that contextId runs
 * there. DOM access only — verdict world:"isolated".
 */
async function dispatchFrameJs(code: string, tabId: number, frameId: number): Promise<ActionResult> {
  const attach = await ensureAttached(tabId, "page.js");
  if (!attach.attached) {
    return blocked("js", `CDP attach failed (${attach.error ?? "unknown"}) — frame-targeted page.js needs the debugger`, {
      errorCode: "CDP_ATTACH_FAILED",
      recoverable: true,
      suggestions: ["Close Chrome DevTools on this tab and retry", "Check that the extension has the debugger permission"],
      executionVerdict: { executed: false, world: "isolated", durationMs: 0, path: "cdp.runtime.evaluate.frame" },
    });
  }

  // Best-effort: createIsolatedWorld generally works without Page.enable.
  await sendCommand(tabId, "Page.enable");

  // CDP frame ids are strings; chrome's numeric frameId is a different space.
  // Bridge them by the frame URL from webNavigation vs Page.getFrameTree.
  const navFrames = await chrome.webNavigation.getAllFrames({ tabId });
  const targetUrl = navFrames?.find((f) => f.frameId === frameId)?.url;
  if (!targetUrl) {
    return blocked("js", `frame ${frameId} not found (it may have navigated or been removed)`, {
      errorCode: "FRAME_NOT_FOUND",
      recoverable: true,
      suggestions: ["Verify the frame id with page_read action=frames and retry"],
      executionVerdict: { executed: false, world: "isolated", durationMs: 0, path: "cdp.runtime.evaluate.frame" },
    });
  }
  const cdpFrames: Array<{ id: string; url: string }> = [];
  const tree = await sendCommand(tabId, "Page.getFrameTree");
  if (tree.ok) collectCdpFramesFromValue(tree.value, cdpFrames);
  const matches = cdpFrames.filter((f) => f.url === targetUrl);
  if (matches.length !== 1) {
    const detail = matches.length === 0
      ? `no CDP frame matches ${targetUrl}`
      : `${matches.length} CDP frames share ${targetUrl} (${matches.map((m) => m.id).join(", ")}) — target a unique frame_url`;
    return blocked("js", `cannot map frame ${frameId} to a CDP frame: ${detail}`, {
      errorCode: "FRAME_CONTEXT_UNAVAILABLE",
      recoverable: true,
      suggestions: ["Use page_read action=frames to inspect frame URLs", "Frame-targeted page_js needs a unique frame URL"],
      executionVerdict: { executed: false, world: "isolated", durationMs: 0, path: "cdp.runtime.evaluate.frame" },
    });
  }

  const world = await sendCommand(tabId, "Page.createIsolatedWorld", {
    frameId: matches[0].id,
    worldName: "browserpowers-frame",
    grantUniveralAccess: false,
  });
  const contextId = world.ok
    ? readExecutionContextId(world.value)
    : undefined;
  if (contextId === undefined) {
    return blocked("js", `frame ${frameId} execution context unavailable${world.error ? `: ${world.error}` : ""}`, {
      errorCode: "FRAME_CONTEXT_UNAVAILABLE",
      recoverable: true,
      suggestions: ["Verify the frame id with page_read action=frames", "The frame may have navigated or been removed"],
      executionVerdict: { executed: false, world: "isolated", durationMs: 0, path: "cdp.runtime.evaluate.frame" },
    });
  }

  const result = await runtimeEvaluate(tabId, code, { contextId });
  return evalResultToAction(result, { world: "isolated", path: "cdp.runtime.evaluate.frame", note: `frame ${frameId}, isolated world` });
}

/** Extract executionContextId from the unknown CDP createIsolatedWorld payload. */
function readExecutionContextId(value: unknown): number | undefined {
  if (value && typeof value === "object" && "executionContextId" in value) {
    const id = value.executionContextId;
    return typeof id === "number" ? id : undefined;
  }
  return undefined;
}

/** Flatten Page.getFrameTree's unknown payload into {id,url} entries. */
function collectCdpFramesFromValue(value: unknown, out: Array<{ id: string; url: string }>): void {
  if (value && typeof value === "object" && "frameTree" in value) {
    collectCdpFrames(value.frameTree, out);
  }
}

function collectCdpFrames(node: unknown, out: Array<{ id: string; url: string }>): void {
  if (!node || typeof node !== "object") return;
  const frame = "frame" in node ? node.frame : undefined;
  if (frame && typeof frame === "object") {
    const id = "id" in frame && typeof frame.id === "string" ? frame.id : undefined;
    const url = "url" in frame && typeof frame.url === "string" ? frame.url : "";
    if (id) out.push({ id, url });
  }
  const children = "childFrames" in node ? node.childFrames : undefined;
  if (Array.isArray(children)) {
    for (const child of children) collectCdpFrames(child, out);
  }
}

/** Map a CDP EvalResult to the ActionResult contract (success and exception paths). */
function evalResultToAction(
  result: EvalResult,
  opts: { world: "main" | "isolated"; path: string; note?: string },
): ActionResult {
  if (!result.ok || result.exceptionDetails) {
    const ed = result.exceptionDetails;
    const errorName = ed?.exception?.className ?? "CDPException";
    const message = ed?.exception?.description ?? ed?.text ?? "Script error";
    return blocked("js", `JavaScript execution failed: ${message}`, {
      errorCode: "JS_EXECUTION_ERROR",
      recoverable: true,
      suggestions: [
        "Check the JavaScript syntax",
        "Ensure the code is a valid expression or statement",
      ],
      executionVerdict: {
        executed: false,
        world: opts.world,
        error: {
          name: errorName,
          message,
          line: ed?.lineNumber,
          column: ed?.columnNumber,
        },
        durationMs: result.durationMs,
        path: opts.path,
      },
    });
  }

  // Success — try to serialize for the wire; if the value contains
  // non-JSON-serializable parts, fall back to a descriptor.
  let serialized: unknown;
  try {
    serialized = JSON.parse(JSON.stringify(result.value));
  } catch {
    serialized = {
      _nonSerializable: true,
      type: typeof result.value,
      hint: result.value === null ? "null" : (result.value as { constructor?: { name?: string } })?.constructor?.name ?? typeof result.value,
    };
  }

  const verdict: ExecutionVerdict = {
    executed: true,
    world: opts.world,
    value: serialized,
    durationMs: result.durationMs,
    path: opts.path,
  };

  return performed("js", `JavaScript executed successfully${opts.note ? ` (${opts.note})` : ""}`, {
    data: { result: serialized },
    evidence: { hasResult: serialized !== undefined },
    executionVerdict: verdict,
  });
}

/**
 * Top-frame fallback when CDP attach fails. Sends a `bp:js` message to the
 * content script which evaluates via `new Function` in its isolated world.
 * (MV3 CSP blocks `new Function` on some builds, so this is best-effort.)
 */
async function fallbackToIsolated(
  code: string,
  tabId: number,
  attachError: string | undefined,
): Promise<ActionResult> {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      {
        source: "browserpowers",
        type: "bp:js",
        params: { code },
      },
      { frameId: 0 },
    ) as Record<string, unknown> | undefined;

    if (!response) {
      return blocked("js", `CDP attach failed (${attachError ?? "unknown"}); content-script fallback unavailable`, {
        errorCode: "CDP_ATTACH_FAILED_AND_NO_FALLBACK",
        recoverable: true,
        suggestions: [
          "Close Chrome DevTools on this tab and retry",
          "Check that the extension has the debugger permission",
        ],
        executionVerdict: { executed: false, world: "main", durationMs: 0, path: "cdp.runtime.attach" },
      });
    }

    const executionVerdict = response.executionVerdict as ExecutionVerdict | undefined;
    const runtimeStatus = response.runtimeStatus as ExecutionVerdict | undefined;

    if (response.success === false) {
      return blocked("js", (response.message as string) || (response.error as string), {
        errorCode: (response.errorCode as string) || "CDP_ATTACH_FAILED_FALLBACK_ERROR",
        recoverable: true,
        suggestions: [
          "Close Chrome DevTools on this tab so the debugger can attach",
          "Check that the extension has the debugger permission",
          "Check the JavaScript syntax",
        ],
        executionVerdict,
        runtimeStatus,
      });
    }

    const data = response.data as Record<string, unknown> | undefined;
    const result = data?.result ?? response.result;
    return performed("js", "JavaScript executed (isolated-world fallback — CDP attach denied)", {
      data: { result, _fallback: "isolated", _cdpAttachError: attachError },
      evidence: { hasResult: result !== undefined },
      executionVerdict,
      runtimeStatus,
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return blocked("js", `CDP attach failed (${attachError ?? "unknown"}); fallback error: ${msg}`, {
      errorCode: "CDP_ATTACH_FAILED_AND_NO_FALLBACK",
      recoverable: true,
      suggestions: [
        "Close Chrome DevTools on this tab and retry",
        "Check that the extension has the debugger permission",
      ],
      executionVerdict: { executed: false, world: "main", durationMs: 0, path: "cdp.runtime.attach" },
    });
  }
}
