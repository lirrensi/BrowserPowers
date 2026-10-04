/**
 * FILE: core/src/annotations.ts
 * PURPOSE: Human-originated page annotations ("click-clack notes") — per-browser
 *          append-only store. The extension pushes drafts over WS (`annotation`
 *          message); agents read/clear via MCP/REST/CLI (core-local, no browser
 *          round-trip, works while the browser sleeps).
 * OWNS: Annotation shape, validation, in-memory map + best-effort JSON
 *       persistence, list/clear with tab scoping (many tabs per browser).
 * EXPORTS: Annotation, AnnotationDraft, addAnnotation, listAnnotations,
 *          clearAnnotations, countAnnotations, resetAnnotationsForTests
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type AnnotationKind = "element" | "screenshot";

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Payload the extension sends (tabId required — many tabs per browser). */
export interface AnnotationDraft {
  kind: AnnotationKind;
  comment: string;
  tabId: number;
  url?: string;
  title?: string;
  windowId?: number;
  selector?: string;
  tag?: string;
  text?: string;
  role?: string;
  rect?: AnnotationRect;
  selectedText?: string;
  region?: AnnotationRect & { viewportWidth: number; viewportHeight: number; dpr: number };
  /** Region mode: best-effort element under the drag start (hint only). */
  regionElement?: { selector?: string; tag?: string; text?: string };
  /** SW-stamped crop output size (PNG px). */
  crop?: { width: number; height: number };
  /** Crop failed mid-flight — note carries the full-tab screenshot instead. */
  cropError?: string;
  /** Transport-only: WS layer saves it via saveScreenshotToTemp, stores path. */
  screenshotBase64?: string;
  /** Set by the WS layer after saving the screenshot file. */
  screenshotPath?: string;
}

export interface Annotation extends Omit<AnnotationDraft, "screenshotBase64"> {
  id: string;
  browserId: string;
  createdAt: number;
}

const MAX_COMMENT = 4000;
const MAX_SELECTOR = 2000;
const MAX_TEXT = 2000;

function annotationsDir(): string {
  const override = process.env.BROWSERPOWERS_HOME?.trim();
  if (override) return join(override, "annotations");
  return join(homedir(), ".config", "browserpowers", "annotations");
}

function annotationsFile(): string {
  return join(annotationsDir(), "annotations.json");
}

/** browserId → annotations in arrival order. */
const store = new Map<string, Annotation[]>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const f = annotationsFile();
    if (!existsSync(f)) return;
    const raw = readFileSync(f, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, Annotation[]>;
    if (parsed && typeof parsed === "object") {
      for (const [browserId, list] of Object.entries(parsed)) {
        if (typeof browserId === "string" && Array.isArray(list)) {
          store.set(browserId, list.filter(isAnnotation));
        }
      }
    }
  } catch {
    // Corrupt/unreadable file — start empty, next persist overwrites.
  }
}

function isAnnotation(v: unknown): v is Annotation {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    typeof a.browserId === "string" &&
    typeof a.comment === "string" &&
    typeof a.tabId === "number" &&
    (a.kind === "element" || a.kind === "screenshot")
  );
}

function persist(): void {
  try {
    const dir = annotationsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: Record<string, Annotation[]> = {};
    for (const [k, v] of store) obj[k] = v;
    writeFileSync(annotationsFile(), JSON.stringify(obj), "utf-8");
  } catch {
    // Best-effort — annotations stay in memory even if disk fails.
  }
}

function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

/**
 * Validate + store one annotation. browserId is authoritative from the WS
 * connection (never trust a client-supplied browser id).
 */
