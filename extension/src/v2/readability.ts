/**
 * FILE: extension/src/v2/readability.ts
 * PURPOSE: Trafilatura-style article extraction — REAL function, not a
 *          string body. The previous implementation lived in
 *          `extension/src/readability.ts` as a self-contained arrow
 *          function body that the content script invoked via
 *          `new Function(...)`. That breaks in MV3 because the
 *          content script's isolated world runs under the extension's
 *          CSP, which does not allow `unsafe-eval` (and MV3 rejects
 *          `'unsafe-eval'` in the extension_pages CSP). The new
 *          implementation is a plain TypeScript function — no eval,
 *          no new Function, no string-as-code.
 *
 *          Behavior is identical to the old string-body version:
 *          clones the body, strips nav/header/aside/footer/ads/comments
 *          and similar boilerplate, finds the main element, and returns
 *          cleaned text + excerpt + metadata.
 */

const NON_CONTENT_TAGS = new Set([
  "NAV", "HEADER", "FOOTER", "ASIDE", "SCRIPT", "STYLE",
  "NOSCRIPT", "IFRAME", "SVG", "CANVAS", "VIDEO", "AUDIO",
  "OBJECT", "EMBED", "TEMPLATE",
]);

const NON_CONTENT_SELECTORS = [
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  ".nav", ".navbar", ".navigation", ".menu", ".sidebar",
  ".footer", ".header", ".advertisement", ".ad", ".ads",
  ".social-share", ".related-posts", ".comments",
  "#nav", "#navbar", "#navigation", "#menu", "#sidebar",
  "#footer", "#header", "#comments",
  '[id*="sidebar"]', '[class*="sidebar"]',
  '[id*="footer"]', '[class*="footer"]',
  '[id*="nav"]', '[class*="nav-"]',
  '[id*="menu"]', '[class*="menu"]',
  '[id*="ad-"]', '[class*="ad-"]', '[class*="ads-"]',
];

const MAIN_SELECTORS = [
  "main", "article", '[role="main"]',
  ".post-content", ".article-content", ".entry-content",
];

function isNonContent(el: Element): boolean {
  if (NON_CONTENT_TAGS.has(el.tagName)) return true;
  for (const sel of NON_CONTENT_SELECTORS) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* invalid selector */
    }
  }
  return false;
}

function cloneWithoutBoilerplate(body: HTMLElement): HTMLElement {
  const clone = body.cloneNode(true) as HTMLElement;
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  const toRemove: Element[] = [];
  let node: Element | null = walker.nextNode() as Element | null;
  while (node) {
    if (isNonContent(node)) toRemove.push(node);
    node = walker.nextNode() as Element | null;
  }
  for (const el of toRemove) {
    if (el.parentNode) el.parentNode.removeChild(el);
  }
  return clone;
}

function findMainElement(doc: HTMLElement): Element | null {
  for (const sel of MAIN_SELECTORS) {
    try {
      const el = doc.querySelector(sel);
      if (el) return el;
    } catch {
      /* invalid selector */
    }
  }
  return null;
}

export interface ReadableResult {
  title: string;
  content: string;
  excerpt: string;
  byline?: string;
  length: number;
  fallback: boolean;
}

/**
 * Extract the main article content from the current document.
 * Strips nav, header, footer, sidebars, ads, comments, and similar
 * boilerplate, then returns the cleaned text plus an excerpt and
 * metadata. Always returns — never throws.
 */
export function extractReadable(doc: Document = document): ReadableResult {
  try {
    const body = doc.body;
    if (!body) throw new Error("No body element");

    const title = doc.title || "";
    const cleaned = cloneWithoutBoilerplate(body);
    const main = findMainElement(cleaned);

    let content = (main ?? cleaned).textContent || "";
    // Normalize whitespace: collapse multiple newlines/spaces.
    content = content.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();

    const firstPara = content.split("\n\n").find((p) => p.length > 40) || content.slice(0, 200);
    const excerpt = firstPara.slice(0, 300);

    return {
      title,
      content,
      excerpt,
      byline: undefined,
      length: content.length,
      fallback: !main,
    };
  } catch (err) {
    // Ultimate fallback: raw innerText.
    const body = doc.body;
    const raw = body ? (body.innerText || doc.documentElement?.innerText || "") : "";
    return {
      title: doc.title || "",
      content: raw,
      excerpt: raw.slice(0, 200),
      length: raw.length,
      fallback: true,
    };
  }
}
