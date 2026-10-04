/**
 * FILE: extension/src/annotate/picker.ts
 * PURPOSE: Human-first element picker — hover outline + click-to-annotate
 *          overlay that runs inside the page (isolated world, shadow DOM so
 *          page CSS can never break it). Builds a rich draft (selector, rect,
 *          text, role, selected text, url/title) and hands it to the SW via
 *          chrome.runtime.sendMessage ({ type: "bp:annotation" }).
 * OWNS: Picker lifecycle (arm/disarm/status), draft construction.
 * EXPORTS: armPicker, disarmPicker, isPickerArmed, buildElementDraft
 */

export type PickerMode = "element" | "region";

export interface PickerRegion {
  /** Viewport-space rect in CSS px (what the human dragged). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Viewport size at drag time — lets the SW map region → PNG px. */
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
}

export interface PickerDraft {
  kind: "element" | "screenshot";
  comment?: string;
  url?: string;
  title?: string;
  selector?: string;
  tag?: string;
  text?: string;
  role?: string;
  rect?: { x: number; y: number; width: number; height: number };
  selectedText?: string;
  /** Region mode: dragged viewport rect — SW crops the screenshot to it. */
  region?: PickerRegion;
  /** Region mode: best-effort element under the drag start (agent hint only). */
  regionElement?: { selector?: string; tag?: string; text?: string };
}
let mode: PickerMode = "element";
let dragStart: { x: number; y: number } | null = null;
let dragBox: HTMLElement | null = null;
let dragEl: Element | null = null;
const HOST_ID = "browserpowers-annotate-host";
const HIGHLIGHT_COLOR = "#a855f7";

let armed = false;
let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let box: HTMLElement | null = null;
let label: HTMLElement | null = null;
let banner: HTMLElement | null = null;
let toast: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function isPickerArmed(): boolean {
  return armed;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Same unique-selector strategy as content-actions cssPath(): id wins, else nth-of-type chain. */
export function cssPathFor(el: Element): string | undefined {
  try {
    const id = el.getAttribute("id");
    if (id && /^[A-Za-z][\w:.-]*$/.test(id)) {
      if (typeof CSS !== "undefined" && CSS.escape) return "#" + CSS.escape(id);
      return "#" + id;
    }
    const parts: string[] = [];
    let cur: Element | null = el;
    const doc = el.ownerDocument ?? document;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const t = cur.tagName.toLowerCase();
      if (cur === doc.body || cur === doc.documentElement) { parts.unshift(t); break; }
      let nth = 1;
      let sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName.toLowerCase() === t) nth++; sib = sib.previousElementSibling; }
      parts.unshift(nth > 1 ? `${t}:nth-of-type(${nth})` : t);
      cur = cur.parentElement;
    }
    return parts.length > 0 ? parts.join(" > ") : undefined;
  } catch {
    return undefined;
  }
}

function selectedNow(): string {
  try {
    return (window.getSelection()?.toString() ?? "").trim().slice(0, 2000);
  } catch {
    return "";
  }
}

/** Build the element half of a draft — pure DOM read, no overlay needed. */
export function buildElementDraft(el: Element): PickerDraft {
  const tag = el.tagName.toLowerCase();
  const text = (el.textContent || "").trim().slice(0, 500);
  const draft: PickerDraft = {
    kind: "element",
    url: location.href,
    title: document.title || undefined,
    selector: cssPathFor(el),
    tag,
    text: text || undefined,
    role: el.getAttribute("role") || undefined,
  };
  try {
    const r = el.getBoundingClientRect();
    if (Number.isFinite(r.width) && Number.isFinite(r.height)) {
      draft.rect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }
  } catch { /* rect best-effort */ }
  const sel = selectedNow();
  if (sel) draft.selectedText = sel;
  return draft;
}

