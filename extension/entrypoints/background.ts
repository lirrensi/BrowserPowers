/**
 * Service Worker — keeps the WebSocket alive and handles tool execution.
 * This is the bridge between the BrowserPowers core and this browser's chrome.* APIs.
 */

import { connect, reconnect, onMessage, isConnected, send, getConnectionStatus, getCoreVersion, disconnect } from "../src/ws-client";
import { routeExecute, rehydrateHelpRequests, type ExecuteRequest } from "../src/capability-router";
import { isExtensionContext } from "../src/safety";
import { getSettings, saveSettings, saveSessionPermissionOverride, clearSessionPermissionOverride, getPageSitePermissions, addSitePattern } from "../src/storage";
import { normalizeHostname, resolvePagePermission } from "../src/site-permissions";
// Side-effect import — registers chrome.debugger.onEvent / onDetach listeners
// and webNavigation / tabs.onRemoved auto-detach hooks. Attach itself is lazy;
// nothing happens until the first page.js or console read on a tab.
import { ingestNetFrame, ingestHttpFrame } from "../src/page-network";

interface PendingApproval {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
  description: string;
  group: string;
  title?: string;
  url?: string;
  notificationId: string;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_UI_MS = 60_000;
const APPROVAL_NOTIFICATION_PREFIX = "bp-approval:";

/** FIFO queue for sequential WebSocket message processing */
const messageQueue: any[] = [];
let processingMessage = false;

export default {
  main(): void {
    // Only run in actual browser extension context
    if (!isExtensionContext()) return;

    init();
  },
};

async function processNextMessage(): Promise<void> {
  if (processingMessage) return;
  processingMessage = true;
  try {
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      try {
        await handleCoreMessage(msg);
      } catch (err) {
        console.error(`[bp-ext] Error handling core message (${msg?.type ?? "unknown"}):`, (err as Error).message);
        // Continue processing remaining messages — don't let one bad message deadlock the queue
      }
    }
  } finally {
    processingMessage = false;
  }
}

async function handleCoreMessage(msg: any): Promise<void> {
  switch (msg.type) {
    case "registered": {
        const browserId = msg.payload.browserId as string;
        console.log(`[bp-ext] Registered as browser: ${browserId}`);
        chrome.storage.local.set({ browserId });
        break;
      }

      case "execute": {
        const req = msg.payload as ExecuteRequest;
        console.log(`[bp-ext] Executing: ${req.tool} (${req.requestId})`);
        const result = await routeExecute(req);
        send({
          type: result.success ? "result" : "error",
          payload: result.success
            ? { requestId: result.requestId, data: result.data }
            : { requestId: result.requestId, message: result.error },
        });
        break;
      }

      case "heartbeat_ack": {
        break;
      }

      case "config_updated": {
        console.log("[bp-ext] Config updated from core:", msg.payload);
        break;
      }

      case "auth_required": {
        console.warn("[bp-ext] Core requires API key — disconnecting");
        disconnect();
        const { setAuthRequired } = await import("../src/ws-client.js");
        setAuthRequired(true);
        break;
      }

      case "request_approval": {
        const { requestId, tool, params, description } = msg.payload;
        console.log(`[bp-ext] Approval requested: ${tool} (${requestId})`);

        // YOLO mode: dedicated automation browser, no human in the loop.
        // Auto-approve everything WITHOUT persisting anything — turning YOLO
        // off must restore the exact prior posture, so no site patterns,
        // no session overrides, no permission writes happen here.
        try {
          const settings = await getSettings();
          if (settings.yoloMode === true) {
            console.log(`[bp-ext] YOLO mode: auto-approving ${tool}`);
            send({ type: "approval_response", payload: { requestId, approved: true } });
            updateBadge();
            return;
          }
        } catch { /* fall through to normal approval flow */ }

        // ── Site-pattern check ──
        // Only relevant for page tools. Check if site rules already cover this.
        const isPageTool = tool === "page.read" || tool === "page.act" || tool === "page.js";
        const { title, url } = await getActiveTabContext();
        if (isPageTool && url) {
          const pageSites = await getPageSitePermissions();
          const groupKey = tool === "page.js" ? "page.execute" : (tool as any);
          const lists = pageSites[groupKey];
          if (lists) {
            const decision = resolvePagePermission(url, lists);
            if (decision === "allow") {
              console.log(`[bp-ext] Site rule auto-approves ${tool} on ${url}`);
              send({ type: "approval_response", payload: { requestId, approved: true } });
              updateBadge();
              return;
            }
            if (decision === "deny") {
              console.log(`[bp-ext] Site rule denies ${tool} on ${url}`);
              send({ type: "approval_response", payload: { requestId, approved: false } });
              updateBadge();
              return;
            }
            // decision === "ask" → fall through to normal prompt
          }
        }

        const group = resolvePermissionGroup(tool);
        const notificationId = `${APPROVAL_NOTIFICATION_PREFIX}${requestId}`;

        const timeoutTimer = setTimeout(async () => {
          // Notify core that this approval timed out on the extension side
          // This prevents the core from accepting a late user response after timeout
          send({ type: "approval_response", payload: { requestId, approved: false, timed_out: true } });
          await dismissPendingApproval(requestId, { keepNotification: false });
        }, APPROVAL_TIMEOUT_UI_MS);

        pendingApprovals.set(requestId, {
          requestId,
          tool,
          params,
          description,
          group,
          title,
          url,
          notificationId,
          timeoutTimer,
        });
        updateBadge();
        const settings = await getSettings();
        if (settings.approvalNotificationsEnabled) {
          void createApprovalNotification({ requestId, tool, description, title, url, notificationId });
        }
        break;
      }

      default:
        console.warn("[bp-ext] Unknown message:", msg.type);
    }
}

