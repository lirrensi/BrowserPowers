// Mechanism-only tests for the extension i18n contract (src/ui/i18n.ts).
// Never assert an exhaustive key list: unknown keys fall back to the key
// itself, so these stay green while dictionaries grow in parallel.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SUPPORTED_LOCALES, t } from "../../src/ui/i18n.js";
import type { Locale } from "../../src/ui/i18n.js";
import type * as I18nApi from "../../src/ui/i18n.js";

const LS_KEY = "bp:locale";

// Await import() is intentional here: the i18n module caches the active
// locale at load, so each stateful test needs a fresh module instance loaded
// AFTER its localStorage/navigator stubs are installed. Static imports cannot
// provide that isolation.
interface FakeStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  clear(): void;
}

function makeLocalStorage(initial: Record<string, string> = {}): FakeStorage {
  let store: Record<string, string> = { ...initial };
  return {
    getItem(k: string): string | null {
      return Object.hasOwn(store, k) ? store[k] : null;
    },
    setItem(k: string, v: string): void {
      store[k] = String(v);
    },
    removeItem(k: string): void {
      delete store[k];
    },
    clear(): void {
      store = {};
    },
  };
}

// Narrow view of the globals these tests stub; `as unknown as TestGlobals`
// below is the sanctioned unchecked cast for values the compiler lost track of.
interface TestGlobals {
  localStorage?: FakeStorage;
  navigator?: { language: string };
  HTMLElement?: unknown;
  HTMLInputElement?: unknown;
  HTMLTextAreaElement?: unknown;
}

interface StoredOpts {
  stored?: string;
  lang?: string;
}
async function fresh(opts: StoredOpts = {}): Promise<{ api: typeof I18nApi; ls: FakeStorage }> {
  vi.resetModules();
  const ls = makeLocalStorage(opts.stored === undefined ? {} : { [LS_KEY]: opts.stored });
  // Direct assignment fails: these globals are getter-only in some runtimes.
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: { language: opts.lang ?? "en-US" },
    configurable: true,
    writable: true,
  });
  const api = await import("../../src/ui/i18n.js");
  return { api, ls };
}

// Minimal detached-DOM fake. Supports BOTH access styles the implementation
// might use (dataset vs getAttribute reads; property vs setAttribute writes)
// so the tests pin the contract, not an implementation detail.
class FakeBase {}

class FakeEl extends FakeBase {
  tagName: string;
  textContent: string | null = "";
  placeholder = "";
  title = "";
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  private attrs: Record<string, string> = {};

  constructor(tag = "DIV", attrs: Record<string, string> = {}) {
    super();
    this.tagName = tag;
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }

