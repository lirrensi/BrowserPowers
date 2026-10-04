import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe("Annotations store", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("../../src/annotations.js");
    mod.resetAnnotationsForTests();
  });

  it("stores an element annotation with browser + tab identity", async () => {
    const { addAnnotation, listAnnotations } = await import("../../src/annotations.js");
    const ann = addAnnotation("b-1", {
      kind: "element",
      comment: "Button is cut off on mobile",
      tabId: 42,
      url: "https://example.com/checkout",
      selector: "body > main > button.cta",
      tag: "button",
      text: "Buy now",
    });
    expect(ann.id).toMatch(/^ann_/);
    expect(ann.browserId).toBe("b-1");
    expect(ann.tabId).toBe(42);
    expect(listAnnotations("b-1")).toHaveLength(1);
  });

  it("stores a screenshot annotation without selector", async () => {
    const { addAnnotation, listAnnotations } = await import("../../src/annotations.js");
    const ann = addAnnotation("b-1", {
      kind: "screenshot",
      comment: "Whole hero looks off",
      tabId: 7,
      screenshotPath: "/tmp/shot.png",
    });
    expect(ann.kind).toBe("screenshot");
    expect(ann.screenshotPath).toBe("/tmp/shot.png");
    expect(listAnnotations("b-1")).toHaveLength(1);
  });

  it("scopes listing per tab across many tabs", async () => {
    const { addAnnotation, listAnnotations } = await import("../../src/annotations.js");
    addAnnotation("b-1", { kind: "element", comment: "one", tabId: 1, selector: "button.a" });
    addAnnotation("b-1", { kind: "element", comment: "two", tabId: 2, selector: "button.b" });
    addAnnotation("b-1", { kind: "element", comment: "three", tabId: 2, selector: "button.c" });
    expect(listAnnotations("b-1")).toHaveLength(3);
    expect(listAnnotations("b-1", { tabId: 2 }).map((a) => a.comment)).toEqual(["two", "three"]);
    expect(listAnnotations("b-1", { tabId: 99 })).toHaveLength(0);
  });

  it("keeps browsers isolated", async () => {
    const { addAnnotation, listAnnotations } = await import("../../src/annotations.js");
    addAnnotation("b-1", { kind: "element", comment: "x", tabId: 1, selector: "div" });
    expect(listAnnotations("b-2")).toHaveLength(0);
  });

  it("rejects empty comments, missing tabId, and selector-less elements", async () => {
    const { addAnnotation } = await import("../../src/annotations.js");
    expect(() => addAnnotation("b-1", { kind: "element", comment: "  ", tabId: 1, selector: "div" })).toThrow();
    expect(() => addAnnotation("b-1", { kind: "element", comment: "x", tabId: -1, selector: "div" })).toThrow();
    expect(() => addAnnotation("b-1", { kind: "element", comment: "x", tabId: 1 })).toThrow();
    expect(() => addAnnotation("b-1", { kind: "weird" as never, comment: "x", tabId: 1 })).toThrow();
  });

  it("clears by ids, by tab, or all", async () => {
    const { addAnnotation, clearAnnotations, listAnnotations } = await import("../../src/annotations.js");
    const a = addAnnotation("b-1", { kind: "element", comment: "a", tabId: 1, selector: "div.a" });
    addAnnotation("b-1", { kind: "element", comment: "b", tabId: 2, selector: "div.b" });
    addAnnotation("b-1", { kind: "element", comment: "c", tabId: 2, selector: "div.c" });

    const byId = clearAnnotations("b-1", { ids: [a.id] });
    expect(byId).toEqual({ cleared: 1, remaining: 2 });

    const byTab = clearAnnotations("b-1", { tabId: 2 });
    expect(byTab).toEqual({ cleared: 2, remaining: 0 });
    expect(listAnnotations("b-1")).toHaveLength(0);

    addAnnotation("b-1", { kind: "element", comment: "d", tabId: 3, selector: "div.d" });
    const all = clearAnnotations("b-1");
    expect(all).toEqual({ cleared: 1, remaining: 0 });
  });

  it("stores a region screenshot with rect, region, and resolved element hint", async () => {
    const { addAnnotation, listAnnotations } = await import("../../src/annotations.js");
    const ann = addAnnotation("b-1", {
      kind: "screenshot",
      comment: "hero overlaps on mobile",
      tabId: 3,
      url: "https://example.com/",
      region: { x: 100, y: 200, width: 400, height: 300, viewportWidth: 1280, viewportHeight: 800, dpr: 1 },
      regionElement: { selector: "main > div.hero", tag: "div", text: "Sale" },
      crop: { width: 400, height: 300 },
    });
    expect(ann.region?.width).toBe(400);
    expect(ann.crop).toEqual({ width: 400, height: 300 });
    expect(ann.regionElement?.selector).toBe("main > div.hero");
    expect(listAnnotations("b-1", { tabId: 3 })).toHaveLength(1);
  });

  it("resolves a region element hint into selector/text when no element fields set", async () => {
    const { addAnnotation } = await import("../../src/annotations.js");
    const ann = addAnnotation("b-9", {
      kind: "screenshot",
      comment: "this block",
      tabId: 1,
      regionElement: { selector: "section.pricing", tag: "section" },
    });
    expect(ann.selector).toBe("section.pricing");
    expect(ann.tag).toBe("section");
  });

  it("counts per tab", async () => {
    const { addAnnotation, countAnnotations } = await import("../../src/annotations.js");
    addAnnotation("b-1", { kind: "element", comment: "a", tabId: 5, selector: "div" });
    addAnnotation("b-1", { kind: "screenshot", comment: "b", tabId: 5 });
    addAnnotation("b-1", { kind: "element", comment: "c", tabId: 9, selector: "span" });
    expect(countAnnotations("b-1")).toEqual({ total: 3, byTab: { 5: 2, 9: 1 } });
    expect(countAnnotations("ghost")).toEqual({ total: 0, byTab: {} });
  });

  it("persists to disk best-effort (annotates survive core restart)", async () => {
    const fs = await import("node:fs");
    const { addAnnotation } = await import("../../src/annotations.js");
    addAnnotation("b-1", { kind: "element", comment: "persist me", tabId: 1, selector: "div" });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });
});
