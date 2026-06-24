/**
 * FILE: extension/src/offscreen.ts
 * PURPOSE: Manage the offscreen document that hosts the canvas for
 *          the screenshot overlay. SWs can't paint — service workers
 *          have no DOM. MV3's pattern is: SW creates an offscreen
 *          document (a real HTML page) via `chrome.offscreen.createDocument`,
 *          the document owns a real <canvas>, and the SW posts work
 *          to it via `chrome.runtime.sendMessage`.
 *
 *          The document is created lazily on first use, and Chrome
 *          keeps it alive until explicitly closed (we never close it
 *          — the overhead of one document per extension is negligible).
 */

const OFFSCREEN_URL = "offscreen.html";
// Note: `chrome.offscreen.Reason` is only available in extension contexts
// (not at module-load time in some build environments). Defer access.

/** Cached "is the offscreen document open?" probe result. */
let hasDocument: boolean | null = null;

/**
 * Check whether our offscreen document is already open. The offscreen
 * API has no `getDocuments()` — the recommended probe is to try
 * `createDocument` with a no-op; if it errors with "Only a single
 * offscreen document may exist", one is already open. Otherwise we
 * create one.
 */
async function ensureOffscreenDocument(): Promise<boolean> {
  if (hasDocument === true) return true;
  try {
    // First, try to create. If one is already open, this throws.
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DISPLAY_MEDIA],
      justification: "Render screenshot overlay annotations on a real <canvas>",
    });
    hasDocument = true;
    return true;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (/Only a single offscreen document/i.test(msg) || /already/i.test(msg)) {
      hasDocument = true;
      return true;
    }
    hasDocument = false;
    throw new Error(`Failed to create offscreen document: ${msg}`);
  }
}

/**
 * Wait for the offscreen document to signal it's ready (its
 * `chrome.runtime.onMessage` listener is registered). The document
 * fires a "bp:overlay:ready" ping right after wiring up the listener.
 * If the ping never arrives (timeout), we proceed anyway — the listener
 * might be set up before we attach.
 */
async function waitForOffscreenReady(timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, timeoutMs);
    chrome.runtime.onMessage.addListener(function once(msg) {
      if (msg && msg.type === "bp:overlay:ready") {
        if (!done) { done = true; clearTimeout(timer); resolve(); }
        return false; // unregister
      }
    });
  });
}

let requestCounter = 0;

/**
 * Ask the offscreen document to render the overlay on top of the
 * given PNG and return the new PNG bytes. Resolves to the bytes.
 */
export async function renderOverlayViaOffscreen(
  pngBytes: Uint8Array,
  anchors: Array<{ anchor?: string; tag?: string; type?: string; ariaLabel?: string; text?: string; boundingRect: { x: number; y: number; width: number; height: number }; center?: { x: number; y: number } }>,
  options: { mode?: "labels" | "coords" | "both" | "anchors_only" | "none"; colorByType?: boolean; labelBackground?: string },
): Promise<{ pngBytes: Uint8Array; drawn: number }> {
  await ensureOffscreenDocument();
  await waitForOffscreenReady();
  const requestId = `bp-overlay-${++requestCounter}`;

  // Send base64 string instead of raw bytes — sending a sliced
  // ArrayBuffer via chrome.runtime.sendMessage can corrupt the PNG
  // (the offscreen document then can't decode it).
  const result = await chrome.runtime.sendMessage({
    type: "bp:overlay:render",
    requestId,
    pngBase64: bytesToBase64(pngBytes),
    anchors,
    options,
  });
  if (!result) {
    throw new Error("offscreen document did not respond");
  }
  if (result.type === "bp:overlay:error") {
    throw new Error(`offscreen render failed: ${result.error}`);
  }
  if (result.type !== "bp:overlay:result") {
    throw new Error(`offscreen returned unexpected type: ${result.type}`);
  }
  if (!result.pngBase64) {
    throw new Error("offscreen returned no pngBase64");
  }
  return {
    pngBytes: base64ToBytes(result.pngBase64),
    drawn: result.drawn,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[]);
  }
  return btoa(bin);
}