export function addAnnotation(browserId: string, draft: AnnotationDraft): Annotation {
  if (!browserId || typeof browserId !== "string") throw new Error("annotation requires browserId");
  if (!draft || typeof draft !== "object") throw new Error("annotation requires a payload");
  if (draft.kind !== "element" && draft.kind !== "screenshot") {
    throw new Error(`annotation kind must be "element" | "screenshot" (got ${String((draft as { kind?: unknown }).kind)})`);
  }
  const comment = typeof draft.comment === "string" ? draft.comment.trim() : "";
  if (!comment) throw new Error("annotation requires a non-empty comment");
  if (!Number.isInteger(draft.tabId) || (draft.tabId as number) < 0) {
    throw new Error("annotation requires an integer tabId");
  }
  if (draft.kind === "element" && !draft.selector && !draft.text) {
    throw new Error('element annotation requires "selector" or "text"');
  }
  if (draft.kind === "screenshot" && draft.regionElement && !draft.selector && !draft.text && !draft.region) {
    // Region draft with element hint but no clone of element fields:
    // resolve the hint into real selector/text so plain `annotations list`
    // readers see WHERE the region is without learning regionElement.
    const re = draft.regionElement as unknown as Record<string, unknown>;
    if (typeof re.selector === "string" && re.selector.trim()) draft = { ...draft, selector: re.selector.trim().slice(0, MAX_SELECTOR) };
    if (typeof re.tag === "string" && re.tag.trim()) draft = { ...draft, tag: re.tag.trim().slice(0, 40) };
    if (typeof re.text === "string" && re.text.trim()) draft = { ...draft, text: re.text.trim().slice(0, MAX_TEXT) };
  }

  ensureLoaded();
  const ann: Annotation = {
    id: `ann_${randomUUID().slice(0, 8)}`,
    browserId,
    kind: draft.kind,
    comment: comment.slice(0, MAX_COMMENT),
    tabId: draft.tabId,
    createdAt: Date.now(),
  };
  const url = cleanString(draft.url, 2000);
  if (url) ann.url = url;
  const title = cleanString(draft.title, 500);
  if (title) ann.title = title;
  if (Number.isInteger(draft.windowId)) ann.windowId = draft.windowId;
  const selector = cleanString(draft.selector, MAX_SELECTOR);
  if (selector) ann.selector = selector;
  const tag = cleanString(draft.tag, 40);
  if (tag) ann.tag = tag;
  const text = cleanString(draft.text, MAX_TEXT);
  if (text) ann.text = text;
  const role = cleanString(draft.role, 60);
  if (role) ann.role = role;
  if (draft.rect && typeof draft.rect === "object") {
    const r = draft.rect as unknown as Record<string, unknown>;
    if ([r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
      ann.rect = { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
    }
  }
  const selectedText = cleanString(draft.selectedText, MAX_TEXT);
  if (selectedText) ann.selectedText = selectedText;
  if (draft.region && typeof draft.region === "object") {
    const g = draft.region as unknown as Record<string, unknown>;
    if ([g.x, g.y, g.width, g.height, g.viewportWidth, g.viewportHeight, g.dpr].every((n) => typeof n === "number" && Number.isFinite(n))) {
      ann.region = { x: g.x as number, y: g.y as number, width: g.width as number, height: g.height as number, viewportWidth: g.viewportWidth as number, viewportHeight: g.viewportHeight as number, dpr: g.dpr as number };
    }
  }
  if (draft.regionElement && typeof draft.regionElement === "object") {
    const re = draft.regionElement as unknown as Record<string, unknown>;
    const rs = cleanString(re.selector, MAX_SELECTOR);
    const rt = cleanString(re.tag, 40);
    const rx = cleanString(re.text, 200);
    if (rs || rt || rx) ann.regionElement = { ...(rs ? { selector: rs } : {}), ...(rt ? { tag: rt } : {}), ...(rx ? { text: rx } : {}) };
  }
  if (draft.crop && typeof draft.crop === "object") {
    const cp = draft.crop as unknown as Record<string, unknown>;
    if (typeof cp.width === "number" && typeof cp.height === "number" && Number.isFinite(cp.width) && Number.isFinite(cp.height)) {
      ann.crop = { width: cp.width, height: cp.height };
    }
  }
  const cropError = cleanString(draft.cropError, 300);
  if (cropError) ann.cropError = cropError;
  const screenshotPath = cleanString(draft.screenshotPath, 1000);
  if (screenshotPath) ann.screenshotPath = screenshotPath;

  const list = store.get(browserId) ?? [];
  list.push(ann);
  store.set(browserId, list);
  persist();
  return ann;
}

/** List annotations for one browser, optionally scoped to a single tab. */
export function listAnnotations(browserId: string, opts?: { tabId?: number }): Annotation[] {
  ensureLoaded();
  const list = store.get(browserId) ?? [];
  if (opts?.tabId !== undefined) return list.filter((a) => a.tabId === opts.tabId);
  return [...list];
}

export function countAnnotations(browserId: string): { total: number; byTab: Record<number, number> } {
  ensureLoaded();
  const byTab: Record<number, number> = {};
  const list = store.get(browserId) ?? [];
  for (const a of list) byTab[a.tabId] = (byTab[a.tabId] ?? 0) + 1;
  return { total: list.length, byTab };
}

/**
 * Clear annotations. Exactly one scope: ids (explicit ack after the agent
 * consumed them), tabId (whole tab done), or all (default when neither given).
 */
export function clearAnnotations(
  browserId: string,
  opts?: { ids?: string[]; tabId?: number },
): { cleared: number; remaining: number } {
  ensureLoaded();
  const list = store.get(browserId) ?? [];
  if (list.length === 0) return { cleared: 0, remaining: 0 };
  let kept: Annotation[];
  if (opts?.ids && opts.ids.length > 0) {
    const ids = new Set(opts.ids);
    kept = list.filter((a) => !ids.has(a.id));
  } else if (opts?.tabId !== undefined) {
    kept = list.filter((a) => a.tabId !== opts.tabId);
  } else {
    kept = [];
  }
  const cleared = list.length - kept.length;
  store.set(browserId, kept);
  persist();
  return { cleared, remaining: kept.length };
}

/** Test-only: wipe memory + skip disk reload on next call. */
export function resetAnnotationsForTests(): void {
  store.clear();
  loaded = true;
}
