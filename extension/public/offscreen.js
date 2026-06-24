/* FILE: extension/public/offscreen.js
   PURPOSE: Offscreen document host for the screenshot overlay.
            The service worker posts a request like:
              { type: "bp:overlay:render", requestId, pngBytes, anchors, options }
            and we draw the overlay on a real <canvas> and reply with:
              { type: "bp:overlay:result", requestId, pngBytes }
            or { type: "bp:overlay:error", requestId, error }.

            Runs in a real document context — has full DOM and canvas
            APIs. The SW has neither, which is why we exist.
*/

const TAG_COLORS = {
  button: "#3b82f6",   // blue
  input: "#22c55e",    // green
  textarea: "#22c55e", // green
  select: "#a855f7",   // purple
  a: "#f97316",        // orange
};
const DEFAULT_COLOR = "#9ca3af"; // gray

function colorForTag(tag, colorByType) {
  if (!colorByType) return DEFAULT_COLOR;
  return TAG_COLORS[String(tag || "").toLowerCase()] ?? DEFAULT_COLOR;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

function buildLabel(a, mode) {
  const parts = [];
  if (mode === "labels" || mode === "both") {
    const tag = a.tag || "?";
    const id = a.ariaLabel || a.text || a.type || "";
    const trimmed = id.length > 30 ? id.slice(0, 27) + "\u2026" : id;
    parts.push(`${a.anchor} ${tag}${trimmed ? "#" + trimmed : ""}`);
  }
  if ((mode === "coords" || mode === "both") && a.center) {
    parts.push(`(${a.center.x}, ${a.center.y})`);
  }
  return parts.join(" ");
}

function areaOf(r) {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

async function renderOverlay({ pngBase64, pngBytes, anchors, options }) {
  const canvas = document.getElementById("stage");
  // Prefer the base64 string — the round-trip through structured clone
  // can corrupt raw ArrayBuffer bytes. Fall back to pngBytes if missing.
  const bytes = pngBase64 ? base64ToBytes(pngBase64) : (pngBytes || []);
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  if (canvas.width === 0 || canvas.height === 0) {
    throw new Error(`offscreen canvas has zero size: ${canvas.width}x${canvas.height}`);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable in offscreen document");

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const mode = options.mode ?? "both";
  const colorByType = options.colorByType ?? true;
  const labelBg = options.labelBackground ?? "rgba(0,0,0,0.78)";

  const sorted = [...anchors].sort((a, b) => areaOf(b.boundingRect) - areaOf(a.boundingRect));

  let drawn = 0;
  for (const a of sorted) {
    const r = a.boundingRect;
    if (!r) continue;
    if (r.x + r.width < 0 || r.y + r.height < 0 || r.x > canvas.width || r.y > canvas.height) continue;
    const x = Math.max(0, Math.round(r.x));
    const y = Math.max(0, Math.round(r.y));
    const w = Math.min(canvas.width - x, Math.round(r.width));
    const h = Math.min(canvas.height - y, Math.round(r.height));
    if (w <= 0 || h <= 0) continue;

    const stroke = colorForTag(a.tag, colorByType);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    if (mode === "anchors_only") { drawn++; continue; }

    const labelText = buildLabel(a, mode);
    if (!labelText) { drawn++; continue; }

    ctx.font = "12px system-ui, -apple-system, sans-serif";
    const metrics = ctx.measureText(labelText);
    const padX = 5;
    const pillW = Math.ceil(metrics.width) + padX * 2;
    const pillH = 16;
    const pillX = x;
    const pillY = Math.max(0, y - pillH);

    ctx.fillStyle = labelBg;
    ctx.fillRect(pillX, pillY, pillW, pillH);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(pillX + 0.5, pillY + 0.5, pillW - 1, pillH - 1);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(labelText, pillX + padX, pillY + pillH / 2 + 0.5);
    drawn++;
  }

  const outBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error("toBlob returned null")), "image/png");
  });
  const outBuf = await outBlob.arrayBuffer();
  // Return as base64 string — sending a Uint8Array back across
  // chrome.runtime.sendMessage can fail in some Chrome versions.
  return { pngBase64: bytesToBase64(new Uint8Array(outBuf)), drawn };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "bp:overlay:render") return false;
  (async () => {
    try {
      const { pngBase64, drawn } = await renderOverlay({
        pngBase64: msg.pngBase64,
        pngBytes: msg.pngBytes,
        anchors: msg.anchors ?? [],
        options: msg.options ?? {},
      });
      sendResponse({ type: "bp:overlay:result", requestId: msg.requestId, pngBase64, drawn });
    } catch (err) {
      sendResponse({
        type: "bp:overlay:error",
        requestId: msg.requestId,
        error: (err && err.message) || String(err),
      });
    }
  })();
  return true; // keep the channel open for async sendResponse
});

// Tell the SW we're ready to receive messages.
chrome.runtime.sendMessage({ type: "bp:overlay:ready" }).catch(() => {});
