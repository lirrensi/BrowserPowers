/**
 * FILE: extension/src/v2/page-js.ts
 * PURPOSE: Execute arbitrary JavaScript on the page — the `page.js` escape hatch.
 *          Primary path: CDP `Runtime.evaluate` via `extension/src/cdp.ts`. This
 *          gives the script full access to page variables and bypasses page CSP
 *          (the debugger runs in the browser's privileged context).
 *          Fallback path: the content script's isolated-world `handleJs` (the
 *          existing `new Function` evaluator). Used only if CDP attach fails
 *          (e.g. user denied debugger consent, DevTools open on the same tab).
 *
 *          The verdict names the actual path taken:
 *            - world: "main", path: "cdp.runtime.evaluate" — success via CDP
 *            - world: "main", path: "cdp.runtime.attach"     — attach failed,
 *              no fallback (rare; the fallback is the default for failures)
 *            - world: "isolated", path: "isolated.newFunction" — fallback used
 *              because CDP attach was denied or otherwise impossible.
 *
 *          `frameId` is NOT supported by the CDP path — targeting a non-top
 *          frame requires `Page.enable` + frame-tree mapping which is out of
 *          scope for this goal. We reject frameId early with a clean error.
 *
 * OWNS: page.js dispatch — CDP primary, isolated-world fallback.
 * EXPORTS: dispatchJsAction
 * DOCS: .agents/reports/plan_cdp-max-authority_2026-06-22.md
 */

import { performed, blocked } from "./action-result.js";
import { ensureAttached, runtimeEvaluate } from "../cdp.js";
import type { ActionResult, ExecutionVerdict } from "../types.js";

export async function dispatchJsAction(code: string, tabId: number, frameId?: number): Promise<ActionResult> {
  if (!code) {
    return blocked("js", "No code provided", {
      errorCode: "MISSING_PARAM",
      suggestions: ["Provide JavaScript code to execute"],
      executionVerdict: { executed: false, world: "isolated", durationMs: 0, path: "isolated.newFunction" },
    });
  }

  // CDP path does not yet support per-frame targeting.
  if (frameId !== undefined && frameId !== 0) {
    return blocked("js", "page.js with frameId is not supported by the CDP path", {
      errorCode: "FRAMES_NOT_SUPPORTED_IN_CDP_PATH",
      recoverable: false,
      suggestions: [
        "Drop the frameId parameter — CDP evaluates in the top frame by default",
        "Or target the top frame directly",
      ],
      executionVerdict: { executed: false, world: "main", durationMs: 0, path: "cdp.runtime.attach" },
    });
  }

  // Lazy-attach. If this fails (consent denied, DevTools lock, etc.) we fall
  // back to the content-script isolated-world `new Function` path.
  const attach = await ensureAttached(tabId, "page.js");
  if (!attach.attached) {
    return await fallbackToIsolated(code, tabId, frameId, attach.error);
  }

  const result = await runtimeEvaluate(tabId, code);

  if (!result.ok || result.exceptionDetails) {
    const ed = result.exceptionDetails;
    const errorName = (ed?.exception as { className?: string } | undefined)?.className ?? "CDPException";
    const message = (ed?.exception as { description?: string } | undefined)?.description ?? ed?.text ?? "Script error";
    return blocked("js", `JavaScript execution failed: ${message}`, {
      errorCode: "JS_EXECUTION_ERROR",
      recoverable: true,
      suggestions: [
        "Check the JavaScript syntax",
        "Ensure the code is a valid expression or statement",
      ],
      executionVerdict: {
        executed: false,
        world: "main",
        error: {
          name: errorName,
          message,
          line: ed?.lineNumber,
          column: ed?.columnNumber,
        },
        durationMs: result.durationMs,
        path: "cdp.runtime.evaluate",
      },
    });
  }

  // Success — return value from CDP. Try to serialize for the wire; if the
  // value contains non-JSON-serializable parts, fall back to a descriptor.
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
    world: "main",
    value: serialized,
    durationMs: result.durationMs,
    path: "cdp.runtime.evaluate",
  };

  return performed("js", "JavaScript executed successfully", {
    data: { result: serialized },
    evidence: { hasResult: serialized !== undefined },
    executionVerdict: verdict,
  });
}

/**
 * Fallback when CDP attach fails. Sends a `bp:js` message to the content
 * script which evaluates via `new Function` in its isolated world. The
 * returned verdict already has `world: "isolated"`, `path: "isolated.newFunction"`.
 */
async function fallbackToIsolated(
  code: string,
  tabId: number,
  frameId: number | undefined,
  attachError: string | undefined,
): Promise<ActionResult> {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      {
        source: "browserpowers",
        type: "bp:js",
        params: { code },
      } as any,
      frameId ? { frameId } : {},
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

    const result = (response as any).data?.result ?? (response as any).result;
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
