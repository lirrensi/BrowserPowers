/**
 * FILE: extension/src/cdp.ts
 * PURPOSE: Single owner of the chrome.debugger (CDP) layer in BrowserPowers.
 *          Provides lazy attach, detach, runtimeEvaluate, Input.* wrappers
 *          (dispatchMouseEvent, insertText), Runtime.evaluate-based
 *          focusElement / setElementValue helpers, and a per-tab console buffer
 *          fed by `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` /
 *          `Log.entryAdded` events. Service-worker-only module — the content
 *          script does not have access to `chrome.debugger`.
 *
 *          Three execution worlds in BrowserPowers:
 *            - isolated (content script) — DOM access, no page vars, no page CSP
 *            - cdp (this module) — page vars, no page CSP, requires debugger perm
 *            - main (chrome.scripting.executeScript { world: "MAIN" }) — page
 *              vars, page CSP applies (currently unused; the previous
 *              MAIN-world console-capture consumer has been retired in
 *              favour of CDP)
 *
 *          The Input.* domain is used by the SW-side page-act for click /
 *          dblclick / hover / type / fill / press. CDP input injection goes
 *          through the browser's input pipeline and bypasses page-level
 *          synthetic event handlers — same approach Playwright uses. See
 *          .agents/reports/plan_cdp-input-parity_2026-06-23.md and
 *          .agents/reports/plan_visual-help-csp-tighten_2026-06-23.md.
 *
 * OWNS: chrome.debugger attach lifecycle, per-tab console ring buffer, per-tab
 *       command serialization queue, runtimeEvaluate wrapper, Input.*
 *       wrappers, focusElement / setElementValue helpers, public state
 *       surface for page.read action=runtime_status.
 * EXPORTS: ensureAttached, detach, getState, runtimeEvaluate, getConsoleBuffer,
 *          dispatchMouseEvent, insertText, dispatchKeyEvent, focusElement, setElementValue,
 *          init (called once at SW startup to register listeners), CdpState,
 *          AttachResult, EvalResult, ConsoleEntry, DispatchMouseEventResult,
 *          InsertTextResult, DispatchKeyEventResult, FocusElementResult,
 *          SetElementValueResult.
 * DOCS:   .agents/reports/plan_cdp-max-authority_2026-06-22.md,
 *         .agents/reports/plan_cdp-input-parity_2026-06-23.md
 */

import { isExtensionContext } from "./safety.js";

// ── Public types ─────────────────────────────────────────────────────────

export interface AttachResult {
  attached: boolean;
  version?: string;
  /** Error message when attached === false (chrome.runtime.lastError). */
  error?: string;
  /** Friendly classification of the error — used by callers to decide fallback. */
  reason?:
    | "permission-denied"
    | "another-debugger-attached"
    | "tab-not-found"
    | "invalid-tab-id"
    | "internal-error"
    | "unknown";
}

export interface CdpState {
  attached: boolean;
  version?: string;
  attachedAt?: number;
  attachedFor?: string;
  consoleBufferSize: number;
  lastEntry?: ConsoleEntry;
}

export interface ConsoleEntry {
  level: string;
  messages: unknown[];
  timestamp: number;
  stack?: string;
}

/**
 * Shape of `Runtime.evaluate` result after mapping to our internal types.
 * `exceptionDetails` matches the CDP shape; `value` is the user-visible result
 * (RemoteObject.value when returnByValue is true).
 */
export interface EvalResult {
  value?: unknown;
  exceptionDetails?: {
    exception?: { description?: string; value?: unknown; className?: string };
    text: string;
    lineNumber: number;
    columnNumber: number;
  };
  durationMs: number;
  /** True if the evaluation completed without throwing. */
  ok: boolean;
}

// ── Module state ─────────────────────────────────────────────────────────

interface AttachedInfo {
  version: string;
  attachedAt: number;
  attachedFor: string;
}

const CDP_PROTOCOL_VERSION = "1.3";
const CONSOLE_BUFFER_MAX = 500;

const attached = new Map<number, AttachedInfo>();
const consoleBuffer = new Map<number, ConsoleEntry[]>();
const cmdQueues = new Map<number, Promise<unknown>>();

