# Manual Tests — Real Browser Harness

Every test in this directory drives **the user's real browser** through the core REST API. No Playwright. No browser launching. The browser is already open with the BrowserPowers extension loaded and connected to the core — you open it once, then run scripts against it.

## Setup (one time)

1. Install + start the core: `node scripts/install.mjs` (or `pnpm dev` for development).
2. Open Chrome, load the BrowserPowers extension from the built output, click the icon to confirm the popup shows "Connected".
3. Run `node manual-tests/test-smoke.mjs`. It should print PASS. If it errors with "No browser connected", your extension isn't talking to the core.

## How a test is structured

Every test is a single `.mjs` file:
- `lib/browser.mjs` provides `findBrowser()`, `executeTool()`, `navigate()`, `dataUrl()`, `expect()`.
- The test prints what it does, hits the core, asserts the response, prints PASS or FAIL, exits 0 or 1.
- Tests are designed to be **run individually** by the human. They are not CI.

## Running

```bash
# Run one test (you watch the browser, the script prints the result):
node manual-tests/test-smoke.mjs
node manual-tests/test-readable.mjs
node manual-tests/test-click-at.mjs

# Run every test, get a summary:
node manual-tests/run-all.mjs
# or
pnpm test:manual

# Run the headline smoke (this is what the install README should say):
pnpm smoke
```

## When the browser is wrong

If a test errors with "No browser has the required new capabilities", the connected browser is running an older extension build. Reload the extension from the freshly-built output:

```bash
node scripts/install.mjs
# then in Chrome: chrome://extensions → toggle the BrowserPowers extension off and on
```

## When you change a feature

1. `pnpm build` (rebuilds the extension).
2. Reload the extension in Chrome (or run `node scripts/install.mjs` again to copy the new build into `~/.browserpowers/extension`).
3. Run the matching test: `node manual-tests/test-X.mjs`.
4. If green, run the full suite: `pnpm test:manual`.

## Why this exists

The product's value is "control the user's real browser". Tests that use Playwright launch a fake browser — they don't test the real thing. The real test is the one where the user's actual Chrome, with the user's actual session, runs the actual extension, executes the actual `chrome.*` API call.

No flickering. No "Chromium distribution not found". No `globalSetup` daemon. The browser stays open the whole time, and the scripts just talk to the core.
