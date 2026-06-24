/**
 * FILE: manual-tests/lib/browser.mjs
 * PURPOSE: Helpers for the manual-test harness.
 *          Every script in manual-tests/ uses these to talk to a real
 *          browser (the user's, with the BrowserPowers extension
 *          loaded) via the core REST API. No browser launching. No
 *          Playwright. The browser stays open the whole time.
 *
 *          The browser is found by hitting GET /api/browsers. We
 *          filter for the one that has the new capabilities (page.js,
 *          screenshots.capture with overlay, etc.) and use only that
 *          one — the user opens one browser, we use that one.
 *
 *          If the browser has no windows open (Chrome may be running
 *          with the service worker alive but all windows closed), the
 *          test calls `ensureWindow` to create one.
 *
 * OWNS: Test harness HTTP client + browser discovery + test page loader.
 * EXPORTS: findBrowser, ensureWindow, executeTool, navigate, dataUrl,
 *          pageFromFile, expect
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";

const CORE_BASE = process.env.BP_CORE ?? "http://127.0.0.1:4199";
const API = `${CORE_BASE}/api`;
const TESTS_DIR = dirname(fileURLToPath(import.meta.url)) + "/..";

/** Caps the new test plan (plan_visual-help-csp-tighten_2026-06-23) requires.
 *  page.read + page.act are the universal baseline; tests that need
 *  page.js or other tools should pass `require` explicitly. */
const REQUIRED_NEW_CAPS = ["page.read", "page.act", "screenshots.capture"];

/**
 * Find the one connected browser. Errors if zero or more than one
 * has the new capabilities. The user opens one browser with the
 * loaded extension; we use only that one.
 *
 * Pass `{ lenient: true }` to skip the new-cap filter and pick the
 * first connected browser — used by reload-extension.mjs which runs
 * BEFORE the browser has registered the new capabilities.
 */