let listenersRegistered = false;

// ── Listeners (registered once) ──────────────────────────────────────────

/**
 * Initialize the CDP layer. Idempotent — safe to call multiple times.
 *
 * Registers:
 *   - chrome.debugger.onEvent — pushes consoleAPICalled, exceptionThrown,
 *     and Log.entryAdded events into the per-tab ring buffer.
 *   - chrome.debugger.onDetach — clears `attached` state but keeps the
 *     console buffer so post-detach reads still return history.
 *   - chrome.webNavigation.onCommitted — auto-detach on top-frame navigation.
 *   - chrome.tabs.onRemoved — clean up state for the closed tab.
 *
 * Caller (background.ts) should invoke this at SW startup. No attach happens
 * here — attach is lazy on first CDP-needing action.
 */
export function init(): void {
  if (listenersRegistered) return;
  if (!isExtensionContext()) return;

  // CDP events — buffered for page.read action=console.
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (typeof tabId !== "number") return;

    if (method === "Runtime.consoleAPICalled") {
      const p = params as RuntimeConsoleAPICalledParams | undefined;
      if (!p) return;
      const args = Array.isArray(p.args) ? p.args.map(remoteObjectToJson) : [];
      pushConsoleEntry(tabId, {
        level: p.type ?? "log",
        messages: args,
        timestamp: Date.now(),
        stack: p.stackTrace?.callFrames?.[0]
          ? `${p.stackTrace.callFrames[0].functionName ?? "<anonymous>"}@${p.stackTrace.callFrames[0].url ?? ""}:${p.stackTrace.callFrames[0].lineNumber ?? 0}`
          : undefined,
      });
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const p = params as RuntimeExceptionThrownParams | undefined;
      const ex = p?.exceptionDetails;
      if (!ex) return;
      const message = ex.exception?.description ?? ex.text ?? "Unhandled exception";
      pushConsoleEntry(tabId, {
        level: "error",
        messages: [message],
        timestamp: Date.now(),
        stack: ex.exception?.description ?? ex.text,
      });
      return;
    }

    if (method === "Log.entryAdded") {
      const p = params as LogEntryAddedParams | undefined;
      if (!p) return;
      const entry = p.entry;
      if (!entry) return;
      pushConsoleEntry(tabId, {
        level: entry.level ?? "log",
        messages: [entry.text ?? ""],
        timestamp: Date.now(),
        stack: entry.url ? `${entry.url}:${entry.lineNumber ?? 0}` : undefined,
      });
      return;
    }
  });

  // Detach — clear attach state, keep console buffer.
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (typeof tabId !== "number") return;
    attached.delete(tabId);
    // We deliberately do NOT clear consoleBuffer — history is useful after detach.
    console.warn(`[bp-cdp] Detached from tab ${tabId}: ${reason}`);
  });

  // Auto-detach on top-frame navigation (SPA in-tab navigation is fine — only
  // frameId === 0 is treated as a real navigation).
  if (chrome.webNavigation?.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (details.frameId !== 0) return;
      const tabId = details.tabId;
      if (attached.has(tabId)) {
        void detach(tabId).catch((err) => {
          console.warn(`[bp-cdp] Auto-detach on navigation failed: ${(err as Error).message}`);
        });
      }
    });
  }

  // Clean up when tab is closed.
  if (chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      attached.delete(tabId);
      consoleBuffer.delete(tabId);
      cmdQueues.delete(tabId);
    });
  }

  listenersRegistered = true;
}

// ── Minimal CDP param shapes (just the fields we read) ──────────────────

interface RuntimeConsoleAPICalledParams {
  type?: string;
  args?: Array<{ value?: unknown; description?: string; type?: string; unserializableValue?: unknown }>;
  stackTrace?: { callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number }> };
}

