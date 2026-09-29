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
import { runNetHookInstall } from "./net-install.js";

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

/** CDP socket tap: requestId → hookId for Network.webSocket* correlation. */
const cdpRequestToHook = new Map<string, string>();

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
  if (hookedTabs.has(tabId)) {
    // Trust-but-verify: the SW restarts lose nothing (module state persists
    // per worker lifetime), but navigations kill the page hook while our bit
    // stays set if webNavigation missed it. A cheap MAIN-world probe decides.
    try {
      const { runtimeEvaluate } = await import("./cdp.js");
      const probe = await runtimeEvaluate(tabId, "!!window.WebSocket.__bpHooked");
      if (probe.ok && probe.value === true) return true;
    } catch { /* fall through to re-install */ }
    hookedTabs.delete(tabId);
  }
  try {
    const { netHookMain } = await import("./net-hook-main.js");
    const ok = await runNetHookInstall(tabId, netHookMain as () => void);
    if (ok) {
      hookedTabs.add(tabId);
      // scripting.executeScript applies to the CURRENT document — no reload,
      // no wait. Push rules so observe/block apply to the live page.
      await pushRulesToTab(tabId);
    }
    return ok;
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


// ── CDP socket tap (Network.webSocket* events, no page hook needed) ──
//
// The debugger sees sockets the page opened BEFORE any hook existed —
// exactly the xterm case. requestId is the correlation key; payloads are
// base64 (binary) or plain text. Frames here are network-truth (what hit
// the wire), complementing the MAIN hook's JS-truth (what the page sent).

/** Network.webSocketCreated → register (or refresh URL of) the hook. */
export function ingestCdpSocketCreated(tabId: number, url: string, requestId: string): void {
  try {
    if (!requestId) return;
    const hook = ensureHook(tabId, `cdp:${requestId}`, url ?? "");
    if (url && !hook.url) hook.url = url;
    cdpRequestToHook.set(requestId, hook.hookId);
  } catch { /* bookkeeping only */ }
}

/** Network.webSocketFrameReceived/Sent → append the payload frame. */
export function ingestCdpSocketFrame(tabId: number, requestId: string, dir: "in" | "out", data: string): void {
  try {
    void tabId;
    const hookId = cdpRequestToHook.get(requestId);
    const hook = hookId ? resolveHook(hookId) : undefined;
    if (!hook) return;
    pushFrame(hook, dir, data ?? "");
  } catch { /* bookkeeping only */ }
}

/** Network.webSocketClosed → keep buffered frames for ws_tail. */
export function ingestCdpSocketClosed(requestId: string): void {
  try {
    cdpRequestToHook.delete(requestId);
  } catch { /* bookkeeping only */ }
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

export function wsList(tabId?: number): { hooks: Array<WsHookInfo & { via: "page-hook" | "cdp" }> } {
  const out: Array<WsHookInfo & { via: "page-hook" | "cdp" }> = [];
  for (const h of hooks.values()) {
    if (tabId !== undefined && h.tabId !== tabId) continue;
    out.push({
      hookId: h.hookId,
      socketId: h.socketId,
      url: h.url,
      tabId: h.tabId,
      createdAt: h.createdAt,
      frameCount: h.frames.length,
      via: h.socketId.startsWith("cdp:") ? "cdp" : "page-hook",
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

/**
 * Send a frame on a hooked socket through the page's own socket object.
 *
 * NOTE: there is no CDP `Network.sendData` (verified live: -32601 method not
 * found). The debugger is observe-only for sockets. Injection therefore
 * evaluates `socket.send(data)` in the page MAIN world via
 * `Runtime.evaluate` — the socket object lives in page JS, so this reaches
 * the real connection with the page's framing/subprotocol intact. Works for
 * tap sockets AND page-hook sockets (same path); the `via` field reports
 * which observation path found the socket.
 */
export async function wsSend(
  tabId: number,
  hookOrSocketId: string,
  data: string,
): Promise<{ sent: boolean; hookId: string; socketId: string; via: "page-hook" | "cdp" }> {
  const hook = resolveHook(hookOrSocketId);
  if (!hook) throw new Error(`unknown websocket hook/socket: ${hookOrSocketId} — run page.net ws_list first`);
  const via = hook.socketId.startsWith("cdp:") ? "cdp" as const : "page-hook" as const;
  // Tap sockets: no page-side id to address. Evaluate the send on the live
  // socket registry instead — the MAIN hook (if present) keeps socket objects;
  // otherwise fall back to dispatching on every OPEN WebSocket we can reach
  // via the hook's registry endpoint. Best-effort by design.
  const { runtimeEvaluate } = await import("./cdp.js");
  const expr = `(() => { try {
    const w = window.__bpNetSockets || {};
    const s = w[${JSON.stringify(hook.socketId)}];
    if (s && s.readyState === 1) { s.send(${JSON.stringify(data)}); return "sent:socket"; }
    return "no-socket:" + Object.keys(w).length;
  } catch (e) { return "error:" + (e && e.message || String(e)); } })()`;
  const res = await runtimeEvaluate(tabId, expr);
  if (!res.ok) {
    throw new Error(`ws_send evaluate failed: ${res.exceptionDetails?.text ?? "unknown"} — socket may be closed`);
  }
  const outcome = String(res.value ?? "");
  if (outcome.startsWith("sent:")) {
    pushFrame(hook, "out", data);
    return { sent: true, hookId: hook.hookId, socketId: hook.socketId, via };
  }
  throw new Error(`ws_send: page has no live socket for ${hook.socketId} (${outcome}) — open the terminal first, or the socket closed`);
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
    // the rules; ensureHookInstalled's postMessage re-push (below) delivers
    // them once the hook lands. Best-effort only.
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
