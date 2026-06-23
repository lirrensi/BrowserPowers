/**
 * FILE: extension/src/v2/page-act.ts
 * PURPOSE: Dispatch act actions (click, fill, check, select_option, press, scroll, submit, wait_for,
 *          type, smart_click, fill_form, upload, drag, dblclick, hover, dialog_override, dialog_respond)
 *          via chrome.tabs.sendMessage to the persistent content script.
 *          Surfaces the content-script ExecutionVerdict at the top level of
 *          the ActionResult and forwards shadowPath from anchors.
 *          After the CDP-input-parity refactor (2026-06-23), five act actions
 *          use a CDP primary path with a synthetic-event fallback:
 *            click / dblclick / hover — CDP `Input.dispatchMouseEvent` at
 *              element center coords returned by the CS's resolve step.
 *              Fallback to a bp:fallback-click / -dblclick / -hover message.
 *            type — CDP `focusElement` + `Input.insertText` with the JS
 *              expression and text returned by the CS. Fallback to
 *              bp:fallback-type.
 *            fill — CDP `setElementValue` (Runtime.evaluate in main world
 *              that sets .value and dispatches input/change). Fallback to
 *              bp:fallback-fill.
 *          Other act actions (press, check, select_option, submit, scroll,
 *          drag, upload, dialog_*) still go through the content script
 *          directly — synthetic events work fine for them.
 * OWNS: page.act dispatch — each act action implementation in the service worker.
 * EXPORTS: dispatchActAction
 * DOCS: .agents/reports/plan_content-script-arch_2026-05-28.md,
 *       .agents/reports/plan_runtime-verdict_2026-06-22.md,
 *       .agents/reports/plan_cdp-input-parity_2026-06-23.md
 */

import { getAnchor } from "./anchor-manager.js";
import { performed, notPerformed, ambiguous, blocked } from "./action-result.js";
import {
  ensureAttached,
  dispatchMouseEvent,
  insertText,
  focusElement,
  setElementValue,
} from "../cdp.js";
import type { ActionResult, Target, ExecutionVerdict } from "../types.js";

type ActAction =
  | "click" | "fill" | "check" | "select_option" | "press" | "scroll" | "submit"
  | "wait_for" | "type" | "smart_click" | "fill_form" | "upload" | "drag"
  | "dblclick" | "hover" | "dialog_override" | "dialog_respond";

type WaitCondition =
  | "exists" | "visible" | "hidden" | "enabled" | "disabled" | "stable"
  | "url" | "network_idle" | "load_state" | "function";

export async function dispatchActAction(
  action: ActAction,
  params: Record<string, unknown>,
  tabId: number,
  frameId?: number,
): Promise<ActionResult> {
  switch (action) {
    case "click": return click(params, tabId, frameId);
    case "fill": return fill(params, tabId, frameId);
    case "check": return check(params, tabId, frameId);
    case "select_option": return selectOption(params, tabId, frameId);
    case "press": return press(params, tabId, frameId);
    case "scroll": return scrollAction(params, tabId, frameId);
    case "submit": return submit(params, tabId, frameId);
    case "wait_for": return waitFor(params, tabId, frameId);
    case "type": return typeAction(params, tabId, frameId);
    case "smart_click": return smartClick(params, tabId, frameId);
    case "fill_form": return fillForm(params, tabId, frameId);
    case "upload": return uploadAction(params, tabId, frameId);
    case "drag": return dragAction(params, tabId, frameId);
    case "dblclick": return dblclickAction(params, tabId, frameId);
    case "hover": return hoverAction(params, tabId, frameId);
    case "dialog_override": return dialogOverride(params, tabId, frameId);
    case "dialog_respond": return dialogRespond(params, tabId, frameId);
    default:
      return notPerformed("act", `Unknown act action: ${action}`);
  }
}

// ── Helper: send act message to content script ──

/** Extract the ExecutionVerdict and runtimeStatus from a content-script response. */
function extractVerdicts(response: Record<string, unknown> | null | undefined): {
  executionVerdict?: ExecutionVerdict;
  runtimeStatus?: ExecutionVerdict;
} {
  if (!response) return {};
  return {
    executionVerdict: response.executionVerdict as ExecutionVerdict | undefined,
    runtimeStatus: response.runtimeStatus as ExecutionVerdict | undefined,
  };
}

