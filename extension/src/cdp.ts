/**
 * FILE: extension/src/cdp.ts
 * PURPOSE: Single owner of the chrome.debugger (CDP) layer in BrowserPowers.
 *          Provides lazy attach, detach, runtimeEvaluate, and a per-tab console
 *          buffer fed by `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`
 *          / `Log.entryAdded` events. Service-worker-only module — the content
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
 * OWNS: chrome.debugger attach lifecycle, per-tab console ring buffer, per-tab
 *       command serialization queue, runtimeEvaluate wrapper, public state
 *       surface for page.read action=runtime_status.
 * EXPORTS: ensureAttached, detach, getState, runtimeEvaluate, getConsoleBuffer,
 *          init (called once at SW startup to register listeners), CdpState,
 *          AttachResult, EvalResult, ConsoleEntry.
 * DOCS:   .agents/reports/plan_cdp-max-authority_2026-06-22.md
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
  } catch (err) {
    console.warn(`[bp-cdp] Failed to enable Runtime/Log domains on tab ${tabId}: ${(err as Error).message}`);
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
