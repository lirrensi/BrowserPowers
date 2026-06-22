/**
 * FILE: e2e/tests/runtime-verdict.test.ts
 * PURPOSE: Maat's regression suite for the runtime-verdict + shadow-DOM fix.
 *          Proves:
 *            1. page.js runs via CDP Runtime.evaluate — never returns CSP_BLOCKED.
 *               The verdict names the world ("main") and the exact path
 *               ("cdp.runtime.evaluate").
 *            2. page.read action=runtime_status returns the full surface state
 *               and the merged cdp block shows attached: true after a page.js call.
 *            3. page.act click on a button inside a shadow root succeeds and
 *               reports executionVerdict.eventFired === true.
 *            4. The same flow works on a CSP-strict page — page.js and page.act
 *               are immune to page CSP because CDP bypasses page CSP.
 *
 * OWNS: Verifies the principle documented in
 *       .agents/reports/plan_runtime-verdict_2026-06-22.md and
 *       .agents/reports/plan_cdp-max-authority_2026-06-22.md
 *
 * DOCS: plan_runtime-verdict_2026-06-22.md §3, §4, §5, §6,
 *       plan_cdp-max-authority_2026-06-22.md
 */

import { test, expect, type ExecuteResponse } from "../fixtures";
import type { Page, BrowserContext } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

type ExecTool = <T = unknown>(
  browserId: string,
  tool: string,
  params?: Record<string, unknown>,
) => Promise<ExecuteResponse<T>>;

/**
 * Pre-flight helper: open the extension's options page and set
 * page.execute (the group for page.js) and page.act to "allow" for `*`.
 *
 * Why: the default page.execute site rule is deny-for-* (security default).
 * The smoke test needs page.js to be allowed for the test URL. Doing it
 * through the UI exercises the real config flow rather than bypassing it.
 *
 * Idempotent: safe to call multiple times.
 */
async function allowPageExecuteAndAct(page: Page, context: BrowserContext): Promise<void> {
  // Find the extension's options page via its service worker URL.
  const worker = context.serviceWorkers().find((w) =>
    w.url().startsWith("chrome-extension://"),
  );
  if (!worker) throw new Error("Extension service worker not found — extension not loaded");
  const extId = new URL(worker.url()).host;

  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForSelector("textarea.site-pattern-ta", { timeout: 10_000 });

  // Three textareas per group: [data-group="..."][data-list="allow|ask|deny"]
  // For page.execute: put "*" in allow, empty others.
  for (const group of ["page.execute", "page.act"]) {
    const allowTa = page.locator(
      `textarea.site-pattern-ta[data-group="${group}"][data-list="allow"]`,
    );
    const askTa = page.locator(
      `textarea.site-pattern-ta[data-group="${group}"][data-list="ask"]`,
    );
    const denyTa = page.locator(
      `textarea.site-pattern-ta[data-group="${group}"][data-list="deny"]`,
    );

    // Clear all three, set allow to "*", then trigger the input event so
    // the debounced save picks it up.
    await allowTa.fill("*");
    await allowTa.dispatchEvent("input");
    await askTa.fill("");
    await askTa.dispatchEvent("input");
    await denyTa.fill("");
    await denyTa.dispatchEvent("input");
  }

  // Wait for the debounced save (600ms) plus some headroom.
  await page.waitForTimeout(900);
}

async function resolveActiveTabId(
  browserId: string,
  exec: ExecTool,
  identifier: string,
): Promise<number> {
  // Try the active tab first, then search by URL/title.
  const listAll = await exec<Array<{ id?: number; active?: boolean; title?: string; url?: string }>>(
    browserId,
    "tabs.list",
    {},
  );
  const all = (listAll.data ?? []) as Array<{ id?: number; active?: boolean; title?: string; url?: string }>;
  const byTitle = all.find((t) => t.title === identifier);
  if (byTitle?.id) return byTitle.id;
  const byUrl = all.find((t) => typeof t.url === "string" && t.url.includes(identifier));
  if (byUrl?.id) return byUrl.id;
  const active = all.find((t) => t.active && typeof t.id === "number");
  if (active?.id) return active.id;
  const any = all.find((t) => typeof t.id === "number");
  if (!any?.id) throw new Error("No tab found");
  return any.id;
}

