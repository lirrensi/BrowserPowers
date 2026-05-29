/**
 * FILE: extension/entrypoints/content.ts
 * PURPOSE: Persistent content script entrypoint — handles all DOM interaction messages from
 *          the service worker by dispatching to real TypeScript functions in content-actions.ts.
 * OWNS: Message dispatch hub for bp:read, bp:act, bp:js messages in the page context.
 * EXPORTS: WXT content script via defineContentScript (global)
 * DOCS: .agents/reports/plan_content-script-arch_2026-05-28.md
 */

import {
  // Target resolution & inspection
  resolveTarget,
  inspectElements,
  listFrames,
  // Act actions
  clickElement,
  fillElement,
  checkElement,
  selectOption,
  pressKeys,
  scrollElement,
  submitForm,
  typeText,
  uploadFile,
  dragElement,
  dblclickElement,
  hoverElement,
  // Dialog
  dialogOverride,
  dialogRespond,
  // Wait conditions
  waitForElement,
  waitForTarget,
  waitForNetworkIdle,
  waitForFunction,
  // Batch
  fillFormFields,
  // Read
  readContent,
  readTexts,
  readHtml,
  readAttr,
  readMeta,
  readForms,
  countElements,
  selectText,
  readSummary,
  generateSelector,
} from "../src/v2/content-actions";
import type { Target, ActResult } from "../src/v2/content-actions";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    chrome.runtime.onMessage.addListener(
      (
        message: { source: string; type: string; action?: string; params?: Record<string, unknown> },
        _sender,
        sendResponse,
      ) => {
        if (message.source !== "browserpowers") return false;

        handleMessage(message).then(sendResponse).catch((err) => {
          sendResponse({ success: false, message: `Content script error: ${(err as Error).message}`, errorCode: "CONTENT_SCRIPT_ERROR" });
        });
        return true; // keep channel open for async
      },
    );
  },
});

// ── DOM Readiness Guard ──

function ensureReady(): Promise<void> {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
}

// ── Message Handler ──

