/**
 * FILE: manual-tests/test-overlay.mjs
 * PURPOSE: Plan §3.4 — `screenshots.capture overlay=both` paints
 *          bounding boxes (and labels) on the screenshot via Canvas.
 *          The returned PNG is larger or different from a raw capture
 *          (since it has painted elements on it).
 *
 *          Uses screenshots (allow by default — no approval popup).
 *
 *          Proves:
 *            1. overlay=none returns the raw screenshot (backward compat).
 *            2. overlay=both returns a base64 PNG.
 *            3. The overlay PNG differs from the raw one (boxes drawn).
 *            4. Both are valid PNGs (magic bytes).
 *
 *          If the user wants the PNGs saved to disk, the test writes
 *          them to manual-tests/results/. Open them in an image viewer
 *          to visually confirm the boxes are drawn.
 */

import { findBrowser, ensureWindow, executeTool, navigate, waitForContentScript, testPageUrl, expect } from "./lib/browser.mjs";
import { Buffer } from "node:buffer";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

function isPng(b) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

async function main() {
  const browser = await findBrowser();
  console.log(`Browser: ${browser.id} "${browser.name}"`);
  await ensureWindow(browser.id);
  const url = await testPageUrl("visual");
  await navigate(browser.id, url);
  await waitForContentScript(browser.id);

  // Raw screenshot first.
  const raw = await executeTool(browser.id, "screenshots.capture", { overlay: "none" });
  // For screenshots the inner data is { base64, format, overlay? } — no
  // `success` field at that level. Just check the API call succeeded
  // and the base64 is present.
  expect(raw.success, true, `raw screenshot API call succeeded (raw: ${JSON.stringify(raw).slice(0, 300)})`);
  const rawBase64 = raw.data?.base64;
  expect(rawBase64, (v) => typeof v === "string" && v.length > 100, "raw screenshot returns base64");
  const rawPng = Buffer.from(rawBase64, "base64");
  expect(isPng(rawPng), true, "raw is a valid PNG");
  console.log(`Raw PNG: ${rawPng.length} bytes`);

  // Chrome rate-limits chrome.tabs.captureVisibleTab to ~2/sec. Wait
  // between the raw and the overlay calls so we don't blow the quota.
  await new Promise((r) => setTimeout(r, 1500));

  // Overlay screenshot.
  const ov = await executeTool(browser.id, "screenshots.capture", { overlay: "both" });
  expect(ov.success, true, `overlay screenshot API call succeeded`);
  const ovBase64 = ov.data?.base64;
  expect(ovBase64, (v) => typeof v === "string" && v.length > 100, "overlay screenshot returns base64");
  const ovPng = Buffer.from(ovBase64, "base64");
  expect(isPng(ovPng), true, "overlay is a valid PNG");
  console.log(`Overlay PNG: ${ovPng.length} bytes`);
  if (ov.data?.drawn !== undefined) console.log(`Drawn: ${ov.data.drawn}`);

  // Sanity: the overlay PNG should differ from the raw (boxes painted on it).
  // Save both PNGs first so we can inspect them on disk.
  const rawPath = resolve(RESULTS_DIR, "screenshot-raw.png");
  const ovPath = resolve(RESULTS_DIR, "screenshot-overlay.png");
  writeFileSync(rawPath, rawPng);
  writeFileSync(ovPath, ovPng);
  console.log(`Saved: ${rawPath}`);
  console.log(`Saved: ${ovPath}`);

  expect(ovPng.equals(rawPng), false, "overlay PNG differs from raw PNG (boxes were drawn)");

  // Chrome rate-limits chrome.tabs.captureVisibleTab to ~2/sec. The
  // raw + overlay back-to-back fires two in <1s, so we wait. This
  // pause isn't needed for production use — only for this test.
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`${GREEN}✓ PASS${RESET} — overlay PNG (${ovPng.length}B) differs from raw (${rawPng.length}B). Saved to manual-tests/results/.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}✗ FAIL${RESET} — ${err.message}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(1);
});
