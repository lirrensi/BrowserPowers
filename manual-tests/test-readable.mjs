/**
 * FILE: manual-tests/test-readable.mjs
 * PURPOSE: Plan §4.1 — `page.read action=readable` extracts the main
 *          article text, stripping nav, sidebars, footer, ads.
 *          (Reuses the existing readability.ts extractor.)
 *
 *          Uses page.read (allow by default — no approval popup).
 *
 *          Proves:
 *            1. The readable action exists and is accepted.
 *            2. It returns the article body.
 *            3. It does NOT return the nav, header, footer, sidebar,
 *               ad, or comments text.
 *            4. Verdict: world=isolated, path=isolated.readable.
 */

import { findBrowser, ensureWindow, executeTool, navigate, waitForContentScript, testPageUrl, expect } from "./lib/browser.mjs";

const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";

async function main() {
  const browser = await findBrowser();
  console.log(`Browser: ${browser.id} "${browser.name}"`);
  await ensureWindow(browser.id);
  const url = await testPageUrl("article");
  await navigate(browser.id, url);
  await waitForContentScript(browser.id);

  const r = await executeTool(browser.id, "page.read", { action: "readable" });
  console.log(`${DIM}response (truncated): ${JSON.stringify(r).slice(0, 500)}${RESET}`);

  const envelope = r.data ?? r;
  expect(envelope.success, true, "readable reports success");
  const content = envelope.data?.content;
  expect(typeof content, "string", "content is a string");
  expect(content.length, (n) => n > 50, "content is non-trivial");

  // Article body should be present.
  expect(content.includes("The Real Article Title"), true, "article title is in content");
  expect(content.includes("first paragraph of the real article body"), true, "article body para 1 in content");
  expect(content.includes("second paragraph continues the real article body"), true, "article body para 2 in content");
  expect(content.includes("third paragraph confirms that longer articles"), true, "article body para 3 in content");

  // Nav/footer/ads should be stripped.
  expect(content.includes("navigation junk should be stripped"), false, "nav text NOT in content");
  expect(content.includes("header junk should be stripped"), false, "header text NOT in content");
  expect(content.includes("footer junk should be stripped"), false, "footer text NOT in content");
  expect(content.includes("sidebar junk should be stripped"), false, "sidebar text NOT in content");
  expect(content.includes("advertisement junk should be stripped"), false, "ad text NOT in content");
  expect(content.includes("comments junk should be stripped"), false, "comments text NOT in content");

  // Verdict honesty.
  const verdict = envelope.executionVerdict ?? envelope.data?.executionVerdict;
  expect(verdict?.world, "isolated", "verdict.world is 'isolated'");
  expect(verdict?.path?.startsWith("isolated.readable"), true, "verdict.path starts with 'isolated.readable'");

  console.log(`${GREEN}✓ PASS${RESET} — readable extracted ${content.length} chars, stripped nav/header/aside/footer/ads/comments.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}✗ FAIL${RESET} — ${err.message}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(1);
});