function ensureHost(): ShadowRoot | null {
  try {
    if (host && host.isConnected && shadow) return shadow;
    disarmDom();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    shadow = root;
    const style = document.createElement("style");
    style.textContent = [
      ".box{position:fixed;border:2px solid " + HIGHLIGHT_COLOR + ";background:rgba(168,85,247,.12);pointer-events:none;display:none;}",
      ".tag{position:fixed;background:" + HIGHLIGHT_COLOR + ";color:#fff;font:11px/1.4 monospace;padding:2px 6px;border-radius:4px;pointer-events:none;display:none;white-space:nowrap;}",
      ".dragbox{position:fixed;border:2px dashed #22c55e;background:rgba(34,197,94,.15);pointer-events:none;display:none;}",
      ".draghint{position:fixed;background:#22c55e;color:#052e16;font:11px/1.4 monospace;padding:2px 6px;border-radius:4px;pointer-events:none;display:none;white-space:nowrap;}",
      ".banner{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#18181b;color:#fafafa;border:1px solid " + HIGHLIGHT_COLOR + ";border-radius:8px;padding:8px 12px;font:13px/1.4 system-ui,sans-serif;pointer-events:none;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.5);}",
      ".banner b{color:#d8b4fe;}",
      ".toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#22c55e;color:#052e16;border-radius:8px;padding:8px 14px;font:13px/1.4 system-ui,sans-serif;pointer-events:none;display:none;box-shadow:0 4px 20px rgba(0,0,0,.5);}",
      ".dlg{position:fixed;right:16px;bottom:16px;width:340px;background:#18181b;color:#fafafa;border:2px solid " + HIGHLIGHT_COLOR + ";border-radius:10px;padding:12px;font:13px/1.45 system-ui,sans-serif;pointer-events:auto;box-shadow:0 8px 32px rgba(0,0,0,.6);}",
      ".dlg h4{margin:0 0 6px;font-size:13px;color:#e9d5ff;font-weight:700;}",
      ".dlg .sel{font:11px monospace;color:#c4b5fd;word-break:break-all;margin-bottom:8px;}",
      ".dlg .pg{font:11px system-ui;color:#a1a1aa;word-break:break-all;margin-bottom:8px;}",
      ".dlg textarea{width:100%;box-sizing:border-box;min-height:72px;background:#27272a;color:#fafafa;border:1px solid #a855f7;border-radius:6px;padding:8px;font:14px system-ui;resize:vertical;}",
      ".dlg textarea:focus{outline:2px solid " + HIGHLIGHT_COLOR + ";}",
      ".dlg .row{display:flex;gap:8px;margin-top:10px;justify-content:flex-end;}",
      ".dlg button{border:0;border-radius:6px;padding:7px 14px;font:13px system-ui;cursor:pointer;}",
      ".dlg .send{background:" + HIGHLIGHT_COLOR + ";color:#fff;font-weight:700;}",
      ".dlg .cancel{background:#3f3f46;color:#fafafa;}",
    ].join("");
    root.appendChild(style);
    box = document.createElement("div");
    box.className = "box";
    label = document.createElement("div");
    label.className = "tag";
    dragBox = document.createElement("div");
    dragBox.className = "dragbox";
    banner = document.createElement("div");
    banner.className = "banner";
    setBanner();
    toast = document.createElement("div");
    toast.className = "toast";
    root.appendChild(box);
    root.appendChild(label);
    root.appendChild(dragBox);
    root.appendChild(banner);
    root.appendChild(toast);
    document.documentElement.appendChild(host);
    return root;
  } catch {
    return null;
  }
}

function setBanner(): void {
  if (!banner) return;
  banner.innerHTML = mode === "region"
    ? "<b>SCREENSHOT MODE</b> — drag a rectangle over the page, then type your note · <b>Esc</b> exits"
    : "<b>ANNOTATE MODE</b> — click any element to leave a note · <b>Esc</b> exits";
}

export function setPickerMode(m: PickerMode): PickerMode {
  mode = m;
  dragStart = null;
  dragEl = null;
  if (dragBox) dragBox.style.display = "none";
  hideBox();
  setBanner();
  return mode;
}

export function getPickerMode(): PickerMode {
  return mode;
}

/** Region draft: dragged viewport rect + best-effort element under drag start. */
export function buildRegionDraft(rect: { x: number; y: number; width: number; height: number }, el: Element | null): PickerDraft {
  const draft: PickerDraft = {
    kind: "screenshot",
    region: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportWidth: typeof window !== "undefined" ? window.innerWidth : 0,
      viewportHeight: typeof window !== "undefined" ? window.innerHeight : 0,
      dpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    },
  };
  try {
    if (typeof location !== "undefined") draft.url = location.href;
    if (typeof document !== "undefined" && document.title) draft.title = document.title;
  } catch { /* globals unavailable in unit tests — url/title stay unset */ }
  if (el) {
    const text = ((el as { textContent?: unknown }).textContent as string || "").trim().slice(0, 200);
    const tag = typeof (el as { tagName?: unknown }).tagName === "string" ? ((el as { tagName: string }).tagName.toLowerCase()) : undefined;
    draft.regionElement = {
      selector: cssPathFor(el),
      tag,
      text: text || undefined,
    };
  }
  return draft;
}

