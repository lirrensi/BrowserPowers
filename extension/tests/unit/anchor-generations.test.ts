import { describe, it, expect } from "vitest";
import { setAnchors, getAnchor, getGeneration, getDocumentId } from "../../src/v2/anchor-manager.js";

// Pure in-memory test — no chrome.*, no network, nothing destructive.
// Covers the observation-hardening steal: every inspect replaces the ref map
// and bumps the generation guards used by visual_click capture_ids.

function entry(anchor: string) {
  return { anchor, target: { css: `#${anchor}` }, selector: `#${anchor}` };
}

describe("anchor generations", () => {
  // NOTE: module state persists between tests in this file, so each test
  // uses its own tab ids to start from a fresh generation counter.
  it("starts at 0 and bumps on every inspect", () => {
    expect(getGeneration(11)).toBe(0);
    expect(setAnchors(11, "doc-a", [entry("a1")])).toBe(1);
    expect(getGeneration(11)).toBe(1);
    expect(setAnchors(11, "doc-b", [entry("a1")])).toBe(2);
    expect(getGeneration(11)).toBe(2);
  });

  it("replaces the whole map — old anchors are gone", () => {
    setAnchors(21, "doc-a", [entry("a1"), entry("a2")]);
    expect(getAnchor(21, "a2")).not.toBeNull();
    setAnchors(21, "doc-b", [entry("a1")]);
    expect(getAnchor(21, "a1")).not.toBeNull();
    expect(getAnchor(21, "a2")).toBeNull();
  });

  it("tracks generations per tab independently", () => {
    const g31 = setAnchors(31, "doc-a", [entry("a1")]);
    setAnchors(31, "doc-b", [entry("a1")]);
    setAnchors(32, "doc-a", [entry("a1")]);
    expect(getGeneration(31)).toBe(g31 + 1);
    expect(getGeneration(32)).toBe(1);
  });

  it("getDocumentId follows the latest batch", () => {
    expect(getDocumentId(41)).toBeNull();
    setAnchors(41, "doc-a", [entry("a1")]);
    expect(getDocumentId(41)).toBe("doc-a");
    setAnchors(41, "doc-b", [entry("a1")]);
    expect(getDocumentId(41)).toBe("doc-b");
  });
});
