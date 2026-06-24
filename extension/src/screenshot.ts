/**
 * FILE: extension/src/screenshot.ts
 * PURPOSE: Capture visible-tab PNG and (optionally) paint annotated boxes
 *          + labels on top of it. Single source of truth for the
 *          `screenshots.capture` overlay pipeline. The agent passes an
 *          `overlay` param to choose the annotation mode; we run a content-
 *          script inspect pass to get the interactable anchors (with their
 *          bounding rects), then draw them on the captured PNG via
 *          OffscreenCanvas + a 2D context.
 *
 *          Modes:
 *            - "none"          : no overlay (just the raw PNG, backward compat)
 *            - "labels"        : draw boxes + anchor id (a1, a2, …) + tag#id
 *            - "coords"        : draw boxes + (x, y) coords
 *            - "both"          : labels + coords
 *            - "anchors_only"  : draw boxes only, no text inside
 *
 *          The boxes are colour-coded by tag (button=blue, input=green,
 *          link=orange, select=purple, default=gray). Labels sit in a
 *          semi-transparent pill so they stay legible on any background.
 *
 *          OffscreenCanvas + createImageBitmap are both available in MV3
 *          service workers since Chrome 94. The code falls back to a
 *          regular <canvas> only if OffscreenCanvas is missing — but
 *          service workers don't have DOM, so the typical fallback path
 *          is "use OffscreenCanvas" and surface a clean error if not.
 *
 * OWNS: Annotated screenshot capture pipeline (captureVisibleTab → canvas
 *       decode → 2D draw → re-encode PNG). The fast path (no overlay)
 *       stays in capability-router.ts for the common case.
 * EXPORTS: captureWithOverlay, OverlayMode, OverlayOptions
 * DOCS: .agents/reports/plan_visual-help-csp-tighten_2026-06-23.md §3.4
 */

import { isExtensionContext } from "./safety.js";
import { renderOverlayViaOffscreen } from "./offscreen.js";

export type OverlayMode = "none" | "labels" | "coords" | "both" | "anchors_only";

export interface OverlayOptions {
  mode: OverlayMode;
  /** Max anchors to draw. Caps draw time on large pages. Default 50. */
  limit?: number;
  /** Whether to color the box stroke by tag type. Default true. */
  colorByType?: boolean;
  /** Background fill of the label pill, hex. Default semi-black. */
  labelBackground?: string;
}

export interface CaptureWithOverlayResult {
  base64: string;
  format: "png";
  /** How many anchors were actually painted on the image. */
  drawn: number;
  /** How many anchors were skipped (e.g. out of viewport). */
  skipped: number;
}

// ── Anchor shape expected from the content-script inspect pass ──

interface InspectAnchor {
  anchor: string;
  tag: string;
  text?: string;
  ariaLabel?: string;
  type?: string;
  role?: string;
  /** Provided when the inspect call had bbox collection enabled. */
  boundingRect?: { x: number; y: number; width: number; height: number };
  center?: { x: number; y: number };
}

// ── Color scheme (by tag) ──

const TAG_COLORS: Record<string, string> = {
  button: "#3b82f6",   // blue
  input: "#22c55e",    // green
  textarea: "#22c55e", // green
  select: "#a855f7",   // purple
  a: "#f97316",        // orange
};

const DEFAULT_COLOR = "#9ca3af"; // gray

function colorForTag(tag: string, colorByType: boolean): string {
  if (!colorByType) return DEFAULT_COLOR;
  return TAG_COLORS[tag.toLowerCase()] ?? DEFAULT_COLOR;
}

// ── Public entry point ──

/**
 * Capture a PNG of the visible tab and (optionally) paint annotated
 * boxes on top. Calls a content-script inspect pass first to gather
 * anchors + their bounding rects. Never throws — returns either a
 * successful base64 PNG or throws via the caller after packaging the
 * error into a structured response.
 */
export async function captureWithOverlay(
  tabId: number,
  opts: OverlayOptions,
): Promise<CaptureWithOverlayResult> {
  const mode: OverlayMode = opts.mode ?? "none";
  const limit = Math.min(opts.limit ?? 50, 200);
  const colorByType = opts.colorByType ?? true;
  const labelBackground = opts.labelBackground ?? "rgba(0,0,0,0.78)";

  if (!isExtensionContext()) {
    throw new Error("captureWithOverlay must run in extension context");
  }
  if (mode === "none") {
    // Caller should have skipped this path. Defensive fallback: plain capture.
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
    return {
      base64: dataUrl.replace(/^data:image\/png;base64,/, ""),
      format: "png",
      drawn: 0,
      skipped: 0,
    };
  }

  // 1. Capture the raw PNG.
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");

  // 2. Gather anchors from the content script. We piggyback on the
  //    existing `bp:read inspect` message — it returns the anchor list
  //    with boundingRect + center when the inspect call is in non-compact
  //    mode. (content-actions.ts only emits these in !compact; we don't
  //    pass compact: true so the full shape comes back.)
  const anchors = await collectAnchors(tabId, limit);
  if (anchors.length === 0) {
    throw new Error(`No anchors with boundingRect to draw after collectAnchors (got 0)`);
  }

  // 3. Decode + draw + re-encode — in the offscreen document.
  const pngBytes = base64ToBytes(base64);
  const result = await renderOverlayViaOffscreen(pngBytes, anchors, { mode, colorByType, labelBackground });
  const painted = bytesToBase64(result.pngBytes);
  return { base64: painted, format: "png", drawn: result.drawn, skipped: 0 };
}

