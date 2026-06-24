/**
 * FILE: manual-tests/test-full-html.mjs
 * PURPOSE: Plan §4.2 — `page.read action=full_html` returns the entire
 *          document HTML. No preprocessing, no cleanup. If you want
 *          clean, use readable.
 *
 *          Uses page.read (allow by default — no approval popup).
 *
 *          Proves:
 *            1. The full_html action is accepted.
 *            2. The returned HTML includes <html>, <head>, <body>.
 *            3. The full document is returned (not just body content).
 *            4. <style> and <script> tags come through unprocessed.
 *            5. Verdict: world=isolated, path=isolated.fullHtml.
 */

import { findBrowser, ensureWindow, executeTool, navigate, waitForContentScript, testPageUrl, expect } from "./lib/browser.mjs";

const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";

async function main() {
  const browser = await findBrowser();
  console.log(`Browser: ${browser.id} "${browser.name}"`);
  await ensureWindow(browser.id);
  const url = await testPageUrl("document");
  await navigate(browser.id, url);
  await waitForContentScript(browser.id);

  const r = await executeTool(browser.id, "page.read", { action: "full_html" });
  console.log(`${DIM}response (truncated): ${JSON.stringify(r).slice(0, 500)}${RESET}`);

  const envelope = r.data ?? r;
  expect(envelope.success, true, "full_html reports success");
  const html = envelope.data?.html;
  expect(typeof html, "string", "html is a string");

  // Document markers. Note: document.documentElement.outerHTML does NOT
  // include the <!doctype> declaration — that's in document.doctype.
  expect(html.includes("<html"), true, "html has <html tag");
  expect(html.includes("<head>"), true, "html has <head> tag");
  expect(html.includes("<body>"), true, "html has <body> tag");
  expect(html.includes("Full Document Test"), true, "html has <h1> content");
  expect(html.includes("Every byte of this should come back"), true, "html has <p> content");
  expect(html.includes("<style>"), true, "html includes <style> (unprocessed)");
  expect(html.includes("<script>"), true, "html includes <script> (unprocessed)");

  // Verdict honesty.
  const verdict = envelope.executionVerdict ?? envelope.data?.executionVerdict;
  expect(verdict?.world, "isolated", "verdict.world is 'isolated'");
  expect(verdict?.path?.startsWith("isolated.fullHtml"), true, "verdict.path starts with 'isolated.fullHtml'");

  console.log(`${GREEN}✓ PASS${RESET} — full_html returned ${html.length} chars (full document, unprocessed).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}✗ FAIL${RESET} — ${err.message}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(1);
});
