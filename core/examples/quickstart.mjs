#!/usr/bin/env node
/**
 * FILE: core/examples/quickstart.mjs
 * PURPOSE: Copy-paste starter for scripting BrowserPowers from Node —
 *          sequence calls, filter in-process, fan out in parallel.
 * RUN: node core/examples/quickstart.mjs [browser] [url]
 * NEEDS: daemon + connected browser (browserpowers status), core built (npm run build).
 *
 * This is the thinnest possible wrapper: the compiled client is imported
 * straight from ../dist/client.js, so the example never drifts from the API.
 *
 * Envelope rule (twice, because it bites): the REST body is
 * { browserId, tool, success, data?, error? } and for page.read/page.act
 * `data` is the ActionResult { success, status, action, message, data? } —
 * so the anchors live at result.data.data.anchors. Check BOTH success flags:
 * a click that missed arrives as success:true with data.success:false.
 */
import { BrowserPowersClient, resolveBaseUrl } from "../dist/client.js";

const BROWSER = process.argv[2] ?? process.env.BP_BROWSER ?? "my-browser";
const URL = process.argv[3] ?? "https://example.com";

const bp = new BrowserPowersClient();
console.log(`core: ${resolveBaseUrl()}`);

// 1. Wait for the browser (ID or name), then drive it — sequential on purpose:
//    navigate invalidates anchors, so inspect must come after.
const browser = await bp.waitForBrowser(BROWSER, { timeoutMs: 10_000 });
console.log(`browser: ${browser.name} (${browser.id})`);

const nav = await bp.navigate(browser.id, URL);
if (!nav.success) throw new Error(`navigate failed: ${nav.error}`);

// 2. Read, then filter RIGHT HERE — no extra round trip per element.
const tree = await bp.pageRead(browser.id, "inspect", { limit: 30, compact: true });
if (!tree.success) throw new Error(`inspect failed: ${tree.error}`);
const envelope = tree.data;
if (!envelope?.success) throw new Error(`inspect not performed: ${envelope?.message}`);
const anchors = envelope.data?.anchors ?? [];
const buttons = anchors.filter((a) => a.tag === "button");
console.log(`inspect: ${anchors.length} anchors (${buttons.length} buttons)`);
for (const b of buttons.slice(0, 10)) console.log(`  ${b.anchor} <button> ${b.text ?? ""}`);

// 3. Parallel fan-out: one await, both reads in flight at once.
const [content, meta] = await Promise.all([
  bp.pageRead(browser.id, "content"),
  bp.pageRead(browser.id, "meta"),
]);
console.log(`content: ${content.success ? `${JSON.stringify(content.data).length} chars of JSON` : `FAILED: ${content.error}`}`);
console.log(`meta: ${meta.success ? JSON.stringify(meta.data).slice(0, 200) : `FAILED: ${meta.error}`}`);

// 4. Screenshot to disk (mkdir -p included).
const shot = await bp.saveScreenshot(browser.id, `quickstart-${browser.name}.png`, { overlay: "none" });
console.log(`screenshot: ${shot.filepath}`);