function init(): void {
  // Connect when service worker starts
  connect();

  try { console.log("[bp-ext] SW started"); } catch { /* ignore */ }

  // Sweep orphaned human-help waits left by a terminated worker.
  try { rehydrateHelpRequests(); } catch { /* hygiene best-effort */ }

  // MV3 service worker stability: re-check connection on browser startup
  // (fires when the browser fully restarts, not on service worker wake)
  chrome.runtime.onStartup?.addListener(() => {
    console.log("[bp-ext] Browser startup detected, verifying connection...");
    if (!isConnected()) {
      void reconnect();
    }
  });

  // Graceful WS close before service worker suspends (MV3)
  // The disconnect sends a best-effort frame; if the SW suspends mid-send, the
  // core will detect the stale connection via heartbeat timeout.
  chrome.runtime.onSuspend?.addListener(() => {
    console.log("[bp-ext] Service worker suspending, closing WebSocket...");
    disconnect();
  });

  // Update onMessage to use FIFO queue
  onMessage((msg: any) => {
    messageQueue.push(msg);
    // Fire-and-forget: processNextMessage handles its own errors internally
    processNextMessage().catch((err) => {
      console.error("[bp-ext] processNextMessage unexpected rejection:", (err as Error).message);
    });
  });

  // Reconnect when storage changes (user updated settings in popup)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.settings) {
      console.log("[bp-ext] Settings changed, reconnecting...");
      void reconnect();
    }

    if (namespace === "session" && changes.sessionPermissionOverrides) {
      console.log("[bp-ext] Session permissions changed, reconnecting...");
      void reconnect();
    }
  });

  chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return;
    void chrome.action.openPopup?.();
  });

  // Keep service worker alive via chrome.alarms (MV3 workaround)
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
      chrome.storage.local.get("browserId");
      if (!isConnected()) {
        connect();
      } else {
        // Socket back — flush any notes queued while offline.
        void flushAnnotationOutbox();
      }
    }
  });

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    switch (message.type) {
      case "getConnectionStatus": {
        sendResponse(getConnectionStatus());
        break;
      }

      case "getVersions": {
        let extVersion = "unknown";
        try {
          extVersion = chrome.runtime.getManifest().version;
        } catch { /* keep fallback */ }
        sendResponse({ extVersion, coreVersion: getCoreVersion() });
        break;
      }

      case "reconnectToCore": {
        void reconnect();
        sendResponse({ success: true });
        break;
      }

      case "getPendingApprovals": {
        sendResponse(Array.from(pendingApprovals.values()));
        break;
      }

      case "approveRequest": {
        const requestId = message.requestId as string;
        const scope = (message.scope ?? "once") as "once" | "session" | "forever";
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleApprovalDecision(approval, scope);
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "approveRequestOnce": {
        const requestId = message.requestId as string;
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleApprovalDecision(approval, "once");
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "approveRequestSession": {
        const requestId = message.requestId as string;
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleApprovalDecision(approval, "session");
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "approveRequestForever": {
        const requestId = message.requestId as string;
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleApprovalDecision(approval, "forever");
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "denyRequest": {
        const requestId = message.requestId as string;
        const approval = pendingApprovals.get(requestId);
        if (approval) {
          void handleRejection(approval);
        }
        sendResponse({ success: !!approval });
        break;
      }

      case "annotateArm": {
        // Popup button → arm the picker in the active tab (element or region).
        // Replies fast; content script does the DOM work and reports back.
        void (async () => {
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs[0];
            const tabId = tab?.id;
            if (tabId === undefined) {
              sendResponse({ success: false, error: "No active tab" });
              return;
            }
            const blocked = restrictedAnnotateReason(tab?.url);
            if (blocked) {
              sendResponse({ success: false, error: blocked });
              return;
            }
            const wantMode = message.mode === "region" ? "region" : "element";
            const res = await chrome.tabs.sendMessage(tabId, { source: "browserpowers", type: "bp:annotate", action: "arm", params: { mode: wantMode } }) as Record<string, unknown>;
            sendResponse({ success: res?.armed !== false, tabId, mode: wantMode });
          } catch (err) {
            sendResponse({ success: false, error: friendlyAnnotateError((err as Error).message) });
          }
        })();
        break;
      }

      case "annotateDisarm": {
        void (async () => {
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = tabs[0]?.id;
            if (tabId === undefined) {
              sendResponse({ success: false, error: "No active tab" });
              return;
            }
            await chrome.tabs.sendMessage(tabId, { source: "browserpowers", type: "bp:annotate", action: "disarm", params: {} });
            sendResponse({ success: true, tabId });
          } catch (err) {
            sendResponse({ success: false, error: friendlyAnnotateError((err as Error).message) });
          }
        })();
        break;
      }

      case "annotateStatus": {
        void (async () => {
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = tabs[0]?.id;
            if (tabId === undefined) {
              sendResponse({ armed: false });
              return;
            }
            const res = await chrome.tabs.sendMessage(tabId, { source: "browserpowers", type: "bp:annotate", action: "status", params: {} }) as Record<string, unknown>;
            sendResponse({ armed: res?.armed === true, tabId });
          } catch {
            sendResponse({ armed: false });
          }
        })();
        break;
      }

      case "bp:annotation": {
        // Picker draft from the content script → WS `annotation` → core store.
        // SW stamps tabId/windowId (content must not self-report identity),
        // captures the screenshot when asked, queues to session outbox when
        // the socket is down (flushed on reconnect).
        void forwardAnnotation(_sender?.tab?.id, _sender?.tab?.windowId, (message.draft ?? {}) as Record<string, unknown>)
          .then((id) => sendResponse({ received: true, id }))
          .catch((err) => sendResponse({ received: false, error: (err as Error).message }));
        break;
      }
      case "bp:net-frame": {
        // page.net relay (TSK-0015): content script forwards MAIN-hook frames.
        // Ingest is best-effort bookkeeping — never fails the message channel.
        try {
          const tabId = _sender?.tab?.id as number | undefined;
          const frame = (message.frame ?? {}) as Record<string, unknown>;
          if (tabId !== undefined && tabId >= 0) {
            if (frame.domain === "http" || frame.kind === "http") {
              ingestHttpFrame(tabId, frame);
            } else {
              ingestNetFrame(tabId, frame);
            }
          }
        } catch { /* bookkeeping must not break messaging */ }
        sendResponse({ received: true });
        break;
      }
      default:
        return false; // not handled
    }
    return true; // keep channel open for async response
  });
}

