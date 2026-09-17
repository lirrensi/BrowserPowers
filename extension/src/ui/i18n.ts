/**
 * FILE: extension/src/ui/i18n.ts
 * PURPOSE: Minimal en/de locale resolution, translation, and static-DOM application for the popup + options UI.
 * OWNS: Locale state (localStorage `bp:locale` -> navigator.language -> en), t() with {var} interpolation, applyStaticI18n().
 * EXPORTS: SUPPORTED_LOCALES, Locale, t, getLocale, setLocale, initI18n, applyStaticI18n
 */

import { STRINGS } from "./locales";

export const SUPPORTED_LOCALES = ["en", "de", "es", "fr", "ru", "zh", "ar"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

const STORAGE_KEY = "bp:locale";

/** Locales rendered right-to-left. */
const RTL_LOCALES: readonly string[] = ["ar"];

let current: Locale = "en";

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Mirror locale to <html lang dir> when a DOM is present; no-op in workers/tests. */
function syncDocumentLocale(): void {
  try {
    const g: unknown = globalThis;
    if (!g || typeof g !== "object" || !("document" in g)) return;
    const doc: unknown = g.document;
    if (!doc || typeof doc !== "object" || !("documentElement" in doc)) return;
    const el: unknown = doc.documentElement;
    if (!el || typeof el !== "object") return;
    if ("lang" in el) el.lang = current;
    if ("dir" in el) el.dir = RTL_LOCALES.includes(current) ? "rtl" : "ltr";
  } catch {
    // Non-DOM runtime — in-memory locale still applies.
  }
}

function readStored(): Locale | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

function readNavigatorLanguage(): string | null {
  try {
    const scope: unknown = globalThis;
    if (!scope || typeof scope !== "object" || !("navigator" in scope)) return null;
    const nav: unknown = scope.navigator;
    if (!nav || typeof nav !== "object" || !("language" in nav)) return null;
    return typeof nav.language === "string" ? nav.language : null;
  } catch {
    return null;
  }
}

function detectNavigator(): Locale | null {
  const lang = readNavigatorLanguage();
  if (!lang) return null;
  const prefix = lang.split(/[-_]/)[0]?.toLowerCase();
  return isLocale(prefix) ? prefix : null;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Current in-memory locale (defaults `en` until `initI18n()` or `setLocale()` runs). */
export function getLocale(): Locale {
  return current;
}

/** Set the active locale; unsupported values are ignored. Persists to localStorage when available. */
export function setLocale(l: Locale): void {
  if (!isLocale(l)) return;
  current = l;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // Storage unavailable (e.g. node/vitest) — in-memory locale still applies.
  }
  syncDocumentLocale();
}

/** Resolve the active locale: stored `bp:locale` -> navigator.language prefix -> `en`. */
export function initI18n(): Locale {
  const stored = readStored();
  if (stored) {
    current = stored;
    syncDocumentLocale();
    return current;
  }
  current = detectNavigator() ?? "en";
  syncDocumentLocale();
  return current;
}

/** Translate a key with optional {var} interpolation; missing keys fall back to the key itself. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = STRINGS[current];
  const template = dict?.[key] ?? STRINGS.en[key] ?? key;
  return interpolate(template, vars);
}

function resolveScope(root?: ParentNode): ParentNode | null {
  if (root) return root;
  try {
    const scope: unknown = globalThis;
    if (!scope || typeof scope !== "object" || !("document" in scope)) return null;
    const doc: unknown = scope.document;
    if (!doc || typeof doc !== "object" || !("querySelectorAll" in doc)) return null;
    return doc as ParentNode;
  } catch {
    return null;
  }
}

function collectTargets(scope: ParentNode, attr: string): Element[] {
  const out: Element[] = [];
  const isSelf =
    typeof scope === "object" &&
    scope !== null &&
    "getAttribute" in scope &&
    typeof scope.getAttribute === "function";
  if (isSelf) {
    const self = scope as Element;
    if (self.hasAttribute(attr)) out.push(self);
  }
  try {
    const found = scope.querySelectorAll(`[${attr}]`);
    for (const el of Array.from(found)) out.push(el);
  } catch {
    // Non-DOM ParentNode — descendants unavailable, self-match above still applies.
  }
  return out;
}

/** Apply translations to `data-i18n*` attributes under `root` (defaults to document). Safe to re-run. */
export function applyStaticI18n(root?: ParentNode): void {
  const scope = resolveScope(root);
  if (!scope) return;

  for (const el of collectTargets(scope, "data-i18n")) {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  }
  for (const el of collectTargets(scope, "data-i18n-ph")) {
    const key = el.getAttribute("data-i18n-ph");
    if (key) el.setAttribute("placeholder", t(key));
  }
  for (const el of collectTargets(scope, "data-i18n-title")) {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.setAttribute("title", t(key));
  }
  for (const el of collectTargets(scope, "data-i18n-aria")) {
    const key = el.getAttribute("data-i18n-aria");
    if (key) el.setAttribute("aria-label", t(key));
  }
}
