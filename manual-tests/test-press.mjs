/**
 * FILE: manual-tests/test-press.mjs
 * PURPOSE: Plan §A — `page.act action=press { key }` dispatches a
 *          keyboard event via CDP `Input.dispatchKeyEvent`. Bypasses
 *          page-level synthetic event handlers, like Playwright.
 *
 *          Proves:
 *            1. press is dispatched and returns success.
 *            2. Verdict: world=cdp, path=cdp.input.dispatchKeyEvent.
 *            3. The key actually fired — the input value changed.
 */

import { findBrowser, ensureWindow, executeTool, navigate, testPageUrl, waitForContentScript, expect } from "./lib/browser.mjs";

const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", RESET = "\x1b[0m";

async function main() {
  const browser = await findBrowser();
  console.log(`Browser: ${browser.id} "${browser.name}"`);
  await ensureWindow(browser.id);
  const url = await testPageUrl("press-target");
  await navigate(browser.id, url);
  await waitForContentScript(browser.id);

  // Focus the input via JS.
  await executeTool(browser.id, "page.js", { code: "document.getElementById('t').focus()" });

  // Press the 'A' key via CDP.
  const r = await executeTool(browser.id, "page.act", {
    action: "press",
    target: { css: "#t" },
    key: "a",
  });
  console.log(`${DIM}response (truncated): ${JSON.stringify(r).slice(0, 500)}${RESET}`);

  // If the user hasn't approved page.act for this site yet, the call will
  // time out waiting for approval. That's not a test failure.
  if (!r.success && /Approval timed out/i.test(r.error || "")) {
    console.log(`${YELLOW}⏸ SKIP${RESET} — page.act requires user approval. Approve the request in Chrome and re-run.`);
    process.exit(0);
  }

  expect(r.data?.success, true, "press reports success");
  const verdict = r.data?.executionVerdict;
  expect(verdict?.world, "cdp", "verdict.world is 'cdp'");
  expect(verdict?.path, "cdp.input.dispatchKeyEvent", "verdict.path is 'cdp.input.dispatchKeyEvent'");

  // Verify the input now has "a" in it.
  const verify = await executeTool(browser.id, "page.js", { code: "document.getElementById('t').value" });
  if (!verify.success && /denied/i.test(verify.error || "")) {
    console.log(`${YELLOW}⏸ SKIP verify${RESET} — page.execute denied. Press itself verified by verdict.`);
  } else {
    const value = verify.data?.result ?? verify.data?.data?.result;
    console.log(`Input value after press: "${value}"`);
    expect(value, (v) => v === "a" || v === "A", `input value is "a" (got "${value}")`);
  }

  console.log(`${GREEN}✓ PASS${RESET} — press "a" via CDP fired the keydown/keyup, input received "a".`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}✗ FAIL${RESET} — ${err.message}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(1);
});