// ── Annotate errors: translate "Receiving end does not exist" into actions ──

function restrictedAnnotateReason(url: string | undefined): string | null {
  if (!url) return null;
  const blocked = ["chrome://", "chrome-extension://", "edge://", "about:", "devtools://", "view-source:", "chrome-search://", "chrome-native://"];
  if (blocked.some((p) => url.startsWith(p))) return `Annotate doesn't work on this page (${url.split(":")[0]}://) — Chrome blocks content scripts here. Switch to an http(s) tab.`;
  const store = ["chrome.google.com/webstore", "microsoftedge.microsoft.com/addons"];
  if (store.some((h) => url.includes(h))) return "Annotate doesn't work on the extension web store — Chrome blocks content scripts here. Switch to the tab you want to annotate.";
  return null;
}

function friendlyAnnotateError(raw: string): string {
  if (raw.includes("Receiving end does not exist") || raw.includes("Could not establish connection")) {
    return "No annotate picker in this tab — the content script isn't running here. Reload the tab once (new install or chrome:// page), then Annotate again.";
  }
  return raw;
}

interface PendingDraft {
  clientId: string;
  tabId: number;
  windowId?: number;
  draft: Record<string, unknown>;
  queuedAt: number;
}

const OUTBOX_KEY = "bp:annotation-outbox";
const OUTBOX_MAX = 50;