async function sendActMessage(
  tabId: number,
  action: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const maxRetries = 3;
  const delays = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        source: "browserpowers",
        type: "bp:act",
        action,
        params,
      }) as Record<string, unknown>;

      if (!response) {
        return blocked(action, "No response from content script", {
          errorCode: "CONTENT_SCRIPT_NOT_READY",
          recoverable: true,
        });
      }

      const { executionVerdict, runtimeStatus } = extractVerdicts(response);

      // Map content script response to ActionResult
      if (response.errorCode === "ANCHOR_STALE") {
        return blocked(action, response.message as string, {
          errorCode: "ANCHOR_STALE",
          recoverable: true,
          suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
          executionVerdict,
          runtimeStatus,
        });
      }
      if (response.blocked) {
        return blocked(action, response.message as string, {
          errorCode: "OVERLAY_BLOCKED",
          recoverable: true,
          evidence: response.evidence as Record<string, unknown>,
          suggestions: [
            "Close any modals, popups, or spinners first",
            "Run page.read with action=inspect to see current elements",
          ],
          executionVerdict,
          runtimeStatus,
        });
      }
      if (response.errorCode === "AMBIGUOUS_TARGET") {
        return ambiguous(action, response.message as string, {
          errorCode: "AMBIGUOUS_TARGET",
          recoverable: true,
          evidence: { matchedCount: response.matchCount },
          suggestions: ["Run page.read with action=inspect to choose an anchor", "Refine the target"],
          executionVerdict,
          runtimeStatus,
        });
      }
      if (response.errorCode === "TARGET_NOT_FOUND" || response.success === false) {
        return notPerformed(action, response.message as string, {
          errorCode: response.errorCode as string | undefined,
          executionVerdict,
          runtimeStatus,
        });
      }

      return performed(action, (response.message as string) || `${action} completed`, {
        evidence: response.evidence as Record<string, unknown>,
        data: response,
        executionVerdict,
        runtimeStatus,
      });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (msg.includes("receiving end does not exist") || msg.includes("Could not establish connection")) {
        if (attempt < maxRetries) {
          console.warn(`[bp-ext] page-act sendMessage attempt ${attempt + 1} failed, retrying in ${delays[attempt]}ms`);
          await new Promise(r => setTimeout(r, delays[attempt]));
          continue;
        }
        return blocked(action, "Content script not available — page may not be loaded", {
          errorCode: "CONTENT_SCRIPT_NOT_READY",
          recoverable: true,
          suggestions: ["Wait for the page to finish loading", "Retry the operation"],
        });
      }
      if (attempt < maxRetries) {
        console.warn(`[bp-ext] page-act sendMessage attempt ${attempt + 1} failed, retrying in ${delays[attempt]}ms`);
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      return blocked(action, `Content script error: ${msg}`, {
        errorCode: "CONTENT_SCRIPT_ERROR",
        recoverable: true,
      });
    }
  }
  // Should not reach here
  return blocked(action, "Failed after all retries", {
    errorCode: "CONTENT_SCRIPT_ERROR",
    recoverable: true,
  });
}

// ── Resolve target/anchor to params for sendActMessage ──

function resolveTargetParams(
  tabId: number,
  target: Target | undefined,
  anchor: string | undefined,
): Record<string, unknown> | string {
  if (anchor) {
    const entry = getAnchor(tabId, anchor);
    if (!entry) return "STALE";
    const params: Record<string, unknown> = { selector: entry.selector };
    // Forward shadow path so the content script can resolve shadow-DOM targets.
    if (entry.shadowPath && entry.shadowPath.length > 0) {
      params.shadowPath = entry.shadowPath;
    }
    return params;
  }
  if (target) {
    return { target };
  }
  return "NONE";
}

// ── Action implementations ──

async function click(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("click", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("click", "No target or anchor provided");
  }

  return await dispatchClickViaCdp(resolved as Record<string, unknown>, tabId, { clickCount: 1 });
}