export async function findBrowser({ require = REQUIRED_NEW_CAPS, lenient = false } = {}) {
  const res = await fetch(`${API}/browsers`);
  if (!res.ok) throw new Error(`GET /api/browsers → ${res.status} ${res.statusText}`);
  const { browsers } = await res.json();
  if (!Array.isArray(browsers) || browsers.length === 0) {
    throw new Error(
      "No browser connected to the core. Open Chrome, load the BrowserPowers extension, " +
      "and connect it to the core. Then re-run this test.",
    );
  }
  if (lenient) {
    if (browsers.length > 1) {
      console.warn(`Multiple browsers connected; using the first one ("${browsers[0].name}")`);
    }
    return browsers[0];
  }
  const matches = browsers.filter((b) => require.every((c) => (b.capabilities ?? []).includes(c)));
  if (matches.length === 0) {
    const caps = browsers.map((b) => `  ${b.id} "${b.name}" — caps: ${(b.capabilities ?? []).join(", ")}`).join("\n");
    throw new Error(
      `No browser has the required new capabilities: ${require.join(", ")}.\n` +
      `Connected browsers:\n${caps}\n` +
      `Reload the extension from the freshly-built output:\n` +
      `  1. Run: node scripts/install.mjs   (copies the new build)\n` +
      `  2. Open chrome://extensions\n` +
      `  3. Click the reload icon on BrowserPowers (or run: node manual-tests/reload-extension.mjs)\n` +
      `  4. Re-run this test.`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((b) => `${b.id} "${b.name}"`).join(", ");
    throw new Error(
      `Multiple browsers with new capabilities: ${ids}.\n` +
      `Disconnect extras — this harness uses one browser at a time.`,
    );
  }
  return matches[0];
}

/**
 * Make sure the browser has at least one window open with a tab.
 * If `url` is given, create a new window with that URL. Returns the
 * window object from chrome.windows.create, OR undefined if a
 * window already existed.
 *
 * Why: the user may have closed all Chrome windows but the extension
 * service worker is still running. Without a window there's no
 * active tab, so tabs.navigate / page.read all fail with "No active
 * tab found". Creating a window fixes that.
 */
export async function ensureWindow(browserId, url) {
  // First, are there any tabs at all?
  const tabs = await executeTool(browserId, "tabs.list", { limit: 1 });
  const tdata = tabs.data?.data ?? tabs.data ?? tabs;
  if (Array.isArray(tdata.tabs) && tdata.tabs.length > 0) {
    return undefined; // already have a window
  }
  // No tabs — create a window.
  const w = await executeTool(browserId, "windows.create", url ? { url } : {});
  console.log(`Created window (no windows were open): id=${w.data?.data?.id ?? w.data?.id ?? "?"}`);
  return w;
}

/**
 * POST /api/browsers/:id/execute. Returns the parsed JSON body, OR
 * throws with a clear message.
 */
export async function executeTool(browserId, tool, params = {}) {
  const url = `${API}/browsers/${browserId}/execute`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} → ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

/** Convenience: navigate the browser's active tab to a URL. */
export async function navigate(browserId, url) {
  return executeTool(browserId, "tabs.navigate", { url, wait_until: "complete" });
}

/**
 * Poll the content script until it responds to `runtime_status`,
 * which means it's loaded and the page is ready for inspect/fill/etc.
 * Throws if it doesn't come up within `timeoutMs`.
 *
 * Why: chrome.tabs.sendMessage right after tabs.create / tabs.update
 * can race the content script injection. Wait for it.
 *
 * The runtime_status call returns success: true at the ActionResult
 * envelope level when the content script is alive, regardless of the
 * `RUNTIME_SELFTEST.executed` field (the self-test is a deeper
 * check that may legitimately fail on pages with strict CSP).
 */
export async function waitForContentScript(browserId, { timeoutMs = 5000, intervalMs = 200 } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await executeTool(browserId, "page.read", { action: "runtime_status" });
      // Unwrap ActionResult envelope. We just need the call to succeed.
      const envelope = r.data ?? r;
      if (envelope?.success === true) return envelope;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Content script did not become ready within ${timeoutMs}ms. ` +
    `Last error: ${lastErr?.message ?? "(none)"}. ` +
    `Try: open the tab manually, click the extension icon, or check that the extension has access to the current page.`,
  );
}

/** Build a data: URL from inline HTML — useful for ad-hoc tests. */
export function dataUrl(html, { mime = "text/html" } = {}) {
  return `data:${mime};charset=utf-8,${encodeURIComponent(html)}`;
}

/** Read a pre-made HTML file from manual-tests/test-pages/ and encode as data: URL. */
export function pageFromFile(name) {
  const path = resolve(TESTS_DIR, "test-pages", name);
  const html = readFileSync(path, "utf-8");
  return dataUrl(html);
}

// ── Tiny static test-page server ────────────────────────────────────────
//
// data: URLs don't trigger content-script injection in Chrome MV3 — the
// extension's content script registers on <all_urls> but Chrome skips
// some "unstable" schemes. So we serve the test pages from a tiny local
// HTTP server that auto-starts on a free port.

let testServer = null;
let testServerPort = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the test-page HTTP server (idempotent — reuses the running one).
 * Returns the base URL like `http://127.0.0.1:51823`.
 */
export async function startTestServer() {
  if (testServer) return `http://127.0.0.1:${testServerPort}`;
  testServerPort = await findFreePort();
  const root = resolve(TESTS_DIR, "test-pages");
  testServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${testServerPort}`);
    let path = join(root, url.pathname === "/" ? "index.html" : url.pathname);
    // Path-traversal guard.
    if (!path.startsWith(root)) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      // Try .html fallback (so /article serves /article.html)
      if (existsSync(path + ".html")) path = path + ".html";
      else { res.writeHead(404); res.end("not found"); return; }
    }
    const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    res.end(readFileSync(path));
  });
  await new Promise((r) => testServer.listen(testServerPort, "127.0.0.1", r));
  testServer.unref(); // don't keep the event loop alive just for the server
  return `http://127.0.0.1:${testServerPort}`;
}

/** Build a URL to a test page served by the local server. Starts the server if needed. */
export async function testPageUrl(name) {
  const base = await startTestServer();
  // Allow callers to pass "article" or "article.html"
  const path = name.endsWith(".html") ? name : `${name}.html`;
  return `${base}/${path}`;
}

/** Stop the test-page server. Called by the runner at the end. */
export function stopTestServer() {
  if (!testServer) return;
  testServer.close();
  testServer = null;
  testServerPort = 0;
}

/** Tiny assertion helper. Throws with a labelled message on failure. */
export function expect(actual, predicate, label) {
  const ok = typeof predicate === "function" ? !!predicate(actual) : actual === predicate;
  if (!ok) {
    const got = typeof actual === "object" ? JSON.stringify(actual).slice(0, 400) : String(actual);
    throw new Error(`assertion failed: ${label}\n  got: ${got}`);
  }
  return actual;
}

export { CORE_BASE, API, TESTS_DIR };