async function setPageBody(page: Page, body: string, onLoadScript?: string): Promise<void> {
  // Use evaluate to wipe the body cleanly and inject the new content.
  // (We avoid page.setContent because it would replace the document and
  // the extension's content script is keyed off the original navigation.)
  await page.evaluate(
    ([bodyHtml, onLoad]) => {
      document.body.innerHTML = bodyHtml;
      if (onLoad) {
        // eslint-disable-next-line no-eval
        eval(onLoad);
      }
    },
    [body, onLoadScript ?? ""] as const,
  );
}

// ─────────────────────────────────────────────────────────────────────
// 1) Smoke test: page.js via CDP Runtime.evaluate must always run
// ─────────────────────────────────────────────────────────────────────

test.describe("Runtime Verdict — Smoke (CDP-driven main world)", () => {
  test("page.js evaluates 1+1 via CDP Runtime.evaluate and reports a verdict", async ({
    page,
    context,
    getBrowserId,
    executeBrowserTool,
  }) => {
    await allowPageExecuteAndAct(page, context);

    await page.goto("https://example.com/?bp=verdict-smoke-1");
    await setPageBody(page, "<h1>verdict smoke</h1>");

    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(
      browserId,
      executeBrowserTool as ExecTool,
      "example.com/?bp=verdict-smoke-1",
    );

    // 1. page.js with success code
    const ok = await executeBrowserTool<{
      data?: { result?: unknown };
      executionVerdict?: { executed?: boolean; world?: string; value?: unknown; durationMs?: number; path?: string };
      runtimeStatus?: { executed?: boolean; value?: unknown };
    }>(browserId, "page.js", { code: "1 + 1", tabId });
    expect(ok.success, "page.js 1+1 dispatch should succeed").toBe(true);
    const envelope = ok.data as
      | { data?: { result?: unknown }; executionVerdict?: { executed?: boolean; world?: string; value?: unknown; durationMs?: number; path?: string } }
      | undefined;
    const nested = envelope?.data?.result;
    expect(nested, "page.js result should be 2").toBe(2);
    expect(envelope?.executionVerdict?.executed, "verdict.executed should be true").toBe(true);
    expect(envelope?.executionVerdict?.world, "verdict.world should be 'main' (CDP-driven)").toBe("main");
    expect(envelope?.executionVerdict?.value, "verdict.value should be 2").toBe(2);
    expect(envelope?.executionVerdict?.path, "verdict.path should be 'cdp.runtime.evaluate'").toBe("cdp.runtime.evaluate");
    expect(
      typeof envelope?.executionVerdict?.durationMs === "number" &&
        Number.isFinite(envelope.executionVerdict.durationMs),
      "verdict.durationMs should be a finite number",
    ).toBe(true);

    // 2. page.js that throws — must NOT be wrapped as CSP_BLOCKED
    const err = await executeBrowserTool(browserId, "page.js", {
      code: "throw new Error('test')",
      tabId,
    });
    const errEnvelope = err.data as
      | {
          success?: boolean;
          message?: string;
          errorCode?: string;
          executionVerdict?: {
            executed?: boolean;
            world?: string;
            error?: { name?: string; message?: string };
            path?: string;
            durationMs?: number;
          };
        }
      | undefined;
    expect(errEnvelope?.success, "user code threw — envelope success should be false").toBe(false);
    expect(
      errEnvelope?.errorCode,
      "errorCode must be JS_EXECUTION_ERROR, not CSP_BLOCKED",
    ).toBe("JS_EXECUTION_ERROR");
    expect(
      errEnvelope?.errorCode !== "CSP_BLOCKED",
      "errorCode must NEVER be CSP_BLOCKED — page.js runs via CDP, which bypasses page CSP",
    ).toBe(true);
    expect(errEnvelope?.executionVerdict?.executed, "verdict.executed should be false").toBe(false);
    expect(errEnvelope?.executionVerdict?.world, "verdict.world should be 'main' (CDP-driven)").toBe("main");
    expect(
      errEnvelope?.executionVerdict?.error?.message,
      "verdict.error.message should include 'test'",
    ).toContain("test");

    // 3. runtime_status — must include merged `cdp` block with attached === true
    // after the page.js calls above.
    const status = await executeBrowserTool<{
      data?: {
        contentScript?: { alive?: boolean; selfTest?: { value?: number; executed?: boolean } };
        isolatedWorld?: { newFunctionWorks?: boolean; domAccessWorks?: boolean };
        cdp?: { attached?: boolean; version?: string; consoleBufferSize?: number; consoleCapture?: { status?: string; source?: string } };
        executeScriptPaths?: Array<{ name?: string; world?: string }>;
        registeredSurfaces?: string[];
      };
    }>(browserId, "page.read", { action: "runtime_status", tabId });
    const statusData = status.data as
      | {
          success?: boolean;
          data?: {
            contentScript?: { alive?: boolean; selfTest?: { value?: number; executed?: boolean } };
            isolatedWorld?: { newFunctionWorks?: boolean; domAccessWorks?: boolean };
            cdp?: { attached?: boolean; version?: string; consoleBufferSize?: number; consoleCapture?: { status?: string; source?: string } };
            executeScriptPaths?: Array<{ name?: string; world?: string }>;
            registeredSurfaces?: string[];
          };
        }
      | undefined;
    expect(statusData?.success, "runtime_status should succeed").toBe(true);

    const cs = statusData?.data?.contentScript;
    expect(cs?.alive, "contentScript.alive must be true").toBe(true);
    expect(cs?.selfTest?.value, "selfTest.value should be 5 (new Function(2,3) = 5)").toBe(5);

    const iw = statusData?.data?.isolatedWorld;
    expect(iw?.newFunctionWorks, "isolatedWorld.newFunctionWorks must be true").toBe(true);

    const paths = statusData?.data?.executeScriptPaths;
    expect(Array.isArray(paths), "executeScriptPaths should be an array").toBe(true);
    expect((paths ?? []).length, "executeScriptPaths should be non-empty").toBeGreaterThan(0);

    // CDP wiring proof — attached === true after the page.js calls above.
    const cdpBlock = statusData?.data?.cdp;
    expect(cdpBlock, "runtime_status.data.cdp should exist (SW merges it in)").toBeDefined();
    expect(
      cdpBlock?.attached,
      `cdp.attached must be true after at least one page.js call (got attached=${cdpBlock?.attached})`,
    ).toBe(true);
    expect(
      cdpBlock?.consoleCapture?.source,
      "cdp.consoleCapture.source should be 'cdp'",
    ).toBe("cdp");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2) Shadow-DOM click fixture
// ─────────────────────────────────────────────────────────────────────

test.describe("Runtime Verdict — Shadow DOM click", () => {
  test("click on a button inside a flat open shadow root fires the event and reports the verdict", async ({
    page,
    context,
    getBrowserId,
    executeBrowserTool,
  }) => {
    await allowPageExecuteAndAct(page, context);

    await page.goto("https://example.com/?bp=shadow-flat");
    await setPageBody(
      page,
      `
        <div id="host-flat"></div>
        <div id="status-flat">idle</div>
      `,
      `
        const host = document.getElementById('host-flat');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="inner-btn" data-testid="shadow-target">Shadow Button</button>';
        const btn = root.getElementById('inner-btn');
        const status = document.getElementById('status-flat');
        btn.addEventListener('click', () => { status.textContent = 'fired'; });
      `,
    );

    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(
      browserId,
      executeBrowserTool as ExecTool,
      "example.com/?bp=shadow-flat",
    );

    // inspect — should return an anchor for the shadow button.
    const inspect = await executeBrowserTool<{
      data?: { documentId?: string; anchors?: Array<{ anchor: string; target?: Record<string, unknown>; shadowPath?: string[] }> };
    }>(browserId, "page.read", { action: "inspect", tabId });
    expect(inspect.success, "inspect should succeed").toBe(true);
    const inspectData = inspect.data as { data?: { anchors?: Array<{ anchor: string; shadowPath?: string[]; target?: Record<string, unknown> }> } } | undefined;
    const anchors = inspectData?.data?.anchors ?? [];
    const shadowAnchor = anchors.find((a) => Array.isArray(a.shadowPath) && (a.shadowPath?.length ?? 0) > 0);
    expect(
      shadowAnchor,
      `inspect should return at least one anchor with a shadowPath (got ${anchors.length} anchors, first.shadowPath=${JSON.stringify(anchors[0]?.shadowPath)})`,
    ).toBeDefined();

    // click on the shadow button using the shadowPath
    const click = await executeBrowserTool(browserId, "page.act", {
      action: "click",
      tabId,
      target: { css: "#inner-btn" },
      shadowPath: shadowAnchor?.shadowPath,
    });
    expect(click.success, "click on shadow button should succeed").toBe(true);
    const clickData = click.data as { executionVerdict?: { executed?: boolean; world?: string; eventFired?: boolean; domMutated?: boolean; path?: string; durationMs?: number } } | undefined;
    const cv = clickData?.executionVerdict;
    expect(cv?.executed, "verdict.executed should be true").toBe(true);
    expect(cv?.world, "verdict.world should be 'isolated'").toBe("isolated");
    expect(cv?.eventFired, "verdict.eventFired should be true — the click reached the target").toBe(true);
    expect(cv?.path, "verdict.path should be 'isolated.elClick'").toBe("isolated.elClick");
    expect(
      typeof cv?.durationMs === "number" && Number.isFinite(cv.durationMs),
      "verdict.durationMs should be a finite number",
    ).toBe(true);

    // Side-effect verification: the click handler ran.
    const statusText = await page.locator("#status-flat").textContent();
    expect(statusText, "the click handler in the shadow root should have run").toBe("fired");
  });

  test("click on a button inside a nested shadow root (shadow inside shadow) fires the event", async ({
    page,
    context,
    getBrowserId,
    executeBrowserTool,
  }) => {
    await allowPageExecuteAndAct(page, context);

    await page.goto("https://example.com/?bp=shadow-nested");
    await setPageBody(
      page,
      `
        <div id="outer-host"></div>
        <div id="status-nested">idle</div>
      `,
      `
        const outer = document.getElementById('outer-host');
        const outerRoot = outer.attachShadow({ mode: 'open' });
        outerRoot.innerHTML = '<div id="inner-host"></div>';
        const innerHost = outerRoot.getElementById('inner-host');
        const innerRoot = innerHost.attachShadow({ mode: 'open' });
        innerRoot.innerHTML = '<button id="nested-btn" data-testid="nested-shadow-target">Nested Shadow Button</button>';
        const btn = innerRoot.getElementById('nested-btn');
        const status = document.getElementById('status-nested');
        btn.addEventListener('click', () => { status.textContent = 'nested-fired'; });
      `,
    );

    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(
      browserId,
      executeBrowserTool as ExecTool,
      "example.com/?bp=shadow-nested",
    );

    // inspect — find the nested shadow anchor. shadowPath should contain both hosts.
    const inspect = await executeBrowserTool(browserId, "page.read", { action: "inspect", tabId });
    type InspectAnchor = { anchor: string; shadowPath?: string[]; target?: Record<string, unknown> };
    const inspectData = inspect.data as { data?: { anchors?: InspectAnchor[] } } | undefined;
    const anchors = inspectData?.data?.anchors ?? [];
    const nestedAnchor = anchors.find(
      (a) => Array.isArray(a.shadowPath) && (a.shadowPath?.length ?? 0) >= 2,
    );
    expect(
      nestedAnchor,
      `inspect should return an anchor with a shadowPath containing at least 2 hosts (got ${anchors.length} anchors)`,
    ).toBeDefined();

    // click using the nested shadow path
    const click = await executeBrowserTool(browserId, "page.act", {
      action: "click",
      tabId,
      target: { css: "#nested-btn" },
      shadowPath: nestedAnchor?.shadowPath,
    });
    expect(click.success, "click on nested shadow button should succeed").toBe(true);
    const clickData = click.data as { executionVerdict?: { executed?: boolean; world?: string; eventFired?: boolean; path?: string; durationMs?: number } } | undefined;
    const cv = clickData?.executionVerdict;
    expect(cv?.executed, "verdict.executed should be true").toBe(true);
    expect(cv?.world, "verdict.world should be 'isolated'").toBe("isolated");
    expect(cv?.eventFired, "verdict.eventFired should be true for nested shadow root click").toBe(true);
    expect(cv?.path, "verdict.path should be 'isolated.elClick'").toBe("isolated.elClick");

    const statusText = await page.locator("#status-nested").textContent();
    expect(statusText, "the click handler in the nested shadow root should have run").toBe("nested-fired");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3) CSP-strict page e2e
// ─────────────────────────────────────────────────────────────────────

test.describe("Runtime Verdict — CSP-strict page", () => {
  test("page.js, page.act click, and runtime_status all work under a strict page CSP", async ({
    page,
    context,
    getBrowserId,
    executeBrowserTool,
  }) => {
    await allowPageExecuteAndAct(page, context);

    // Intercept any navigation and serve a strict-CSP page.
    // The Content-Security-Policy header forbids eval, inline scripts, and
    // any script-src other than 'self' (which we do not provide).
    await page.route("http://127.0.0.1:9999/**", (route) => {
      const url = route.request().url();
      if (url.endsWith("/csp-strict")) {
        route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: {
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
            "Cache-Control": "no-store",
          },
          body: `<!doctype html>
<html>
<head><title>CSP Strict Test</title></head>
<body>
  <h1>CSP Strict</h1>
  <button id="csp-btn" data-testid="csp-target">CSP Button</button>
  <div id="csp-status">idle</div>
</body>
</html>`,
        });
      } else {
        route.continue();
      }
    });

    await page.goto("http://127.0.0.1:9999/csp-strict");
    // Wire the button's click handler from the page world (allowed under
    // our strict CSP because the handler is bound via event listeners,
    // not inline script).
    await page.evaluate(() => {
      const btn = document.getElementById("csp-btn");
      const status = document.getElementById("csp-status");
      if (btn && status) {
        btn.addEventListener("click", () => {
          status.textContent = "csp-fired";
        });
      }
    });

    const browserId = await getBrowserId();
    const tabId = await resolveActiveTabId(
      browserId,
      executeBrowserTool as ExecTool,
      "127.0.0.1:9999/csp-strict",
    );

    // 1. page.js must work under strict CSP — CDP bypasses page CSP because
    // the debugger runs in the browser's privileged context, not the page's
    // JS context. This is the most meaningful test in this file: it proves
    // the CDP layer is wired and that page.js is genuinely CSP-immune.
    const js = await executeBrowserTool(browserId, "page.js", { code: "1 + 1", tabId });
    expect(js.success, "page.js dispatch should succeed under strict CSP").toBe(true);
    const jsData = js.data as
      | { data?: { result?: unknown }; executionVerdict?: { world?: string; path?: string; executed?: boolean; value?: unknown } }
      | undefined;
    expect(jsData?.data?.result, "page.js result should be 2").toBe(2);
    expect(jsData?.executionVerdict?.world, "verdict.world should be 'main' (CDP-driven)").toBe("main");
    expect(jsData?.executionVerdict?.path, "verdict.path should be 'cdp.runtime.evaluate'").toBe("cdp.runtime.evaluate");
    expect(jsData?.executionVerdict?.executed, "verdict.executed should be true").toBe(true);
    expect(jsData?.executionVerdict?.value, "verdict.value should be 2").toBe(2);

    // 2. page.act click on a button must work under strict CSP (isolated world)
    const click = await executeBrowserTool(browserId, "page.act", {
      action: "click",
      tabId,
      target: { css: "#csp-btn" },
    });
    expect(click.success, "page.act click should succeed under strict CSP").toBe(true);
    const clickData = click.data as { executionVerdict?: { world?: string; eventFired?: boolean; executed?: boolean } } | undefined;
    const cv = clickData?.executionVerdict;
    expect(cv?.world, "verdict.world should be 'isolated'").toBe("isolated");
    expect(cv?.executed, "verdict.executed should be true").toBe(true);
    expect(cv?.eventFired, "verdict.eventFired should be true — click reached the target").toBe(true);

    const statusText = await page.locator("#csp-status").textContent();
    expect(statusText, "click handler should have fired on the CSP-strict page").toBe("csp-fired");

    // 3. runtime_status — contentScript + isolatedWorld stay isolated. The
    // CDP block is the new console-capture surface and is attached: true
    // (CDP bypasses page CSP). The legacy "main-world-blocked" value is
    // no longer reachable — there is no MAIN-world script to be blocked.
    const status = await executeBrowserTool(browserId, "page.read", { action: "runtime_status", tabId });
    const statusData = status.data as
      | {
          data?: {
            contentScript?: { alive?: boolean };
            isolatedWorld?: { newFunctionWorks?: boolean };
            cdp?: { attached?: boolean; consoleCapture?: { status?: string; source?: string } };
          };
        }
      | undefined;

    expect(statusData?.data?.contentScript?.alive, "contentScript.alive should be true").toBe(true);
    expect(statusData?.data?.isolatedWorld?.newFunctionWorks, "isolatedWorld.newFunctionWorks should be true").toBe(true);
    expect(
      statusData?.data?.cdp?.attached,
      "cdp.attached should be true — CDP bypasses page CSP",
    ).toBe(true);
    expect(
      statusData?.data?.cdp?.consoleCapture?.status,
      "cdp.consoleCapture.status should be 'ready' (CDP bypasses page CSP)",
    ).toBe("ready");
  });
});
