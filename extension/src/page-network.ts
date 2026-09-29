/**
 * FILE: extension/src/page-network.ts
 * PURPOSE: Service-worker side bookkeeping for `page.net` (TSK-0015).
 *          Pure SW state — the page-context hook that actually observes
 *          frames/requests lives in the MAIN-world function
 *          `netHookMain` (./net-hook-main.ts), installed CSP-exempt via
 *          `chrome.scripting.executeScript ({ world: "MAIN" })`
 *          (ensureHookInstalled, below) — NOT via a `<script>` tag from
 *          the content script, because strict page CSPs (`script-src
 *          'self'` without `unsafe-inline`, e.g. cloud.ru) refuse inline
 *          scripts. The content script's own inject attempt is a
 *          best-effort fast path; this is the authoritative path.
 *          Frames/logs come back via window.postMessage → isolated content
 *          listener → chrome.runtime.sendMessage `bp:net-frame`, ingested
 *          via `ingestNetFrame` / `ingestHttpFrame` (wired in background.ts).
 *          Blocking is wrapper-level only (fetch short-circuits with a
 *          synthetic 403 Response in the page hook) — honest subset, NOT
 *          network-stack blocking (no declarativeNetRequest rules).
 * OWNS: Per-tab WS hook registry, HTTP observe/block rules, HTTP log ring,
 *       MAIN-world hook installation.
 * EXPORTS: wsList, wsSend, wsTail, httpObserve, httpBlock, httpRules,
 *          httpUnblock, ingestNetFrame, ingestHttpFrame, ensureHookInstalled
 */

export interface NetFrame {
  dir: "in" | "out";
  data: string;
  ts: number;
}

export interface WsHookInfo {
  hookId: string;
  socketId: string;
  url: string;
  tabId: number;
  createdAt: number;
  frameCount: number;
}

interface WsHook extends Omit<WsHookInfo, "frameCount"> {
  frames: NetFrame[];
}

export interface HttpRule {
  id: string;
  pattern: string;
  action: "observe" | "block";
  createdAt: number;
}

export interface HttpLogEntry {
  method: string;
  url: string;
  status: number;
  tabId: number;
  blocked: boolean;
  ts: number;
  body?: string;
}

/** Ring-buffer caps — matches the 200/tab convention of network.requests. */
const MAX_FRAMES_PER_HOOK = 200;
const MAX_HTTP_LOGS = 500;

const hooks = new Map<string, WsHook>();
const socketToHook = new Map<string, string>();
let hookSeq = 0;

const rules: HttpRule[] = [];
let ruleSeq = 0;

const httpLogs: HttpLogEntry[] = [];
let includeBodies = false;

/** Tabs with a confirmed MAIN-world hook (else executeScript re-injects). */
const hookedTabs = new Set<number>();

/**
 * Install `netHookMain` into the page MAIN world CSP-exempt via
 * `chrome.scripting.executeScript ({ world: "MAIN" })`. Idempotent per
 * tab — skips tabs already hooked. Best-effort: returns false (never
 * throws) on chrome://, unloaded, or not-yet-injected tabs; the caller
 * proceeds anyway so observation degrades to empty instead of erroring.
 */
export async function ensureHookInstalled(tabId: number): Promise<boolean> {
  if (hookedTabs.has(tabId)) return true;
  try {
    const { netHookMain } = await import("./net-hook-main.js");
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: netHookMain as () => void,
    });
    hookedTabs.add(tabId);
    return true;
  } catch {
    return false;
  }
}

/** Forget hook state (navigation, tab close) so the next call re-injects. */
export function forgetHook(tabId: number): void {
  hookedTabs.delete(tabId);
}
/** `*` wildcard matching, otherwise plain substring. Shared semantics with the page hook. */
export function patternMatches(url: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.includes("*")) {
    const rx = new RegExp(
      "^" +
        pattern
          .split("*")
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    );
    try {
      return rx.test(url);
    } catch {
      return false;
    }
  }
  return url.includes(pattern);
}

function ensureHook(tabId: number, socketId: string, url: string): WsHook {
  const existingId = socketToHook.get(socketId);
  if (existingId) {
    const existing = hooks.get(existingId);
    if (existing) return existing;
  }
  hookSeq += 1;
  const hookId = `hook_${hookSeq}`;
  const hook: WsHook = { hookId, socketId, url, tabId, createdAt: Date.now(), frames: [] };
  hooks.set(hookId, hook);
  socketToHook.set(socketId, hookId);
  return hook;
}

function resolveHook(hookOrSocketId: string): WsHook | undefined {
  return hooks.get(hookOrSocketId) ?? hooks.get(socketToHook.get(hookOrSocketId) ?? "");
}

function pushFrame(hook: WsHook, dir: "in" | "out", data: string): void {
  hook.frames.push({ dir, data: String(data).slice(0, 4096), ts: Date.now() });
  if (hook.frames.length > MAX_FRAMES_PER_HOOK) {
    hook.frames.splice(0, hook.frames.length - MAX_FRAMES_PER_HOOK);
  }
}

// ── Ingest (called from background.ts `bp:net-frame` handler) ──