interface RuntimeExceptionThrownParams {
  exceptionDetails?: {
    exception?: { description?: string; value?: unknown; className?: string };
    text?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface LogEntryAddedParams {
  entry?: { level?: string; text?: string; url?: string; lineNumber?: number };
}

function remoteObjectToJson(obj: { value?: unknown; description?: string; type?: string; unserializableValue?: unknown }): unknown {
  if (obj && "value" in obj && obj.value !== undefined) return obj.value;
  if (obj && typeof obj.unserializableValue !== "undefined") return obj.unserializableValue;
  if (obj && typeof obj.description === "string") return obj.description;
  return undefined;
}

function pushConsoleEntry(tabId: number, entry: ConsoleEntry): void {
  let buf = consoleBuffer.get(tabId);
  if (!buf) {
    buf = [];
    consoleBuffer.set(tabId, buf);
  }
  buf.push(entry);
  if (buf.length > CONSOLE_BUFFER_MAX) {
    buf.splice(0, buf.length - CONSOLE_BUFFER_MAX);
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Ensure the CDP debugger is attached to the given tab. Idempotent — no-op
 * if already attached. Enables Runtime + Log domains after attach so the
 * event listeners pick up console activity.
 *
 * Returns `{ attached: true, version }` on success, or
 * `{ attached: false, error, reason }` on failure. Never throws.
 */
export async function ensureAttached(tabId: number, reason: string): Promise<AttachResult> {
  if (!isExtensionContext()) {
    return { attached: false, error: "not in extension context", reason: "internal-error" };
  }

  if (attached.has(tabId)) {
    return { attached: true, version: attached.get(tabId)!.version };
  }

  try {
    await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err) ?? "attach failed";
    return { attached: false, error: msg, reason: classifyAttachError(msg) };
  }

  attached.set(tabId, { version: CDP_PROTOCOL_VERSION, attachedAt: Date.now(), attachedFor: reason });

  // Enable domains we care about. Failure here is non-fatal — the attach
  // itself succeeded; we just won't get console events.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Log.enable");
    // Input.enable is a no-op for our use case but is conventional — keep
    // it so any future Input.* event listeners (touch, key) work.
    await chrome.debugger.sendCommand({ tabId }, "Input.enable");
  } catch (err) {
    console.warn(`[bp-cdp] Failed to enable Runtime/Log/Input domains on tab ${tabId}: ${(err as Error).message}`);
  }

  return { attached: true, version: CDP_PROTOCOL_VERSION };
}

/**
 * Detach from a tab. Idempotent — no-op if not attached. Never throws.
 */
export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    // Race: tab may have closed or DevTools grabbed it. Not fatal.
    console.warn(`[bp-cdp] detach(${tabId}) failed: ${(err as Error).message}`);
  } finally {
    attached.delete(tabId);
  }
}

/**
 * Inspect state for a tab. Cheap — no I/O, just reads module-level Maps.
 */
export function getState(tabId: number): CdpState {
  const info = attached.get(tabId);
  const buf = consoleBuffer.get(tabId);
  return {
    attached: !!info,
    version: info?.version,
    attachedAt: info?.attachedAt,
    attachedFor: info?.attachedFor,
    consoleBufferSize: buf?.length ?? 0,
    lastEntry: buf && buf.length > 0 ? buf[buf.length - 1] : undefined,
  };
}

/**
 * Run `Runtime.evaluate` on a tab. Lazy-attaches on first call. Commands are
 * serialized per tab to avoid interleaving. Never throws — returns a typed
 * EvalResult with `ok: false` and `exceptionDetails` on error.
 */
export async function runtimeEvaluate(
  tabId: number,
  expression: string,
  opts: { awaitPromise?: boolean; returnByValue?: boolean } = {},
): Promise<EvalResult> {
  const tail = cmdQueues.get(tabId) ?? Promise.resolve();
  const next = tail
    .catch(() => undefined) // don't break the chain on prior error
    .then(async () => {
      const attach = await ensureAttached(tabId, "page.js");
      if (!attach.attached) {
        return {
          ok: false,
          exceptionDetails: {
            text: attach.error ?? "CDP attach failed",
            lineNumber: 0,
            columnNumber: 0,
          },
          durationMs: 0,
        } satisfies EvalResult;
      }
      const start = performance.now();
      const rawResult = (await chrome.debugger.sendCommand(
        { tabId },
        "Runtime.evaluate",
        {
          expression,
          returnByValue: opts.returnByValue ?? true,
          awaitPromise: opts.awaitPromise ?? true,
        } as unknown as object,
      )) as RemoteEvaluateResult | undefined;
      const durationMs = performance.now() - start;
      return mapRemoteEvaluateResult(rawResult, durationMs);
    });

  // Store the new tail — but don't let an error here propagate the rejection
  // to subsequent waiters. We surface errors via the returned EvalResult, not
  // via a thrown promise.
  cmdQueues.set(tabId, next.catch(() => undefined));
  return next;
}