// ── Internal: collect anchors from the content script ──

async function collectAnchors(tabId: number, limit: number): Promise<InspectAnchor[]> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      source: "browserpowers",
      type: "bp:read",
      action: "inspect",
      params: { limit, compact: false, include_hidden: false },
    }) as { anchors?: InspectAnchor[] } | undefined;
    if (!response || !Array.isArray(response.anchors)) return [];
    return response.anchors.filter((a) => a.boundingRect);
  } catch (err) {
    // Content script not available, tab closed mid-capture, etc.
    console.warn(`[bp-screenshot] collectAnchors failed: ${(err as Error).message}`);
    return [];
  }
}

// ── Internal: paint overlay on top of the captured PNG ──

async function paintOverlay(
  base64Png: string,
  anchors: InspectAnchor[],
  opts: { mode: OverlayMode; colorByType: boolean; labelBackground: string },
): Promise<string> {
  // Decode the PNG.
  const bytes = base64ToBytes(base64Png);
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;

  // OffscreenCanvas — required for service workers.
  // The constructor is available since Chrome 94; older browsers would
  // fail here, and we'd fall back. For now, we surface a clean error.
  let canvas: OffscreenCanvas;
  try {
    canvas = new OffscreenCanvas(width, height);
  } catch (err) {
    throw new Error(`OffscreenCanvas unavailable — requires Chrome 94+: ${(err as Error).message}`);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // 1. Paint the original PNG as the base layer.
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  // 2. Sort anchors by area (descending) so large boxes draw first
  //    and don't fully cover small ones.
  const sorted = [...anchors].sort((a, b) => areaOf(b.boundingRect!) - areaOf(a.boundingRect!));

  let drawn = 0;
  for (const a of sorted) {
    const r = a.boundingRect!;
    // Skip if the rect is completely off-canvas.
    if (r.x + r.width < 0 || r.y + r.height < 0 || r.x > width || r.y > height) continue;
    // Clamp to image bounds for drawing.
    const x = Math.max(0, Math.round(r.x));
    const y = Math.max(0, Math.round(r.y));
    const w = Math.min(width - x, Math.round(r.width));
    const h = Math.min(height - y, Math.round(r.height));
    if (w <= 0 || h <= 0) continue;

    // Box stroke.
    const stroke = colorForTag(a.tag, opts.colorByType);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    if (opts.mode === "anchors_only") {
      drawn++;
      continue;
    }

    // Label text.
    const labelText = buildLabel(a, opts.mode);
    if (!labelText) {
      drawn++;
      continue;
    }

    // Pill background.
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    const metrics = ctx.measureText(labelText);
    const padX = 5;
    const padY = 3;
    const pillW = Math.ceil(metrics.width) + padX * 2;
    const pillH = 16;
    const pillX = x;
    const pillY = Math.max(0, y - pillH);

    ctx.fillStyle = opts.labelBackground;
    ctx.fillRect(pillX, pillY, pillW, pillH);
    // Pill border in the same colour as the box.
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(pillX + 0.5, pillY + 0.5, pillW - 1, pillH - 1);

    // Label text.
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(labelText, pillX + padX, pillY + pillH / 2 + 0.5);
    drawn++;
  }

  // 3. Re-encode as PNG.
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const outBuf = await outBlob.arrayBuffer();
  return bytesToBase64(new Uint8Array(outBuf));
}

function buildLabel(a: InspectAnchor, mode: OverlayMode): string {
  const parts: string[] = [];
  if (mode === "labels" || mode === "both") {
    const tag = a.tag || "?";
    const id = a.ariaLabel || a.text || a.type || "";
    const trimmed = id.length > 30 ? id.slice(0, 27) + "…" : id;
    parts.push(`${a.anchor} ${tag}${trimmed ? "#" + trimmed : ""}`);
  }
  if (mode === "coords" || mode === "both") {
    if (a.center) parts.push(`(${a.center.x}, ${a.center.y})`);
  }
  return parts.join(" ");
}

function areaOf(r: { width: number; height: number }): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

// ── Tiny base64 ↔ bytes helpers (browser-native atob/btoa) ──

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
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}