/** Ingest a relayed WS event from the page hook. Payload shape mirrors the MAIN hook relay. */
export function ingestNetFrame(tabId: number, payload: Record<string, unknown>): void {
  try {
    const kind = payload.kind as string;
    const socketId = payload.socketId as string;
    if (kind === "hook-ready") return; // presence ping only
    if (!socketId || typeof socketId !== "string") return;
    const url = (payload.url as string) ?? "";
    const hook = ensureHook(tabId, socketId, url);
    if (url && !hook.url) hook.url = url;
    if (kind === "frame") {
      pushFrame(hook, payload.dir === "in" ? "in" : "out", (payload.data as string) ?? "");
    }
    // "open" / "close" just register presence; close keeps buffered frames for ws_tail.
  } catch {
    // Bookkeeping must never break the SW — drop malformed payloads.
  }
}

/** Ingest a relayed HTTP observation from the page hook. */
export function ingestHttpFrame(tabId: number, payload: Record<string, unknown>): void {
  try {
    httpLogs.push({
      method: (payload.method as string) ?? "GET",
      url: (payload.url as string) ?? "",
      status: (payload.status as number) ?? 0,
      tabId,
      blocked: payload.blocked === true,
      ts: Date.now(),
      body:
        typeof payload.body === "string" && includeBodies
          ? payload.body.slice(0, 4096)
          : undefined,
    });
    if (httpLogs.length > MAX_HTTP_LOGS) {
      httpLogs.splice(0, httpLogs.length - MAX_HTTP_LOGS);
    }
  } catch {
    // Best-effort only.
  }
}

// ── WS ops ──

export function wsList(tabId?: number): { hooks: WsHookInfo[] } {
  const out: WsHookInfo[] = [];
  for (const h of hooks.values()) {
    if (tabId !== undefined && h.tabId !== tabId) continue;
    out.push({
      hookId: h.hookId,
      socketId: h.socketId,
      url: h.url,
      tabId: h.tabId,
      createdAt: h.createdAt,
      frameCount: h.frames.length,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return { hooks: out };
}

export function wsTail(
  hookOrSocketId: string,
  limit = 50,
): { hookId: string; socketId: string; url: string; frames: NetFrame[] } {
  const hook = resolveHook(hookOrSocketId);
  if (!hook) throw new Error(`unknown websocket hook/socket: ${hookOrSocketId} — run page.net ws_list first`);
  return {
    hookId: hook.hookId,
    socketId: hook.socketId,
    url: hook.url,
    frames: hook.frames.slice(-Math.max(1, limit)),
  };
}

/** Ask the page hook to send a frame on a live socket (delivery is best-effort in-page). */
export async function wsSend(
  tabId: number,
  hookOrSocketId: string,
  data: string,
): Promise<{ sent: boolean; hookId: string; socketId: string }> {
  const hook = resolveHook(hookOrSocketId);
  if (!hook) throw new Error(`unknown websocket hook/socket: ${hookOrSocketId} — run page.net ws_list first`);
  try {
    await chrome.tabs.sendMessage(tabId, {
      source: "browserpowers",
      type: "bp:net-send",
      params: { socketId: hook.socketId, data },
    });
  } catch (e) {
    throw new Error(`ws_send delivery failed (no hooked page in tab ${tabId}): ${(e as Error).message}`);
  }
  return { sent: true, hookId: hook.hookId, socketId: hook.socketId };
}

// ── HTTP ops ──

async function pushRulesToTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      source: "browserpowers",
      type: "bp:net-rules",
      params: { rules: rules.map((r) => ({ ...r })), includeBodies },
    });
  } catch {
    // Tab may have no content script yet (navigating, chrome://) — SW keeps
    // the rules; the page hook pulls them on next navigation via bp:net-rules
    // re-push from httpRules() callers. Best-effort only.
  }
}

async function pushRulesToAllTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => (t.id !== undefined ? pushRulesToTab(t.id) : Promise.resolve())));
  } catch {
    // Best-effort only.
  }
}

function upsertRule(pattern: string, action: "observe" | "block"): HttpRule {
  const existing = rules.find((r) => r.pattern === pattern && r.action === action);
  if (existing) return existing;
  ruleSeq += 1;
  const rule: HttpRule = { id: `http_${ruleSeq}`, pattern, action, createdAt: Date.now() };
  rules.push(rule);
  return rule;
}

export async function httpObserve(
  pattern: string,
  withBodies = false,
  tabId?: number,
  limit = 100,
): Promise<{ rule: HttpRule; matchCount: number; matches: HttpLogEntry[] }> {
  const rule = upsertRule(pattern, "observe");
  if (withBodies) includeBodies = true;
  await pushRulesToAllTabs();
  const matches = httpLogs
    .filter(
      (e) => (tabId === undefined || e.tabId === tabId) && patternMatches(e.url, pattern),
    )
    .slice(-Math.max(1, limit));
  return { rule, matchCount: matches.length, matches };
}

export async function httpBlock(pattern: string): Promise<{ rule: HttpRule }> {
  const rule = upsertRule(pattern, "block");
  await pushRulesToAllTabs();
  return { rule };
}

export function httpRules(): { rules: HttpRule[] } {
  return { rules: rules.map((r) => ({ ...r })) };
}

export async function httpUnblock(id: string): Promise<{ removed: boolean; id: string }> {
  const idx = rules.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error(`unknown http rule: ${id} — run page.net http_rules first`);
  rules.splice(idx, 1);
  await pushRulesToAllTabs();
  return { removed: true, id };
}