interface RemoteEvaluateResult {
  result?: { value?: unknown; type?: string; description?: string };
  exceptionDetails?: {
    exception?: { description?: string; value?: unknown; className?: string };
    text?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

function mapRemoteEvaluateResult(raw: RemoteEvaluateResult | undefined, durationMs: number): EvalResult {
  if (!raw) {
    return {
      ok: false,
      exceptionDetails: { text: "Empty CDP response", lineNumber: 0, columnNumber: 0 },
      durationMs,
    };
  }
  if (raw.exceptionDetails) {
    return {
      ok: false,
      exceptionDetails: {
        exception: raw.exceptionDetails.exception,
        text: raw.exceptionDetails.text ?? "Script error",
        lineNumber: raw.exceptionDetails.lineNumber ?? 0,
        columnNumber: raw.exceptionDetails.columnNumber ?? 0,
      },
      durationMs,
    };
  }
  return {
    ok: true,
    value: raw.result?.value,
    durationMs,
  };
}

// ── Input.* wrappers ─────────────────────────────────────────────────────

/** Mirrors the `Input.dispatchMouseEvent` `type` field. */
export type DispatchMouseEventType = "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";

/** Mirrors the `Input.dispatchMouseEvent` `button` field. */
export type MouseButton = "none" | "left" | "middle" | "right";

export interface DispatchMouseEventOptions {
  button?: MouseButton;
  clickCount?: number;
  /** Bit field — see CDP docs for modifier flags. 0 = none. */
  modifiers?: number;
  /** Only for type="mouseWheel" — deltaX/deltaY. */
  deltaX?: number;
  deltaY?: number;
}

export interface DispatchMouseEventResult {
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface InsertTextResult {
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface FocusElementResult {
  ok: boolean;
  error?: string;
  /** True when the element was found and `focus()` returned without throwing. */
  focused: boolean;
  durationMs: number;
}

export interface SetElementValueResult {
  ok: boolean;
  error?: string;
  /** The element's `.value` after the set (string). */
  value?: string;
  durationMs: number;
}

export interface DispatchKeyEventResult {
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface DispatchKeyEventOptions {
  /** Modifier bit field — see CDP docs. Default 0. */
  modifiers?: number;
}

/**
 * Wrap `Input.dispatchMouseEvent`. Lazy-attaches on first call, queues per-tab
 * so events land in order. Never throws — returns `{ ok: false, error }` on
 * failure (including attach denial).
 *
 * Use this for click / dblclick / hover: pass type "mousePressed" then
 * "mouseReleased" for a left-click, or "mouseMoved" for a hover. The browser
 * routes the synthesized event through the normal input pipeline so it hits
 * the element under viewport coords (x, y) — the same behaviour real user
 * input would produce.
 */
export async function dispatchMouseEvent(
  tabId: number,
  type: DispatchMouseEventType,
  x: number,
  y: number,
  opts: DispatchMouseEventOptions = {},
): Promise<DispatchMouseEventResult> {
  const tail = cmdQueues.get(tabId) ?? Promise.resolve();
  const next = tail
    .catch(() => undefined)
    .then(async () => {
      const attach = await ensureAttached(tabId, `input.${type}`);
      if (!attach.attached) {
        return {
          ok: false,
          error: attach.error ?? "CDP attach failed",
          durationMs: 0,
        } satisfies DispatchMouseEventResult;
      }
      const start = performance.now();
      const params: Record<string, unknown> = {
        type,
        x,
        y,
        button: opts.button ?? "none",
        clickCount: opts.clickCount ?? 0,
        modifiers: opts.modifiers ?? 0,
      };
      if (type === "mouseWheel") {
        if (opts.deltaX !== undefined) params.deltaX = opts.deltaX;
        if (opts.deltaY !== undefined) params.deltaY = opts.deltaY;
      }
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          "Input.dispatchMouseEvent",
          params as Record<string, unknown>,
        );
        return { ok: true, durationMs: performance.now() - start } satisfies DispatchMouseEventResult;
      } catch (err) {
        return {
          ok: false,
          error: (err as Error)?.message ?? String(err),
          durationMs: performance.now() - start,
        } satisfies DispatchMouseEventResult;
      }
    });
  cmdQueues.set(tabId, next.catch(() => undefined));
  return next;
}

/**
 * Wrap `Input.insertText`. Lazy-attaches, queues per-tab. The text is
 * delivered as if typed — element must already be focused (use `focusElement`
 * first). Use this for the `type` action: a single call covers the whole
 * text, no per-character synthesis needed.
 */
export async function insertText(tabId: number, text: string): Promise<InsertTextResult> {
  const tail = cmdQueues.get(tabId) ?? Promise.resolve();
  const next = tail
    .catch(() => undefined)
    .then(async () => {
      const attach = await ensureAttached(tabId, "input.insertText");
      if (!attach.attached) {
        return {
          ok: false,
          error: attach.error ?? "CDP attach failed",
          durationMs: 0,
        } satisfies InsertTextResult;
      }
      const start = performance.now();
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          "Input.insertText",
          { text } as Record<string, unknown>,
        );
        return { ok: true, durationMs: performance.now() - start } satisfies InsertTextResult;
      } catch (err) {
        return {
          ok: false,
          error: (err as Error)?.message ?? String(err),
          durationMs: performance.now() - start,
        } satisfies InsertTextResult;
      }
    });
  cmdQueues.set(tabId, next.catch(() => undefined));
  return next;
}

// ── Key → code mapping (Playwright parity) ──
// Covers the common named keys. For unknown keys the caller passes a single
// character or composite; we still send `key` and let the browser derive the
// rest. Never throws — unknown keys just get `key` only.

const KEY_CODE_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  // Whitespace / control
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  // Navigation
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  // Function keys
  F1: { key: "F1", code: "F1", windowsVirtualKeyCode: 112 },
  F2: { key: "F2", code: "F2", windowsVirtualKeyCode: 113 },
  F3: { key: "F3", code: "F3", windowsVirtualKeyCode: 114 },
  F4: { key: "F4", code: "F4", windowsVirtualKeyCode: 115 },
  F5: { key: "F5", code: "F5", windowsVirtualKeyCode: 116 },
  F6: { key: "F6", code: "F6", windowsVirtualKeyCode: 117 },
  F7: { key: "F7", code: "F7", windowsVirtualKeyCode: 118 },
  F8: { key: "F8", code: "F8", windowsVirtualKeyCode: 119 },
  F9: { key: "F9", code: "F9", windowsVirtualKeyCode: 120 },
  F10: { key: "F10", code: "F10", windowsVirtualKeyCode: 121 },
  F11: { key: "F11", code: "F11", windowsVirtualKeyCode: 122 },
  F12: { key: "F12", code: "F12", windowsVirtualKeyCode: 123 },
  // Modifier-only (rare but valid)
  Shift: { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  // Punctuation / named symbols
  CapsLock: { key: "CapsLock", code: "CapsLock", windowsVirtualKeyCode: 20 },
  ContextMenu: { key: "ContextMenu", code: "ContextMenu", windowsVirtualKeyCode: 93 },
  Pause: { key: "Pause", code: "Pause", windowsVirtualKeyCode: 19 },
  PrintScreen: { key: "PrintScreen", code: "PrintScreen", windowsVirtualKeyCode: 44 },
  ScrollLock: { key: "ScrollLock", code: "ScrollLock", windowsVirtualKeyCode: 145 },
};

/**
 * Map a user-supplied key name to the CDP key/code/virtualKeyCode triple.
 * For single-character keys, we use the literal as `key` and a `Key<letter>`
 * as `code`. For unknown keys, we return just `{ key }` — the browser will
 * derive the rest.
 */
function mapKeyForCdp(key: string): { key: string; code?: string; windowsVirtualKeyCode?: number } {
  if (KEY_CODE_MAP[key]) {
    const m = KEY_CODE_MAP[key];
    return { key: m.key, code: m.code, windowsVirtualKeyCode: m.windowsVirtualKeyCode };
  }
  // Single printable character — use the literal as `key`, derive `code` heuristically.
  if (key.length === 1) {
    const ch = key;
    if (/[a-zA-Z]/.test(ch)) {
      return { key: ch, code: "Key" + ch.toUpperCase() };
    }
    if (/[0-9]/.test(ch)) {
      return { key: ch, code: "Digit" + ch };
    }
    return { key: ch };
  }
  // Unknown composite — let the browser derive everything from `key`.
  return { key };
}

/**
 * Wrap `Input.dispatchKeyEvent`. Lazy-attaches, queues per-tab, never throws.
 * Dispatches a `keyDown` + `keyUp` pair for the given key with optional
 * modifier bit field. Use this for the `press` act action — same approach
 * Playwright uses for the Input.dispatchKeyEvent family.
 *
 * On attach failure, returns `{ ok: false, error }` so the caller can fall
 * back to the content-script synthetic KeyboardEvent path.
 */
export async function dispatchKeyEvent(
  tabId: number,
  key: string,
  opts: DispatchKeyEventOptions = {},
): Promise<DispatchKeyEventResult> {
  if (!key) {
    return { ok: false, error: "No key provided", durationMs: 0 };
  }
  const mapped = mapKeyForCdp(key);
  const modifiers = opts.modifiers ?? 0;

  const tail = cmdQueues.get(tabId) ?? Promise.resolve();
  const next = tail
    .catch(() => undefined)
    .then(async () => {
      const attach = await ensureAttached(tabId, "input.press");
      if (!attach.attached) {
        return {
          ok: false,
          error: attach.error ?? "CDP attach failed",
          durationMs: 0,
        } satisfies DispatchKeyEventResult;
      }
      const start = performance.now();
      const commonParams: Record<string, unknown> = {
        modifiers,
        ...(mapped.code !== undefined ? { code: mapped.code } : {}),
        ...(mapped.windowsVirtualKeyCode !== undefined ? { windowsVirtualKeyCode: mapped.windowsVirtualKeyCode } : {}),
      };
      try {
        // keyDown
        await chrome.debugger.sendCommand(
          { tabId },
          "Input.dispatchKeyEvent",
          { type: "keyDown", key: mapped.key, ...commonParams } as Record<string, unknown>,
        );
        // keyUp — same params except type
        await chrome.debugger.sendCommand(
          { tabId },
          "Input.dispatchKeyEvent",
          { type: "keyUp", key: mapped.key, ...commonParams } as Record<string, unknown>,
        );
        return { ok: true, durationMs: performance.now() - start } satisfies DispatchKeyEventResult;
      } catch (err) {
        return {
          ok: false,
          error: (err as Error)?.message ?? String(err),
          durationMs: performance.now() - start,
        } satisfies DispatchKeyEventResult;
      }
    });
  cmdQueues.set(tabId, next.catch(() => undefined));
  return next;
}

/**
 * Focus an element in the main world by evaluating a JS expression that
 * resolves to the element. The caller (content script) is responsible for
 * building the expression — typically a chain of `.shadowRoot.querySelector()`
 * calls plus the leaf selector. Example:
 *
 *   `document.querySelector('my-app').shadowRoot.querySelector('input')`
 *
 * Lazy-attaches, queues per-tab, never throws. On evaluation failure
 * (element not found, thrown error) returns `{ ok: false, error, focused: false }`.
 */
export async function focusElement(tabId: number, jsExpression: string): Promise<FocusElementResult> {
  const start = performance.now();
  // Wrap the expression so we get a uniform { ok, focused, error } shape
  // even if the expression throws (e.g. null deref when a shadow host is
  // missing).
  const code = `(() => { try { const el = ${jsExpression}; if (!el) return { ok: false, focused: false, error: 'element not found' }; if (typeof el.focus === 'function') { el.focus(); } return { ok: true, focused: true }; } catch (e) { return { ok: false, focused: false, error: String(e && e.message ? e.message : e) }; } })()`;
  const result = await runtimeEvaluate(tabId, code);
  const durationMs = performance.now() - start;
  if (!result.ok) {
    return {
      ok: false,
      error: result.exceptionDetails?.text ?? "evaluate failed",
      focused: false,
      durationMs,
    };
  }
  const value = result.value as { ok?: boolean; focused?: boolean; error?: string } | undefined;
  return {
    ok: value?.ok ?? false,
    focused: value?.focused ?? false,
    error: value?.error,
    durationMs,
  };
}

/**
 * Set the `.value` of an input/textarea/contenteditable element from the main
 * world. Bypasses React controlled-input protection by using the prototype's
 * native value setter, then dispatches `input` and `change` events so the
 * page's listeners fire.
 *
 * The caller (content script) is responsible for building a `jsExpression`
 * that resolves to the target element in the main world — the same
 * expression `focusElement` accepts.
 */
export async function setElementValue(
  tabId: number,
  jsExpression: string,
  value: string,
): Promise<SetElementValueResult> {
  const start = performance.now();
  const valueJson = JSON.stringify(value);
  // Pick the correct prototype setter based on tagName. The wrapped IIFE
  // returns a uniform shape; the expression is JSON-string-quoted so a
  // maliciously-crafted value can't inject JS.
  const code = `(() => { try { const el = ${jsExpression}; if (!el) return { ok: false, error: 'element not found' }; const tag = (el.tagName || '').toLowerCase(); let setter = null; if (tag === 'textarea') setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') && Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; else if (tag === 'input') setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') && Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const newVal = ${valueJson}; if (setter) { setter.call(el, newVal); } else if ('value' in el) { el.value = newVal; } else if (el.isContentEditable) { el.textContent = newVal; } try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} const out = (typeof el.value === 'string') ? el.value : (el.isContentEditable ? el.textContent : ''); return { ok: true, value: out }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; } })()`;
  const result = await runtimeEvaluate(tabId, code);
  const durationMs = performance.now() - start;
  if (!result.ok) {
    return {
      ok: false,
      error: result.exceptionDetails?.text ?? "evaluate failed",
      durationMs,
    };
  }
  const evalValue = result.value as { ok?: boolean; error?: string; value?: string } | undefined;
  return {
    ok: evalValue?.ok ?? false,
    error: evalValue?.error,
    value: evalValue?.value,
    durationMs,
  };
}

/**
 * Read the console buffer for a tab. `offset` is measured from the END
 * (most-recent); `limit` is the max entries to return. Returns a tuple of
 * entries and the total buffer size at read time.
 */
export function getConsoleBuffer(tabId: number, limit: number, offset: number): { entries: ConsoleEntry[]; totalCount: number } {
  const buf = consoleBuffer.get(tabId) ?? [];
  const totalCount = buf.length;
  if (totalCount === 0 || limit <= 0) {
    return { entries: [], totalCount };
  }
  // offset 0 = newest; offset 1 = skip the newest, etc.
  const end = totalCount - offset;
  const start = Math.max(0, end - limit);
  if (end <= 0) return { entries: [], totalCount };
  const slice = buf.slice(start, end);
  return { entries: slice, totalCount };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function classifyAttachError(message: string): AttachResult["reason"] {
  const m = message.toLowerCase();
  if (m.includes("permission")) return "permission-denied";
  if (m.includes("another debugger")) return "another-debugger-attached";
  if (m.includes("no tab") || m.includes("tab with id")) return "tab-not-found";
  if (m.includes("invalid")) return "invalid-tab-id";
  if (m.includes("internal")) return "internal-error";
  return "unknown";
}
