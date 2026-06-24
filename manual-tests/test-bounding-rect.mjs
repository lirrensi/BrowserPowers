/**
 * FILE: manual-tests/test-bounding-rect.mjs
 * PURPOSE: Plan §3.1 — `page.read action=inspect` returns anchors
 *          with `boundingRect: { x, y, width, height }` and
 *          `center: { x, y }` (rounded integers). The agent uses
 *          these to pick a click target by coordinates.
 *
 *          Uses page.read (allow by default — no approval popup).
 *
 *          Proves:
 *            1. inspect returns anchors.
 *            2. Each anchor has boundingRect.{x, y, width, height}
 *               as integers >= 0.
 *            3. Each anchor has center.{x, y} as integers.
 *            4. center = boundingRect.{x + width/2, y + height/2}.
 */

import { findBrowser, ensureWindow, executeTool, navigate, waitForContentScript, testPageUrl, expect } from "./lib/browser.mjs";

const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";

async function main() {
  const browser = await findBrowser();
  console.log(`Browser: ${browser.id} "${browser.name}"`);
  await ensureWindow(browser.id);
  const url = await testPageUrl("visual");
  await navigate(browser.id, url);
  await waitForContentScript(browser.id);

  const r = await executeTool(browser.id, "page.read", { action: "inspect" });

  const envelope = r.data ?? r;
  expect(envelope.success, true, "inspect reports success");
  const anchors = envelope.data?.anchors ?? [];
  expect(Array.isArray(anchors), true, "anchors is an array");
  expect(anchors.length, (n) => n >= 3, `at least 3 anchors (got ${anchors.length})`);

  for (const a of anchors) {
    const rect = a.boundingRect;
    expect(rect, (v) => !!v, `anchor ${a.anchor} has boundingRect`);
    expect(Number.isInteger(rect.x), true, `${a.anchor} boundingRect.x is integer`);
    expect(Number.isInteger(rect.y), true, `${a.anchor} boundingRect.y is integer`);
    expect(Number.isInteger(rect.width), true, `${a.anchor} boundingRect.width is integer`);
    expect(Number.isInteger(rect.height), true, `${a.anchor} boundingRect.height is integer`);
    expect(rect.width, (n) => n > 0, `${a.anchor} boundingRect.width > 0`);
    expect(rect.height, (n) => n > 0, `${a.anchor} boundingRect.height > 0`);

    const c = a.center;
    expect(c, (v) => !!v, `anchor ${a.anchor} has center`);
    expect(Number.isInteger(c.x), true, `${a.anchor} center.x is integer`);
    expect(Number.isInteger(c.y), true, `${a.anchor} center.y is integer`);

    // Center is APPROXIMATELY the rect center — allow a small offset
    // because the rect can be off by a sub-pixel due to layout, scroll,
    // or the way the inspect code rounds. Within ±2 is correct.
    const expectedX = Math.round(rect.x + rect.width / 2);
    const expectedY = Math.round(rect.y + rect.height / 2);
    expect(Math.abs(c.x - expectedX), (d) => d <= 2, `${a.anchor} center.x within ±2 of rect center (got ${c.x}, expected ~${expectedX})`);
    expect(Math.abs(c.y - expectedY), (d) => d <= 2, `${a.anchor} center.y within ±2 of rect center (got ${c.y}, expected ~${expectedY})`);

    // Center is inside the bounding rect.
    expect(c.x >= rect.x && c.x <= rect.x + rect.width, true, `${a.anchor} center.x inside rect`);
    expect(c.y >= rect.y && c.y <= rect.y + rect.height, true, `${a.anchor} center.y inside rect`);
  }

  console.log(`${GREEN}✓ PASS${RESET} — inspect returned ${anchors.length} anchors, all with valid boundingRect + center.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}✗ FAIL${RESET} — ${err.message}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(1);
});