async function handleMessage(
  message: { source: string; type: string; action?: string; params?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  try {
    switch (message.type) {
      case "bp:read":
        return handleRead(message.action || "", message.params || {});
      case "bp:act":
        return handleAct(message.action || "", message.params || {});
      case "bp:js":
        return handleJs(message.params || {});
      default:
        return { success: false, message: `Unknown message type: ${message.type}`, errorCode: "UNKNOWN_TYPE" };
    }
  } catch (err) {
    return { success: false, message: `Handler error: ${(err as Error).message}`, errorCode: "HANDLER_ERROR" };
  }
}

// ── Read Handler ──

async function handleRead(
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureReady();

  switch (action) {
    case "inspect": {
      const limit = (params.limit as number) ?? 50;
      const includeHidden = (params.include_hidden as boolean) ?? false;
      const compact = (params.compact as boolean) ?? false;
      return inspectElements(limit, includeHidden, compact) as unknown as Record<string, unknown>;
    }
    case "content":
      return { content: readContent((params.target as Target) ?? null) };
    case "text": {
      const target = params.target as Target | undefined;
      const selector = target?.css || "body *";
      const limit = (params.limit as number) ?? 50;
      return { texts: readTexts(selector, limit) };
    }
    case "html": {
      const target = params.target as Target | undefined;
      const limit = (params.limit as number) ?? 10;
      if (!target?.css) return { success: false, message: "CSS selector required for html action" };
      return { html: readHtml(target.css, limit) };
    }
    case "attr": {
      const target = params.target as Target | undefined;
      const name = (params.name as string) || (params.selector as string);
      if (!target?.css || !name) return { success: false, message: "CSS selector and attribute name required" };
      return { name, value: readAttr(target.css, name) };
    }
    case "meta":
      return readMeta();
    case "forms": {
      const limit = (params.limit as number) ?? 20;
      return { forms: readForms(limit) };
    }
    case "count": {
      const target = params.target as Target | undefined;
      if (!target?.css) return { success: false, message: "CSS selector required" };
      return { count: countElements(target.css) };
    }
    case "select":
      return { selectedText: selectText() };
    case "summary":
      return readSummary();
    case "frames":
      return { frames: listFrames() };
    case "generate_selector": {
      const target = params.target as Target | undefined;
      const css = target?.css as string | undefined;
      if (!css) return { success: false, message: "CSS selector required (use target.css)" };
      return generateSelector(css);
    }
    default:
      return { success: false, message: `Unknown read action: ${action}`, errorCode: "UNKNOWN_ACTION" };
  }
}

// ── Act Handler ──

async function handleAct(
  action: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureReady();

  // Resolve element from anchor/selector or target
  const resolveEl = (): Element | null => {
    // Fast path: explicit selector from anchor
    const sel = params.selector as string | undefined;
    if (sel) {
      return document.querySelector(sel);
    }
    // Target path: resolve via structured target
    const target = params.target as Target | undefined;
    if (target) {
      const resolution = resolveTarget(target);
      if (resolution.found && resolution.element) {
        return resolution.element;
      }
      return null;
    }
    return null;
  };

  switch (action) {
    case "click": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return clickElement(el);
    }
    case "fill": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      const value = params.value as string;
      if (value === undefined) return { success: false, message: "No value provided" };
      return fillElement(el, value);
    }
    case "check": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return checkElement(el, params.checked as boolean | undefined);
    }
    case "select_option": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return selectOption(el, params.value as string | undefined, params.label as string | undefined);
    }
    case "press": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return pressKeys(el, params.key as string, params.keys as string[] | undefined);
    }
    case "scroll": {
      const direction = (params.direction as string) || "down";
      const amount = params.amount as number | undefined;
      if (direction === "to_element") {
        const el = resolveEl();
        return scrollElement(el, direction, amount);
      }
      return scrollElement(null, direction, amount);
    }
    case "submit": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return submitForm(el);
    }
    case "type": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      const text = (params.text as string) ?? (params.value as string);
      const delay = (params.delay as number) ?? 30;
      if (!text) return { success: false, message: "No text provided (use 'text' parameter)" };
      return typeText(el, text, delay);
    }
    case "smart_click": {
      const target = params.target as Target | undefined;
      if (!target) return { success: false, message: "Smart click requires a target" };
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return clickElement(el);
    }
    case "fill_form": {
      const fields = params.fields as Array<{ selector: string; value: string }> | undefined;
      if (!fields || fields.length === 0) {
        return { success: false, message: "No fields provided" };
      }
      return fillFormFields(fields);
    }
    case "upload": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return uploadFile(
        el,
        params.file_data as string,
        params.file_name as string | undefined,
        params.file_type as string | undefined,
      );
    }
    case "drag": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return dragElement(el, params.x as number | undefined, params.y as number | undefined);
    }
    case "dblclick": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return dblclickElement(el);
    }
    case "hover": {
      const el = resolveEl();
      if (!el) return { success: false, message: "No matching element found", errorCode: "TARGET_NOT_FOUND" };
      return hoverElement(el);
    }
    case "dialog_override":
      return dialogOverride();
    case "dialog_respond":
      return dialogRespond(params.response as Record<string, unknown> | undefined);

    // ── wait_for ──
    case "wait_for": {
      const condition = (params.condition as string) || "exists";
      const timeout = (params.timeout_ms as number) ?? 10000;
      const pollInterval = (params.poll_interval_ms as number) ?? 100;

      // network_idle
      if (condition === "network_idle") {
        const idleMs = (params.idle_ms as number) ?? 500;
        return waitForNetworkIdle(idleMs, timeout);
      }

      // function
      if (condition === "function") {
        const expression = params.expression as string;
        if (!expression) return { success: false, message: "Function condition requires 'expression'" };
        return waitForFunction(expression, timeout, pollInterval);
      }

      // Element conditions
      const sel = params.selector as string | undefined;
      const target = params.target as Target | undefined;

      if (sel) {
        return waitForElement(sel, condition, timeout, pollInterval);
      }
      if (target) {
        return waitForTarget(target, condition, timeout, pollInterval);
      }
      // No selector or target — just wait
      await new Promise((r) => setTimeout(r, timeout));
      return { success: true, message: `Waited ${timeout}ms`, evidence: { elapsed_ms: timeout } };
    }

    default:
      return { success: false, message: `Unknown act action: ${action}`, errorCode: "UNKNOWN_ACTION" };
  }
}

// ── JS Handler ──

async function handleJs(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureReady();
  const code = params.code as string | undefined;
  if (!code) {
    return { success: false, message: "No code provided", errorCode: "MISSING_PARAM" };
  }
  try {
    const result = new Function(code)();
    // Try to serialize — if it fails, return type info
    let serialized: unknown;
    try {
      serialized = JSON.parse(JSON.stringify(result));
    } catch {
      serialized = {
        _nonSerializable: true,
        type: typeof result,
        hint: result === null ? "null" : result?.constructor?.name || typeof result,
      };
    }
    return { success: true, data: { result: serialized } };
  } catch (err) {
    return { success: false, message: `JavaScript execution failed: ${(err as Error).message}`, errorCode: "JS_EXECUTION_ERROR" };
  }
}
