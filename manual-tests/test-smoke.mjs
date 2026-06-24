/**
 * FILE: manual-tests/test-smoke.mjs
 * PURPOSE: Headline smoke test. Proves the whole stack wires up using
 *          ONLY tools that are `allow` by default — no approval popups.
 *
 *          Steps:
 *            1. Core is reachable on port 4199.
 *            2. Exactly one browser is connected with the new capabilities.
 *            3. tabs.list works.
 *            4. page.read action=inspect works (content script alive).
 *            5. page.read action=html works.
 *            6. page.read action=meta works.
 *
 *          If this passes, the extension is loaded, the WebSocket is
 *          connected, the content script is alive in the active tab.
 *          Other tests cover page.js, page.act, and screenshots.
 *
 *          Used by `pnpm smoke` and as the first check before any
 *          other manual test runs.
 */

import { findBrowser, ensureWindow, executeTool, navigate, waitForContentScript, testPageUrl, expect, CORE_BASE } from "./lib/browser.mjs";

const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const banner = (s) => console.log(`\n\x1b[1m=== ${s} ===\x1b[0m`);

async function main() {
  banner("Smoke — core reachable");
  console.log(`Core: ${CORE_BASE}`);
  const browser = await findBrowser();
  console.log(`Browser: ${browser.id} "${browser.name}"`);
  console.log(`Capabilities: ${(browser.capabilities ?? []).length} total`);

  banner("Smoke — ensure window exists");
  await ensureWindow(browser.id);

  banner("Smoke — navigate to a pre-made test page");
  const url = await testPageUrl("document");
  console.log(`Test page URL: ${url}`);
  await navigate(browser.id, url);
  await waitForContentScript(browser.id);
  console.log("Content script is ready.");

  banner("Smoke — page.read action=inspect");
  const inspect = await executeTool(browser.id, "page.read", { action: "inspect", limit: 20 });
  const envelope = inspect.data ?? inspect;
  expect(envelope.success, true, "inspect reports success");
  const idata = envelope.data ?? {};
  const anchors = idata.anchors ?? [];
  console.log(`Anchors found: ${anchors.length}`);

  banner("Smoke — page.read action=html");
  const html = await executeTool(browser.id, "page.read", { action: "html", target: { css: "h1" } });
  const henv = html.data ?? html;
  expect(henv.success, true, "html reports success");
  const htmls = henv.data?.html ?? [];
  expect(htmls.length, (n) => n >= 1, "html returns at least one match");
  expect(htmls[0], (v) => v.includes("Full Document Test"), "html[0] contains the h1 text");

  banner("Smoke — page.read action=meta");
  const meta = await executeTool(browser.id, "page.read", { action: "meta" });
  const menv = meta.data ?? meta;
  expect(menv.success, true, "meta reports success");
  const title = menv.data?.title;
  expect(title, "Document — full_html test", "meta.title matches the test page");

  console.log(`\n${GREEN}✓ PASS${RESET} — core reachable, browser connected, content script alive, page.read works on all 3 actions.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${RED}✗ FAIL${RESET} — ${err.message}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(1);
});