function showBox(el: Element): void {
  if (!box || !label) return;
  try {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    const name = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "");
    label.style.display = "block";
    label.textContent = name;
    label.style.left = `${Math.max(0, r.left)}px`;
    label.style.top = `${Math.max(0, r.top - 22)}px`;
  } catch { /* hover highlight never breaks the page */ }
}

function hideBox(): void {
  if (box) box.style.display = "none";
  if (label) label.style.display = "none";
}

function hideBanner(): void {
  if (banner) banner.style.display = "none";
}

function showBanner(): void {
  if (banner && armed) banner.style.display = "";
}

function flashToast(msg: string): void {
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toast) toast.style.display = "none"; }, 2200);
}

function openDialog(root: ShadowRoot, draft: PickerDraft, opts?: { title?: string; sub?: string; toast?: string }): void {
  const old = root.querySelector(".dlg");
  if (old) old.remove();
  const dlg = document.createElement("div");
  dlg.className = "dlg";
  const sel = draft.selector ?? draft.regionElement?.selector ?? "(no selector)";
  const page = draft.title ?? draft.url ?? "";
  dlg.innerHTML =
    `<h4>${opts?.title ?? "📝 Note for the agent — Esc cancels"}</h4>` +
    (page ? `<div class="pg">${escapeHtml(page.slice(0, 90))}</div>` : "") +
    (opts?.sub ?? `<div class="sel">${escapeHtml(sel.slice(0, 140))}</div>`) +
    `<textarea placeholder="Type what is wrong here, e.g. 'button overlaps headline on mobile'…"></textarea>` +
    `<div class="row"><button class="cancel">Cancel</button><button class="send">Send note ✓</button></div>`;
  root.appendChild(dlg);
  const area = dlg.querySelector("textarea") as HTMLTextAreaElement | null;
  const cancel = dlg.querySelector(".cancel") as HTMLButtonElement | null;
  // Clicks inside the dialog must not re-trigger the page picker.
  dlg.addEventListener("click", (e) => e.stopPropagation());
  dlg.addEventListener("mousedown", (e) => e.stopPropagation());
  try { area?.focus(); } catch { /* focus best-effort */ }
  cancel?.addEventListener("click", (e) => {
    e.stopPropagation();
    dlg.remove();
  });
  const submit = (): void => {
    const comment = (area?.value ?? "").trim();
    if (!comment) {
      try { area?.focus(); } catch { /* ignore */ }
      if (area) area.style.borderColor = "#ef4444";
      return;
    }
    dlg.remove();
    hideBox();
    hideDrag();
    hideBanner();
    // Let the browser paint the overlay removal BEFORE the draft leaves:
    // the SW captures on receipt, so the message must go out after paint
    // or the screenshot still contains our chrome. Two rAFs = style +
    // layout + paint flushed.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      onDraft?.({ ...draft, comment });
      showBanner();
    }));
    flashToast(opts?.toast ?? "✓ Note sent — click the next element");
  };
  const sendBtn = dlg.querySelector(".send") as HTMLButtonElement | null;
  sendBtn?.addEventListener("click", (e) => { e.stopPropagation(); submit(); });
  // Ctrl/Cmd+Enter sends without touching the mouse.
  area?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
  });
}

function showDrag(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; width: number; height: number } {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  if (dragBox) {
    dragBox.style.display = "block";
    dragBox.style.left = `${x}px`;
    dragBox.style.top = `${y}px`;
    dragBox.style.width = `${w}px`;
    dragBox.style.height = `${h}px`;
  }
  return { x, y, width: w, height: h };
}

function hideDrag(): void {
  if (dragBox) dragBox.style.display = "none";
  dragStart = null;
  dragEl = null;
}

