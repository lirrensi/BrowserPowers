/**
 * FILE: manual-tests/reload-extension.mjs
 * PURPOSE: Ask the running extension to reload itself.
 *          After `node scripts/install.mjs` copies a new build into the
 *          extension folder, the user shouldn't have to open
 *          chrome://extensions and click reload manually. This script
 *          sends `self.reload` to the extension via the core, which
 *          triggers chrome.runtime.reload() in the service worker.
 *
 *          Usage: `node manual-tests/reload-extension.mjs`
 *          After it returns, wait ~2 seconds for the new service
 *          worker to come up, then run your tests.
 */

import { findBrowser, executeTool, expect } from "./lib/browser.mjs";

const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";

async function main() {
  // Use lenient mode — the browser hasn't re-registered with the new
  // capabilities yet (we're trying to TRIGGER that re-registration).
  const browser = await findBrowser({ lenient: true });
  console.log(`Browser: ${browser.id} "${browser.name}"`);

  const r = await executeTool(browser.id, "self.reload", {});
  console.log(`${DIM}response: ${JSON.stringify(r)}${RESET}`);

  if (r.error && /not in browser's capabilities/i.test(r.error)) {
    console.error(`${RED}✗ The extension hasn't been reloaded since the new build was installed.${RESET}`);
    console.error(`  The browser registered its capabilities before self.reload existed, so the core`);
    console.error(`  rejects the call. Do this ONCE after install:`);
    console.error(`    1. Open chrome://extensions`);
    console.error(`    2. Click the reload icon on BrowserPowers`);
    console.error(`    3. Re-run: node manual-tests/reload-extension.mjs`);
    console.error(`  After that, this script works automatically.`);
    process.exit(1);
  }

  const data = r.data ?? r;
  expect(data.data?.reloading ?? data.reloading, true, "extension reports reloading=true");

  console.log(`${GREEN}✓ reload scheduled${RESET} — wait ~2s for the new service worker, then run your tests.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}✗ FAIL${RESET} — ${err.message}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(1);
});
