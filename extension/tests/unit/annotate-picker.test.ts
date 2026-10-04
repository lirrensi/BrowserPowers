import { describe, it, expect, beforeEach } from "vitest";
import { cssPathFor } from "../../src/annotate/picker.js";

interface FakeEl {
  tagName: string;
  id?: string;
  parent: FakeEl | null;
  prevSiblings: string[];
  ownerDoc?: { body: unknown; documentElement: unknown };
}

function makeEl(tagName: string, opts?: { id?: string; parent?: FakeEl | null; prevSiblings?: string[] }): FakeEl {
  return {
    tagName,
    id: opts?.id,
    parent: opts?.parent ?? null,
    prevSiblings: opts?.prevSiblings ?? [],
  };
}

function asDomEl(fake: FakeEl): Element {
  const doc = { body: {}, documentElement: {} };
  const build = (f: FakeEl, parent: Element | null): Element => {
    const sibs = f.prevSiblings.map((t) => ({ tagName: t, previousElementSibling: null }) as unknown as Element);
    let prev: Element | null = null;
    for (const s of sibs) {
      (s as unknown as Record<string, unknown>).previousElementSibling = prev;
      prev = s;
    }
    const el = {
      nodeType: 1,
      tagName: f.tagName.toUpperCase(),
      getAttribute: (n: string) => (n === "id" ? (f.id ?? null) : null),
      previousElementSibling: prev,
      parentElement: parent,
      ownerDocument: doc,
    } as unknown as Element;
    return el;
  };
  return build(fake, null);
}

describe("annotate cssPathFor", () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).CSS = {
      escape: (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
    };
  });

  it("prefers id when valid", () => {
    const el = asDomEl(makeEl("button", { id: "save" }));
    expect(cssPathFor(el)).toBe("#save");
  });

  it("chains nth-of-type when no id exists", () => {
    const el = asDomEl(makeEl("button", { prevSiblings: ["button", "span", "button"] }));
    expect(cssPathFor(el)).toContain("button:nth-of-type(3)");
  });

  it("returns undefined outside any document", () => {
    const broken = {
      nodeType: 1,
      tagName: "DIV",
      getAttribute: () => { throw new Error("nope"); },
      previousElementSibling: null,
      parentElement: null,
      ownerDocument: null,
    } as unknown as Element;
    expect(cssPathFor(broken)).toBeUndefined();
  });

  it("builds region drafts pure (no DOM selection needed)", async () => {
    const { buildRegionDraft } = await import("../../src/annotate/picker.js");
    const fakeEl = {
      tagName: "SECTION",
      textContent: "Pricing plans here",
      getAttribute: () => null,
      previousElementSibling: null,
      parentElement: null,
      ownerDocument: { body: {}, documentElement: {} },
      nodeType: 1,
    } as unknown as Element;
    const draft = buildRegionDraft({ x: 10, y: 20, width: 300, height: 200 }, fakeEl);
    expect(draft.kind).toBe("screenshot");
    expect(draft.region).toMatchObject({ x: 10, y: 20, width: 300, height: 200 });
    expect(draft.regionElement?.tag).toBe("section");
    expect(draft.regionElement?.text).toBe("Pricing plans here");
  });

  it("builds region drafts without an element", async () => {
    const { buildRegionDraft } = await import("../../src/annotate/picker.js");
    const draft = buildRegionDraft({ x: 0, y: 0, width: 50, height: 50 }, null);
    expect(draft.kind).toBe("screenshot");
    expect(draft.regionElement).toBeUndefined();
  });
});