function onMove(e: MouseEvent): void {
  if (!armed || mode !== "element") return;
  // Dialog open → freeze highlight, don't chase the cursor behind the dialog.
  if (shadow?.querySelector(".dlg")) return;
  const t = e.target as Element | null;
  if (!t || t === host || (host && host.contains(t))) return;
  if (t.nodeType !== 1) return;
  lastTarget = t;
  showBox(t);
}

function onClick(e: MouseEvent): void {
  if (!armed || mode !== "element") return;
  const t = e.target as Element | null;
  if (!t || t === host || (host && host.contains(t))) return;
  // Never annotate our own UI.
  if (t.closest && t.closest(`#${HOST_ID}`)) return;
  // Dialog open → ignore page clicks until Send/Cancel (dialog stops
  // propagation on its own clicks, but capture-phase page clicks arrive first).
  if (shadow?.querySelector(".dlg")) return;
  e.preventDefault();
  e.stopPropagation();
  const root = shadow;
  if (!root || !(t instanceof Element)) return;
  openDialog(root, buildElementDraft(t));
}

// ── Region mode: press-drag-release draws a dashed rect, dialog on release ──

function onRegionDown(e: MouseEvent): void {
  if (!armed || mode !== "region") return;
  if (e.button !== 0) return;
  if (shadow?.querySelector(".dlg")) return;
  const t = e.target as Element | null;
  if (t && (t === host || (host && host.contains(t)))) return;
  e.preventDefault();
  e.stopPropagation();
  dragStart = { x: e.clientX, y: e.clientY };
  dragEl = t instanceof Element ? t : null;
  showDrag(e.clientX, e.clientY, e.clientX, e.clientY);
}

function onRegionMove(e: MouseEvent): void {
  if (!armed || mode !== "region" || !dragStart) return;
  e.stopPropagation();
  showDrag(dragStart.x, dragStart.y, e.clientX, e.clientY);
}

function onRegionUp(e: MouseEvent): void {
  if (!armed || mode !== "region" || !dragStart) return;
  e.preventDefault();
  e.stopPropagation();
  const r = showDrag(dragStart.x, dragStart.y, e.clientX, e.clientY);
  const root = shadow;
  dragStart = null;
  // Tiny drag = misclick, not a region. Keep armed, no dialog.
  if (!root || r.width < 12 || r.height < 12) {
    hideDrag();
    return;
  }
  const draft = buildRegionDraft(r, dragEl);
  openDialog(root, draft, {
    title: "📷 Region note — Esc cancels",
    sub: `<div class="sel">${r.width}×${r.height}px region — screenshot is cropped to this box</div>`,
    toast: "✓ Region note sent — drag the next area",
  });
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    // Dialog open → Esc closes the dialog, picker stays armed for the next note.
    const dlg = shadow?.querySelector(".dlg");
    if (dlg) {
      dlg.remove();
      hideDrag();
      return;
    }
    disarmPicker();
  }
}

function disarmDom(): void {
  try { host?.remove(); } catch { /* ignore */ }
  host = null;
  shadow = null;
  box = null;
  label = null;
  dragBox = null;
  banner = null;
  toast = null;
  dragStart = null;
  dragEl = null;
  lastTarget = null;
}

/**
 * Arm the picker on the current page. draftCb fires once per submitted
 * note (element click → element draft; region drag → cropped screenshot
 * draft). Stays armed for sequential notes in the same mode.
 */
export function armPicker(draftCb: (draft: PickerDraft) => void, m: PickerMode = "element"): boolean {
  if (armed) {
    setPickerMode(m);
    onDraft = draftCb;
    return true;
  }
  mode = m;
  const root = ensureHost();
  if (!root) return false;
  onDraft = draftCb;
  armed = true;
  setBanner();
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", onRegionDown, true);
  document.addEventListener("mousemove", onRegionMove, true);
  document.addEventListener("mouseup", onRegionUp, true);
  document.addEventListener("keydown", onKey, true);
  return true;
}

export function disarmPicker(): void {
  if (!armed) return;
  armed = false;
  onDraft = null;
  document.removeEventListener("mousemove", onMove, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("mousedown", onRegionDown, true);
  document.removeEventListener("mousemove", onRegionMove, true);
  document.removeEventListener("mouseup", onRegionUp, true);
  document.removeEventListener("keydown", onKey, true);
  disarmDom();
}
export function lastHoverTarget(): Element | null {
  return lastTarget;
}