async function fill(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const value = params.value as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("fill", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("fill", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.value = value;
  return await dispatchFillViaCdp(actParams, tabId, value);
}

async function check(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const checked = params.checked as boolean | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("check", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("check", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  if (checked !== undefined) actParams.checked = checked;
  return sendActMessage(tabId, "check", actParams);
}

async function selectOption(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("select_option", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("select_option", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.value = params.value;
  actParams.label = params.label;
  return sendActMessage(tabId, "select_option", actParams);
}

async function press(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("press", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("press", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.key = params.key;
  actParams.keys = params.keys;
  return sendActMessage(tabId, "press", actParams);
}

async function scrollAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const direction = (params.direction as string) || "down";
  const amount = params.amount as number | undefined;
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const needsTarget = direction === "to_element";

  if (needsTarget) {
    const resolved = resolveTargetParams(tabId, target, anchor);
    if (resolved === "STALE") {
      return blocked("scroll", `Anchor ${anchor} is no longer valid`, {
        errorCode: "ANCHOR_STALE",
        recoverable: true,
        suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
      });
    }
    if (resolved === "NONE") {
      return notPerformed("scroll", "No target or anchor provided for to_element scroll");
    }
    const actParams = resolved as Record<string, unknown>;
    actParams.direction = direction;
    actParams.amount = amount;
    return sendActMessage(tabId, "scroll", actParams);
  }

  return sendActMessage(tabId, "scroll", { direction, amount });
}

async function submit(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("submit", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("submit", "No target or anchor provided");
  }

  return sendActMessage(tabId, "submit", resolved as Record<string, unknown>);
}

async function waitFor(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const timeout = (params.timeout_ms as number) ?? 10000;
  const condition = (params.condition as WaitCondition) ?? "exists";
  const pollingInterval = (params.poll_interval_ms as number) ?? 100;

  // URL condition: handle in service worker
  if (condition === "url") {
    const urlPattern = (params.pattern as string) ?? (params.url as string);
    if (!urlPattern) return notPerformed("wait_for", "URL condition requires 'pattern' or 'url' parameter");
    return waitForUrl(tabId, urlPattern, timeout, pollingInterval);
  }

  // load_state condition: handle in service worker
  if (condition === "load_state") {
    const targetState = (params.state as string) ?? "load";
    return waitForLoadState(tabId, targetState, timeout, pollingInterval);
  }

  // No condition: just wait
  if (!condition || condition === "none") {
    await new Promise((r) => setTimeout(r, timeout));
    return performed("wait_for", `Waited ${timeout}ms`, {
      data: { elapsed_ms: timeout },
    });
  }

  // network_idle, function: send to content script
  if (condition === "network_idle") {
    const idleMs = (params.idle_ms as number) ?? 500;
    return sendActMessage(tabId, "wait_for", { condition: "network_idle", idle_ms: idleMs, timeout_ms: timeout });
  }

  if (condition === "function") {
    const expression = params.expression as string;
    if (!expression) return notPerformed("wait_for", "Function condition requires 'expression' parameter");
    return sendActMessage(tabId, "wait_for", { condition: "function", expression, timeout_ms: timeout, poll_interval_ms: pollingInterval });
  }

  // Element conditions (exists, visible, hidden, enabled, disabled, stable)
  const resolved = resolveTargetParams(tabId, target, anchor);

  if (resolved === "STALE") {
    return blocked("wait_for", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }

  if (resolved !== "NONE") {
    const actParams = resolved as Record<string, unknown>;
    actParams.condition = condition;
    actParams.timeout_ms = timeout;
    actParams.poll_interval_ms = pollingInterval;
    return sendActMessage(tabId, "wait_for", actParams);
  }

  // No selector or target: just wait
  await new Promise((r) => setTimeout(r, timeout));
  return performed("wait_for", `Waited ${timeout}ms without condition`, {
    data: { elapsed_ms: timeout },
  });
}

async function waitForUrl(
  tabId: number,
  pattern: string,
  timeout: number,
  interval: number,
): Promise<ActionResult> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.includes(pattern)) {
      return performed("wait_for", `URL matched '${pattern}' after ${Date.now() - start}ms`, {
        data: { url: tab.url, elapsed_ms: Date.now() - start, matched: true },
      });
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const tab = await chrome.tabs.get(tabId);
  return performed("wait_for", `URL did not match '${pattern}' after ${timeout}ms`, {
    data: { url: tab.url, elapsed_ms: timeout, matched: false },
  });
}

async function waitForLoadState(
  tabId: number,
  state: string,
  timeout: number,
  interval: number,
): Promise<ActionResult> {
  const map: Record<string, string> = {
    interactive: "complete",
    dominteractive: "complete",
    complete: "complete",
    domcomplete: "complete",
    load: "complete",
    domloaded: "complete",
  };
  const expected = map[state] ?? state;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === expected || tab.status === "complete") {
      return performed("wait_for", `Load state '${state}' reached after ${Date.now() - start}ms`, {
        data: { state: tab.status, elapsed_ms: Date.now() - start },
      });
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const tab = await chrome.tabs.get(tabId);
  return performed("wait_for", `Load state '${state}' timeout after ${timeout}ms (current: ${tab.status})`, {
    data: { state: tab.status, elapsed_ms: timeout, timed_out: true },
  });
}

async function typeAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;
  const text = params.text as string ?? (params.value as string);
  const delay = (params.delay as number) ?? 30;

  if (!text) return notPerformed("type", "No text provided (use 'text' parameter)");

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("type", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("type", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.text = text;
  actParams.delay = delay;
  return await dispatchTypeViaCdp(actParams, tabId, text, delay);
}

async function smartClick(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  // smart_click uses click under the hood — same CDP primary + fallback flow.
  return click({ ...params, action: "click" }, tabId, frameId);
}

// ── Upload action ──

async function uploadAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("upload", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("upload", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  actParams.file_data = params.file_data;
  actParams.file_name = params.file_name;
  actParams.file_type = params.file_type;
  return sendActMessage(tabId, "upload", actParams);
}

// ── Drag action ──

async function dragAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("drag", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("drag", "No target or anchor provided");
  }

  const actParams = resolved as Record<string, unknown>;
  if (params.x !== undefined) actParams.x = params.x;
  if (params.y !== undefined) actParams.y = params.y;
  return sendActMessage(tabId, "drag", actParams);
}

// ── Double-click action ──

async function dblclickAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("dblclick", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("dblclick", "No target or anchor provided");
  }

  return await dispatchClickViaCdp(resolved as Record<string, unknown>, tabId, { clickCount: 2, dblclick: true });
}

// ── Hover action ──

async function hoverAction(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const target = params.target as Target | undefined;
  const anchor = params.anchor as string | undefined;

  const resolved = resolveTargetParams(tabId, target, anchor);
  if (resolved === "STALE") {
    return blocked("hover", `Anchor ${anchor} is no longer valid`, {
      errorCode: "ANCHOR_STALE",
      recoverable: true,
      suggestions: ["Run page.read with action=inspect again", "Use a semantic target instead"],
    });
  }
  if (resolved === "NONE") {
    return notPerformed("hover", "No target or anchor provided");
  }

  return await dispatchHoverViaCdp(resolved as Record<string, unknown>, tabId);
}

// ── Dialog actions ──

async function dialogOverride(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  return sendActMessage(tabId, "dialog_override", {});
}

async function dialogRespond(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  return sendActMessage(tabId, "dialog_respond", {
    response: params.response as Record<string, unknown> | undefined,
  });
}

// ── fill_form: batch fill multiple form fields ──

async function fillForm(params: Record<string, unknown>, tabId: number, frameId?: number): Promise<ActionResult> {
  const fields = params.fields as Array<{ anchor?: string; target?: Target; value: string }> | undefined;
  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    return notPerformed("fill_form", "No fields provided (use 'fields' array)");
  }

  // Resolve anchors to selectors in service worker
  const resolved: Array<{ selector: string; value: string } | { error: string; value: string }> = fields.map((f) => {
    if (f.anchor) {
      const entry = getAnchor(tabId, f.anchor);
      if (entry) return { selector: entry.selector, value: f.value };
      return { error: `Anchor ${f.anchor} is stale`, value: f.value };
    }
    if (f.target?.css) return { selector: f.target.css, value: f.value };
    if (f.target?.text || f.target?.role || f.target?.name) {
      return { error: "fill_form only supports anchor or css target per field", value: f.value };
    }
    return { error: "No anchor or css target for field", value: f.value };
  });

  const errored = resolved.filter((r) => (r as { error?: string }).error);
  if (errored.length > 0) {
    return notPerformed("fill_form", `${errored.length} field(s) had resolution errors`, {
      evidence: { errors: errored.map((r) => (r as { error: string }).error) },
    });
  }

  const selectorsAndValues = resolved.map((r) => ({
    selector: (r as { selector: string; value: string }).selector,
    value: (r as { selector: string; value: string }).value,
  }));

  return sendActMessage(tabId, "fill_form", { fields: selectorsAndValues });
}

// ── CDP dispatch helpers (resolve → CDP → fallback) ──

/**
 * Send `bp:resolve` to the CS, parse the coords + elementInfo response.
 * Returns the raw envelope from the CS, or null if the CS could not
 * resolve the target. Errors are returned as ActionResult-shaped objects
 * via the helper's caller.
 */
async function sendResolve(
  tabId: number,
  action: "click" | "dblclick" | "hover" | "type" | "fill",
  params: Record<string, unknown>,
): Promise<{ ok: true; coords?: { x: number; y: number }; jsExpression?: string; text?: string; delay?: number; value?: string; elementInfo?: Record<string, unknown>; resolveVerdict?: ExecutionVerdict } | { ok: false; result: ActionResult }> {
  const response = await sendMessageRaw(tabId, "bp:resolve", { ...params, action });
  if (!response) {
    return { ok: false, result: blocked(action, "No response from content script", { errorCode: "CONTENT_SCRIPT_NOT_READY", recoverable: true }) };
  }
  if (response.success === false) {
    // Re-emit as a not_performed / blocked / ambiguous, preserving CS verdict + message.
    const { executionVerdict, runtimeStatus } = extractVerdicts(response);
    if (response.errorCode === "AMBIGUOUS_TARGET") {
      return { ok: false, result: ambiguous(action, response.message as string, { errorCode: "AMBIGUOUS_TARGET", evidence: { matchedCount: response.matchCount }, executionVerdict, runtimeStatus }) };
    }
    if (response.blocked) {
      return { ok: false, result: blocked(action, response.message as string, { errorCode: response.errorCode as string, recoverable: true, evidence: response.evidence as Record<string, unknown>, executionVerdict, runtimeStatus }) };
    }
    return { ok: false, result: notPerformed(action, (response.message as string) || `${action} resolve failed`, { errorCode: response.errorCode as string, executionVerdict, runtimeStatus }) };
  }
  return {
    ok: true,
    coords: response.coords as { x: number; y: number } | undefined,
    jsExpression: response.jsExpression as string | undefined,
    text: response.text as string | undefined,
    delay: response.delay as number | undefined,
    value: response.value as string | undefined,
    elementInfo: response.elementInfo as Record<string, unknown> | undefined,
    resolveVerdict: response.executionVerdict as ExecutionVerdict | undefined,
  };
}

/**
 * Send a generic `bp:fallback-*` message and return the resulting
 * ActionResult. The CS re-resolves the target and dispatches the
 * synthetic event. The verdict reported by the CS rides through.
 */
async function sendFallback(
  tabId: number,
  action: "click" | "dblclick" | "hover" | "type" | "fill",
  type: "bp:fallback-click" | "bp:fallback-dblclick" | "bp:fallback-hover" | "bp:fallback-type" | "bp:fallback-fill",
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const response = await sendMessageRaw(tabId, type, params);
  if (!response) {
    return blocked(action, "No response from content script (fallback)", { errorCode: "CONTENT_SCRIPT_NOT_READY", recoverable: true });
  }
  const { executionVerdict, runtimeStatus } = extractVerdicts(response);
  if (response.success === false) {
    if (response.errorCode === "AMBIGUOUS_TARGET") {
      return ambiguous(action, response.message as string, { errorCode: "AMBIGUOUS_TARGET", evidence: { matchedCount: response.matchCount }, executionVerdict, runtimeStatus });
    }
    if (response.blocked) {
      return blocked(action, response.message as string, { errorCode: response.errorCode as string, recoverable: true, evidence: response.evidence as Record<string, unknown>, executionVerdict, runtimeStatus });
    }
    return notPerformed(action, (response.message as string) || `${action} fallback failed`, { errorCode: response.errorCode as string, executionVerdict, runtimeStatus });
  }
  return performed(action, (response.message as string) || `${action} (CDP fallback — synthetic event)`, {
    evidence: response.evidence as Record<string, unknown>,
    data: { ...(response.data as Record<string, unknown> | undefined), _fallback: "isolated", _cdpAttachError: params._cdpAttachError as string | undefined },
    executionVerdict,
    runtimeStatus,
  });
}

/**
 * Same as sendActMessage but returns the raw response (Record<string, unknown>)
 * instead of mapping to an ActionResult — used by the CDP dispatch helpers
 * that need the coords / jsExpression / text fields.
 */
async function sendMessageRaw(
  tabId: number,
  type: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const maxRetries = 3;
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        source: "browserpowers",
        type,
        params,
      } as any) as Record<string, unknown>;
      return response ?? null;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (msg.includes("receiving end does not exist") || msg.includes("Could not establish connection")) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          continue;
        }
        return null;
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Click / dblclick via CDP.
 *
 * 1. Send `bp:resolve` to the CS — get coords + elementInfo.
 * 2. Lazy-attach CDP. If attach fails, jump to the fallback path.
 * 3. Send `Input.dispatchMouseEvent` mousePressed + mouseReleased at
 *    the resolved coords. For dblclick, do it twice with clickCount: 2.
 * 4. If either CDP call fails, fall back to the synthetic event.
 *
 * The verdict's world/path reflect which path was actually used:
 *   - "cdp", "cdp.input.dispatchMouseEvent" — CDP path succeeded.
 *   - "isolated", "isolated.fallbackClick" / "isolated.fallbackDblclick"
 *     — synthetic event fallback was used (with `_fallback: "isolated"`
 *     in data so the wire signal is also explicit).
 */
async function dispatchClickViaCdp(
  resolveParams: Record<string, unknown>,
  tabId: number,
  opts: { clickCount: number; dblclick?: boolean },
): Promise<ActionResult> {
  const action: "click" | "dblclick" = opts.dblclick ? "dblclick" : "click";
  const resolve = await sendResolve(tabId, action, resolveParams);
  if (!resolve.ok) return resolve.result;

  const coords = resolve.coords;
  if (!coords) {
    return blocked(action, "Resolve did not return coords", {
      errorCode: "RESOLVE_NO_COORDS",
      recoverable: true,
      executionVerdict: resolve.resolveVerdict,
    });
  }

  // Lazy-attach. ensureAttached is idempotent and safe to call early.
  const attach = await ensureAttached(tabId, `input.${action}`);
  if (!attach.attached) {
    const fallback = await sendFallback(tabId, action, opts.dblclick ? "bp:fallback-dblclick" : "bp:fallback-click", resolveParams);
    if (fallback.success) {
      return { ...fallback, data: { ...(fallback.data || {}), _cdpAttachError: attach.error } };
    }
    return fallback;
  }

  // Send mousePressed + mouseReleased (twice for dblclick) at coords.
  // Playwright's dblclick protocol: first press/release pair uses clickCount: 1
  // (so the browser records a normal click), second pair uses clickCount: 2
  // (so the browser synthesizes a `dblclick` DOM event with detail: 2).
  const firstClickCount = 1;
  const secondClickCount = opts.dblclick ? 2 : 1;
  const down = await dispatchMouseEvent(tabId, "mousePressed", coords.x, coords.y, {
    button: "left",
    clickCount: firstClickCount,
  });
  if (!down.ok) {
    return await sendFallback(tabId, action, opts.dblclick ? "bp:fallback-dblclick" : "bp:fallback-click", { ...resolveParams, _cdpAttachError: down.error });
  }
  const up = await dispatchMouseEvent(tabId, "mouseReleased", coords.x, coords.y, {
    button: "left",
    clickCount: firstClickCount,
  });
  if (!up.ok) {
    return await sendFallback(tabId, action, opts.dblclick ? "bp:fallback-dblclick" : "bp:fallback-click", { ...resolveParams, _cdpAttachError: up.error });
  }
  if (opts.dblclick) {
    // Playwright dblclick: a second press/release pair right after, same coords.
    // Use clickCount: 2 on both — the browser synthesizes the dblclick event
    // when the second press arrives with clickCount: 2.
    const down2 = await dispatchMouseEvent(tabId, "mousePressed", coords.x, coords.y, {
      button: "left",
      clickCount: secondClickCount,
    });
    if (!down2.ok) {
      return await sendFallback(tabId, action, "bp:fallback-dblclick", { ...resolveParams, _cdpAttachError: down2.error });
    }
    const up2 = await dispatchMouseEvent(tabId, "mouseReleased", coords.x, coords.y, {
      button: "left",
      clickCount: secondClickCount,
    });
    if (!up2.ok) {
      return await sendFallback(tabId, action, "bp:fallback-dblclick", { ...resolveParams, _cdpAttachError: up2.error });
    }
    // Sum all CDP dispatch durations — dblclick includes the second
    // press/release pair; click is just the first pair.
    const totalDurationMs = (down.durationMs || 0) + (up.durationMs || 0) + (down2.durationMs || 0) + (up2.durationMs || 0);
    return performed(action, `Double-clicked at (${Math.round(coords.x)}, ${Math.round(coords.y)}) via CDP`, {
      evidence: { coords, elementInfo: resolve.elementInfo },
      data: { coords, elementInfo: resolve.elementInfo },
      executionVerdict: {
        executed: true,
        world: "cdp",
        durationMs: totalDurationMs,
        path: "cdp.input.dispatchMouseEvent",
      },
    });
  }

  // Click path: just the first press/release pair.
  const totalDurationMs = (down.durationMs || 0) + (up.durationMs || 0);
  const verdict: ExecutionVerdict = {
    executed: true,
    world: "cdp",
    durationMs: totalDurationMs,
    path: "cdp.input.dispatchMouseEvent",
  };
  return performed(action, `Clicked at (${Math.round(coords.x)}, ${Math.round(coords.y)}) via CDP`, {
    evidence: { coords, elementInfo: resolve.elementInfo },
    data: { coords, elementInfo: resolve.elementInfo },
    executionVerdict: verdict,
  });
}

/**
 * Hover via CDP — single `Input.dispatchMouseEvent` with type "mouseMoved".
 * Falls back to `bp:fallback-hover` on failure.
 */
async function dispatchHoverViaCdp(
  resolveParams: Record<string, unknown>,
  tabId: number,
): Promise<ActionResult> {
  const resolve = await sendResolve(tabId, "hover", resolveParams);
  if (!resolve.ok) return resolve.result;

  const coords = resolve.coords;
  if (!coords) {
    return blocked("hover", "Resolve did not return coords", {
      errorCode: "RESOLVE_NO_COORDS",
      recoverable: true,
      executionVerdict: resolve.resolveVerdict,
    });
  }

  const attach = await ensureAttached(tabId, "input.hover");
  if (!attach.attached) {
    const fallback = await sendFallback(tabId, "hover", "bp:fallback-hover", resolveParams);
    if (fallback.success) {
      return { ...fallback, data: { ...(fallback.data || {}), _cdpAttachError: attach.error } };
    }
    return fallback;
  }

  const moved = await dispatchMouseEvent(tabId, "mouseMoved", coords.x, coords.y);
  if (!moved.ok) {
    return await sendFallback(tabId, "hover", "bp:fallback-hover", { ...resolveParams, _cdpAttachError: moved.error });
  }

  return performed("hover", `Hovered at (${Math.round(coords.x)}, ${Math.round(coords.y)}) via CDP`, {
    evidence: { coords, elementInfo: resolve.elementInfo },
    data: { coords, elementInfo: resolve.elementInfo },
    executionVerdict: {
      executed: true,
      world: "cdp",
      durationMs: moved.durationMs || 0,
      path: "cdp.input.dispatchMouseEvent",
    },
  });
}

/**
 * Type via CDP — `focusElement(jsExpression)` + `Input.insertText(text)`
 * with a single call (not per-character). Falls back to `bp:fallback-type`.
 */
async function dispatchTypeViaCdp(
  resolveParams: Record<string, unknown>,
  tabId: number,
  text: string,
  delay: number,
): Promise<ActionResult> {
  const resolve = await sendResolve(tabId, "type", resolveParams);
  if (!resolve.ok) return resolve.result;

  const jsExpression = resolve.jsExpression;
  if (!jsExpression) {
    return blocked("type", "Resolve did not return jsExpression", {
      errorCode: "RESOLVE_NO_EXPRESSION",
      recoverable: true,
      executionVerdict: resolve.resolveVerdict,
    });
  }

  const attach = await ensureAttached(tabId, "input.type");
  if (!attach.attached) {
    const fallback = await sendFallback(tabId, "type", "bp:fallback-type", resolveParams);
    if (fallback.success) {
      return { ...fallback, data: { ...(fallback.data || {}), _cdpAttachError: attach.error } };
    }
    return fallback;
  }

  // Focus first, then insertText. If focus failed (closed shadow root, element
  // not in main world, etc.) bail to the content-script fallback rather than
  // typing into whatever element was already focused — that would silently
  // misroute text. The CS's `bp:fallback-type` handles focus + per-character
  // typing in the isolated world.
  const focus = await focusElement(tabId, jsExpression);
  if (!focus.ok) {
    return await sendFallback(tabId, "type", "bp:fallback-type", { ...resolveParams, _cdpFocusError: focus.error });
  }
  const inserted = await insertText(tabId, text);
  if (!inserted.ok) {
    return await sendFallback(tabId, "type", "bp:fallback-type", { ...resolveParams, _cdpAttachError: inserted.error });
  }

  const totalDurationMs = (focus.durationMs || 0) + (inserted.durationMs || 0);
  return performed("type", `Typed ${text.length} character(s) via CDP`, {
    evidence: { charCount: text.length, delay, elementInfo: resolve.elementInfo },
    data: { text, delay, elementInfo: resolve.elementInfo },
    executionVerdict: {
      executed: true,
      world: "cdp",
      durationMs: totalDurationMs,
      path: "cdp.input.insertText",
    },
  });
}

/**
 * Fill via CDP — `setElementValue(jsExpression, value)` runs a
 * Runtime.evaluate in the main world that assigns .value (bypassing
 * React's controlled-input protection) and dispatches input + change.
 * Falls back to `bp:fallback-fill`.
 */
async function dispatchFillViaCdp(
  resolveParams: Record<string, unknown>,
  tabId: number,
  value: string | undefined,
): Promise<ActionResult> {
  const resolve = await sendResolve(tabId, "fill", resolveParams);
  if (!resolve.ok) return resolve.result;

  const jsExpression = resolve.jsExpression;
  if (!jsExpression) {
    return blocked("fill", "Resolve did not return jsExpression", {
      errorCode: "RESOLVE_NO_EXPRESSION",
      recoverable: true,
      executionVerdict: resolve.resolveVerdict,
    });
  }
  if (value === undefined) {
    return notPerformed("fill", "No value provided");
  }

  const attach = await ensureAttached(tabId, "input.fill");
  if (!attach.attached) {
    const fallback = await sendFallback(tabId, "fill", "bp:fallback-fill", resolveParams);
    if (fallback.success) {
      return { ...fallback, data: { ...(fallback.data || {}), _cdpAttachError: attach.error } };
    }
    return fallback;
  }

  const set = await setElementValue(tabId, jsExpression, value);
  if (!set.ok) {
    return await sendFallback(tabId, "fill", "bp:fallback-fill", { ...resolveParams, _cdpAttachError: set.error });
  }

  return performed("fill", `Filled via CDP`, {
    evidence: { tag: (resolve.elementInfo as { tag?: string } | undefined)?.tag, valueMatched: set.value === value },
    data: { value, elementInfo: resolve.elementInfo, _cdpValue: set.value },
    executionVerdict: {
      // setElementValue uses CDP Runtime.evaluate in the main world, so the
      // world is "main" (not "cdp") — the page-vars-accessible path that
      // bypasses page CSP via the debugger.
      executed: true,
      world: "main",
      value: set.value,
      valueMatched: set.value === value,
      durationMs: set.durationMs || 0,
      path: "cdp.runtime.evaluate",
    },
  });
}