  getAttribute(name: string): string | null {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
    if (name.startsWith("data-")) {
      const key = name
        .slice("data-".length)
        .split("-")
        .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1)))
        .join("");
      this.dataset[key] = value;
    }
    if (name === "placeholder") this.placeholder = value;
    if (name === "title") this.title = value;
  }

  removeAttribute(name: string): void {
    delete this.attrs[name];
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attrs, name);
  }

  get ariaLabel(): string | null {
    return this.getAttribute("aria-label");
  }

  set ariaLabel(v: string | null) {
    if (v === null) this.removeAttribute("aria-label");
    else this.setAttribute("aria-label", v);
  }

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector: string): FakeEl[] {
    const parts = selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const out: FakeEl[] = [];
    const walk = (el: FakeEl): void => {
      for (const child of el.children) {
        if (parts.some((p) => matchesPart(child, p))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  matches(selector: string): boolean {
    return selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .some((p) => matchesPart(this, p));
  }
}

function matchesPart(el: FakeEl, part: string): boolean {
  if (part === "*") return true;
  const m = part.match(/\[([^\]=\s]+)/);
  if (!m) return false;
  return el.getAttribute(m[1]) !== null;
}

const origLSDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const origNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const g = globalThis as unknown as TestGlobals;
const OrigHTMLElement = g.HTMLElement;
const OrigInput = g.HTMLInputElement;
const OrigTextArea = g.HTMLTextAreaElement;

beforeEach(() => {
  // Satisfy `instanceof HTMLElement`-style guards regardless of which exact
  // global the implementation checks. defineProperty: globals may be getter-only.
  for (const key of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"] as const) {
    Object.defineProperty(globalThis, key, { value: FakeBase, configurable: true, writable: true });
  }
});

afterEach(() => {
  if (origLSDescriptor) Object.defineProperty(globalThis, "localStorage", origLSDescriptor);
  else delete (globalThis as unknown as TestGlobals).localStorage;
  if (origNavDescriptor) Object.defineProperty(globalThis, "navigator", origNavDescriptor);
  else delete (globalThis as unknown as TestGlobals).navigator;
  // Direct assignment fails where these are getter-only; restore or remove.
  const domGlobals = [
    ["HTMLElement", OrigHTMLElement],
    ["HTMLInputElement", OrigInput],
    ["HTMLTextAreaElement", OrigTextArea],
  ] as const;
  for (const [key, original] of domGlobals) {
    if (original === undefined) delete (globalThis as unknown as TestGlobals)[key];
    else Object.defineProperty(globalThis, key, { value: original, configurable: true, writable: true });
  }
  vi.resetModules();
});

describe("i18n contract", () => {
  it("supports en, de, es, fr, ru, zh, ar", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "de", "es", "fr", "ru", "zh", "ar"]);
  });

  it("falls back to the key for unknown keys", () => {
    expect(t("some.key.that.does.not.exist")).toBe("some.key.that.does.not.exist");
  });

  it("interpolates {vars} even on fallback keys", () => {
    expect(t("missing.key {name} x{n}", { name: "Ada", n: 42 })).toBe("missing.key Ada x42");
  });

  it("rejects unsupported locales in setLocale", async () => {
    const { api, ls } = await fresh();
    // Intentionally invalid input: the contract requires rejection.
    api.setLocale("xx" as unknown as Locale);
    expect(api.getLocale()).toBe("en");
    expect(ls.getItem(LS_KEY)).toBeNull();
  });

  it("setLocale persists and getLocale reads it back", async () => {
    const { api, ls } = await fresh();
    api.setLocale("de");
    expect(api.getLocale()).toBe("de");
    expect(ls.getItem(LS_KEY)).toBe("de");
    // A fresh module (simulating reload) resolves the persisted value.
    vi.resetModules();
    const reloaded = await import("../../src/ui/i18n.js");
    expect(reloaded.initI18n()).toBe("de");
    expect(reloaded.getLocale()).toBe("de");
  });

  it("initI18n picks up a stored locale", async () => {
    const { api } = await fresh({ stored: "de" });
    expect(api.initI18n()).toBe("de");
    expect(api.getLocale()).toBe("de");
  });

  it("falls back to navigator.language when nothing is stored", async () => {
    for (const [lang, want] of [
      ["de", "de"], ["de-DE", "de"], ["de_DE", "de"],
      ["es-ES", "es"], ["fr-FR", "fr"], ["ru-RU", "ru"],
      ["zh-CN", "zh"], ["zh_TW", "zh"], ["ar-EG", "ar"],
    ] as const) {
      const { api } = await fresh({ lang });
      expect(api.initI18n()).toBe(want);
    }
  });

  it("falls back to en for unsupported navigator languages", async () => {
    const { api } = await fresh({ lang: "xx-YY" });
    expect(api.initI18n()).toBe("en");
  });

  it("round-trips every supported locale through setLocale", async () => {
    const { api, ls } = await fresh();
    for (const locale of SUPPORTED_LOCALES) {
      api.setLocale(locale);
      expect(api.getLocale()).toBe(locale);
      expect(ls.getItem(LS_KEY)).toBe(locale);
    }
  });

  it("ships full en-parity dictionaries for every locale", async () => {
    const { STRINGS } = await import("../../src/ui/locales.js");
    const enKeys = Object.keys(STRINGS.en).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(STRINGS[locale]).sort()).toEqual(enKeys);
      for (const key of enKeys) {
        expect(typeof STRINGS[locale][key]).toBe("string");
        expect(STRINGS[locale][key].length).toBeGreaterThan(0);
      }
    }
  });

  it("applyStaticI18n translates text, placeholder, title and aria-label", async () => {
    const { api } = await fresh();
    const root = new FakeEl("DIV");
    const text = new FakeEl("P", { "data-i18n": "test.text.key" });
    text.textContent = "ORIGINAL";
    const input = new FakeEl("INPUT", { "data-i18n-ph": "test.ph.key" });
    const titled = new FakeEl("SPAN", { "data-i18n-title": "test.title.key" });
    const labelled = new FakeEl("BUTTON", { "data-i18n-aria": "test.aria.key" });
    root.appendChild(text);
    root.appendChild(input);
    root.appendChild(titled);
    root.appendChild(labelled);

    // FakeEl is a structural stand-in: the implementation only needs
    // querySelectorAll/getAttribute plus property writes.
    api.applyStaticI18n(root as unknown as ParentNode);

    expect(text.textContent).toBe(api.t("test.text.key"));
    expect(text.textContent).not.toBe("ORIGINAL");
    expect(input.placeholder).toBe(api.t("test.ph.key"));
    expect(titled.title).toBe(api.t("test.title.key"));
    expect(labelled.getAttribute("aria-label")).toBe(api.t("test.aria.key"));
  });

  it("applyStaticI18n is idempotent", async () => {
    const { api } = await fresh();
    const root = new FakeEl("DIV");
    const text = new FakeEl("P", { "data-i18n": "test.text.key" });
    text.textContent = "ORIGINAL";
    const input = new FakeEl("INPUT", { "data-i18n-ph": "test.ph.key" });
    root.appendChild(text);
    root.appendChild(input);

    // Same structural stand-in rationale as the translation test above.
    api.applyStaticI18n(root as unknown as ParentNode);
    const afterFirst = [text.textContent, input.placeholder];
    api.applyStaticI18n(root as unknown as ParentNode);

    expect([text.textContent, input.placeholder]).toEqual(afterFirst);
  });
});