function newClientId(): string {
  return `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function readOutbox(): Promise<PendingDraft[]> {
  try {
    const got = await chrome.storage.session.get(OUTBOX_KEY) as Record<string, unknown>;
    const list = got?.[OUTBOX_KEY];
    return Array.isArray(list) ? (list as PendingDraft[]) : [];
  } catch {
    return [];
  }
}

async function writeOutbox(list: PendingDraft[]): Promise<void> {
  try {
    await chrome.storage.session.set({ [OUTBOX_KEY]: list.slice(-OUTBOX_MAX) });
  } catch { /* outbox best-effort; WS send already attempted first */ }
}

/** Push one draft toward the core. Returns the clientId (ack matching). */
async function forwardAnnotation(tabId: number | undefined, windowId: number | undefined, draft: Record<string, unknown>): Promise<string> {
  if (tabId === undefined || tabId < 0) throw new Error("annotation requires a tab");
  const comment = typeof draft.comment === "string" ? draft.comment.trim() : "";
  if (!comment) throw new Error("annotation requires a non-empty comment");
  const clientId = newClientId();
  const payload: Record<string, unknown> = { ...draft, comment, tabId, ...(windowId !== undefined ? { windowId } : {}) };
  if (payload.kind === "screenshot") {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
      const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, "");
      const region = payload.region as { x: number; y: number; width: number; height: number; viewportWidth?: number; viewportHeight?: number } | undefined;
      if (region && region.width >= 12 && region.height >= 12) {
        try {
          const { cropPngViaOffscreen } = await import("../src/offscreen.js");
          const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const cropped = await cropPngViaOffscreen(raw, region, region.viewportWidth && region.viewportHeight
            ? { width: region.viewportWidth, height: region.viewportHeight }
            : undefined);
          let bin = "";
          for (const b of cropped.pngBytes) bin += String.fromCharCode(b);
          payload.screenshotBase64 = btoa(bin);
          payload.crop = { width: cropped.width, height: cropped.height };
        } catch (cropErr) {
          // Crop failed (offscreen asleep, bad rect) — send the FULL tab
          // screenshot instead of killing the note. Region rect stays on
          // the note so the agent still sees the intended box.
          payload.screenshotBase64 = base64;
          payload.cropError = (cropErr as Error).message;
        }
      } else {
        payload.screenshotBase64 = base64;
      }
    } catch {
      // Capture itself failed (occluded window, chrome:// page) — keep the note.
      payload.kind = "element";
    }
  }
  if (isConnected()) {
    send({ type: "annotation", payload: { ...payload, clientId } });
    return clientId;
  }
  const outbox = await readOutbox();
  outbox.push({ clientId, tabId, windowId, draft: payload, queuedAt: Date.now() });
  await writeOutbox(outbox);
  try { void chrome.action.setBadgeText({ text: "•" }); } catch { /* ignore */ }
  return clientId;
}

/** Flush session outbox after (re)connect — best-effort, order preserved. */
async function flushAnnotationOutbox(): Promise<void> {
  if (!isConnected()) return;
  const outbox = await readOutbox();
  if (outbox.length === 0) return;
  await writeOutbox([]);
  for (const item of outbox) {
    try {
      send({ type: "annotation", payload: { ...item.draft, clientId: item.clientId } });
    } catch {
      const rest = await readOutbox();
      rest.push(item);
      await writeOutbox(rest);
      return;
    }
  }
  try { void chrome.action.setBadgeText({ text: "" }); } catch { /* ignore */ }
}

function updateBadge(): void {
  const count = pendingApprovals.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: "•" });
    chrome.action.setBadgeBackgroundColor({ color: "#eab308" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function resolvePermissionGroup(tool: string): string {
  // V2 page tools
  if (tool === "page.js") return "page.execute";
  if (tool.startsWith("page.")) return tool;

  // Browser API tools — map to their granular permission group
  switch (tool) {
    case "history.search": return "history.read";
    case "history.delete": return "history.delete";
    case "bookmarks.list": return "bookmarks.read";
    case "bookmarks.create": return "bookmarks.modify";
    case "bookmarks.delete": return "bookmarks.delete";
  }

  // Fallback: first segment of dotted name (e.g. "tabs.list" → "tabs")
  return tool.split(".")[0] ?? tool;
}

async function getActiveTabContext(): Promise<{ title?: string; url?: string }> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs[0];
    if (!active) return {};
    return { title: active.title, url: active.url };
  } catch {
    return {};
  }
}

function buildNotificationIconUrl(): string {
  // File icon — data: URLs are rejected by notifications in some Chromium builds.
  return "icon-128.png";
}

async function createApprovalNotification(approval: PendingApproval): Promise<void> {
  try {
    await chrome.notifications.create(approval.notificationId, {
      type: "basic",
      iconUrl: buildNotificationIconUrl(),
      title: `Approval needed: ${approval.tool}`,
      message: [approval.description, approval.url ?? approval.title ?? ""].filter(Boolean).join("\n"),
      priority: 2,
      requireInteraction: true,
    });
  } catch (err) {
    console.warn("[bp-ext] Failed to create approval notification:", (err as Error).message);
  }
}

async function dismissPendingApproval(
  requestId: string,
  options: { keepNotification: boolean },
): Promise<void> {
  const approval = pendingApprovals.get(requestId);
  if (!approval) return;

  clearTimeout(approval.timeoutTimer);
  pendingApprovals.delete(requestId);
  updateBadge();

  if (!options.keepNotification) {
    try {
      await chrome.notifications.clear(approval.notificationId);
    } catch {
      // ignore
    }
  }
}

async function handleApprovalDecision(
  approval: PendingApproval,
  scope: "once" | "session" | "forever",
): Promise<void> {
  send({ type: "approval_response", payload: { requestId: approval.requestId, approved: true } });
  await dismissPendingApproval(approval.requestId, { keepNotification: false });

  const isPageTool =
    approval.tool === "page.read" || approval.tool === "page.act" || approval.tool === "page.js";

  if (scope === "once") {
    // No persistence needed
    return;
  }

  if (isPageTool && approval.url) {
    const hostname = normalizeHostname(approval.url);
    if (!hostname) return;

    if (scope === "session") {
      // Save to session storage for site rule
      await addSitePattern(
        approval.group as any,
        "allow",
        hostname,
      );
      // Also set session override so core doesn't re-ask
      await saveSessionPermissionOverride(approval.group, "allow");
    }

    if (scope === "forever") {
      await addSitePattern(
        approval.group as any,
        "allow",
        hostname,
      );
      await clearSessionPermissionOverride(approval.group);
      await saveSettings({
        permissions: {
          ...(await getSettings()).permissions,
          [approval.group]: "allow",
        },
      });
    }
    return;
  }

  // Fallback for non-page tools (existing behavior)
  if (scope === "session") {
    await saveSessionPermissionOverride(approval.group, "allow");
    return;
  }

  if (scope === "forever") {
    await clearSessionPermissionOverride(approval.group);
    const settings = await getSettings();
    await saveSettings({
      permissions: {
        ...settings.permissions,
        [approval.group]: "allow",
      },
    });
  }
}

async function handleRejection(approval: PendingApproval): Promise<void> {
  send({ type: "approval_response", payload: { requestId: approval.requestId, approved: false } });
  await dismissPendingApproval(approval.requestId, { keepNotification: false });
}
