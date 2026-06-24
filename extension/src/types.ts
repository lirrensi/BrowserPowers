export type PermissionLevel = "allow" | "deny" | "ask";

export type PagePermissionGroup = "page.read" | "page.act" | "page.execute";

export interface SitePermissionLists {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface ExtensionSettings {
  browserName: string;
  coreUrl: string;
  authKey: string;  // API key for core authentication (empty = none)
  approvalNotificationsEnabled: boolean;
  permissions: Record<string, PermissionLevel>;
  pageSitePermissions: Record<PagePermissionGroup, SitePermissionLists>;
}

// ── Page Interaction API v2 ──

export interface Target {
  css?: string;
  text?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
}

/**
 * FILE: extension/src/types.ts (ExecutionVerdict)
 * PURPOSE: Verdict contract returned by every JS execution path in the extension.
 *          BrowserPowers supports three execution worlds; the verdict's `world`
 *          field names the one actually used, and the `path` field names the
 *          exact code path:
 *            - "isolated" — content script's isolated world (DOM access only,
 *              no page variables, no page CSP). Used for: read / wait_for /
 *              click-element-resolution and as the fallback for page.js /
 *              page.act click / fill / type / press when CDP attach is denied.
 *              Also: check / select_option / submit (pure DOM mutations, no
 *              CDP path), press fallback, click_at / dblclick_at / hover_at
 *              are NOT isolated — they're pure CDP.
 *            - "main"     — CDP-driven `Runtime.evaluate` in the page main
 *              world (page variables accessible, no page CSP, requires
 *              `debugger` permission and shows the yellow infobar while
 *              attached). Used for: page.js, setElementValue (fill). The
 *              legacy MAIN-world `chrome.scripting.executeScript { world: MAIN }`
 *              path has been retired in favour of CDP.
 *            - "cdp"      — CDP `Input.*` commands (dispatchMouseEvent /
 *              insertText / dispatchKeyEvent) and any CDP-driven path that
 *              doesn't go through Runtime.evaluate but still requires the
 *              `debugger` permission. Used for: click, dblclick, hover, type
 *              (insertText), press (dispatchKeyEvent), click_at, dblclick_at,
 *              hover_at — all bypass page-level synthetic-event handlers and
 *              are CSP-immune.
 *          The `path` field disambiguates which surface was used:
 *            - "cdp.runtime.evaluate"          — page.js, setElementValue
 *            - "cdp.input.dispatchMouseEvent"  — click, dblclick, hover,
 *                                                click_at, dblclick_at, hover_at
 *            - "cdp.input.insertText"          — type (focusElement + insertText)
 *            - "cdp.input.dispatchKeyEvent"    — press (keyDown + keyUp)
 *            - "isolated.resolveAndLocate"     — first stage of CDP path
 *            - "isolated.fallbackClick"        — synthetic event fallback
 *            - "isolated.fallbackDblclick"     — synthetic event fallback
 *            - "isolated.fallbackHover"        — synthetic event fallback
 *            - "isolated.fallbackType"         — synthetic event fallback
 *            - "isolated.fallbackFill"         — native setter fallback
 *            - "isolated.fallbackKeyEvent"     — KeyboardEvent fallback for press
 *            - "isolated.dispatchEvent"        — check, select_option
 *            - "isolated.form.submit"          — submit
 *            - "isolated.scrollIntoView"       — scroll-to-element
 *            - "isolated.scrollBy"             — scroll by amount
 *            - "isolated.readable"             — readable content extraction
 *            - "isolated.fullHtml"             — full document HTML
 *            - "isolated.newFunction"          — page.js fallback, wait_for
 *                                                function condition
 *            - "isolated.waitFor"              — wait_for element conditions
 *            - "isolated.networkIdle"          — wait_for network_idle
 *            - "isolated.dialogOverride"       — dialog_*
 *            - "isolated.nativeSetter"         — fill_form
 *            - "isolated.fileInput"            — upload
 *            - "selftest.newFunction"          — content-script runtime self-test
 *          The verdict names the world AND the path so callers can always
 *          tell which surface actually ran.
 * OWNS: The shape of execution truth.
 * EXPORTS: ExecutionVerdict
 * DOCS: .agents/reports/plan_runtime-verdict_2026-06-22.md §1,
 *       .agents/reports/plan_cdp-max-authority_2026-06-22.md,
 *       .agents/reports/plan_cdp-input-parity_2026-06-23.md,
 *       .agents/reports/plan_visual-help-csp-tighten_2026-06-23.md
 */
export interface ExecutionVerdict {
  executed: boolean;                          // did the code actually run?
  world: "isolated" | "main" | "cdp";         // "isolated" = content script world; "main" = CDP Runtime.evaluate; "cdp" = CDP Input.*
  value?: unknown;                            // return value, if any
  error?: { name: string; message: string; line?: number; column?: number };
  eventFired?: boolean;                       // DOM actions: did the event reach the target?
  domMutated?: boolean;                       // DOM actions: did the DOM change?
  valueMatched?: boolean;                     // fill/type actions: did the element end with the expected value?
  pathTaken?: string;                         // resolution path used (shadow-walk | css-flat | text | anchor)
  durationMs: number;                         // measured round-trip
  path: string;                               // exact code path taken, e.g. "isolated.newFunction", "cdp.runtime.evaluate", or "cdp.input.dispatchMouseEvent"
}

export interface ActionResult {
  success: boolean;
  status: "performed" | "already_in_desired_state" | "not_performed" | "ambiguous" | "blocked";
  action: string;
  message: string;
  targetSummary?: string;
  evidence?: Record<string, unknown>;
  errorCode?: string;
  recoverable?: boolean;
  suggestions?: string[];
  data?: Record<string, unknown>;
  /** Additive — surfaces the content-script ExecutionVerdict when present. */
  executionVerdict?: ExecutionVerdict;
  /** Additive — the content script's RUNTIME_SELFTEST carried on every response. */
  runtimeStatus?: ExecutionVerdict;
}
