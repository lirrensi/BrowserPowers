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
 *              no page variables, no page CSP). Used for read / wait_for /
 *              click-element-resolution and as the fallback for page.js /
 *              page.act click / fill / type when CDP attach is denied.
 *            - "main"     — CDP-driven `Runtime.evaluate` (page variables
 *              accessible, no page CSP, requires `debugger` permission and
 *              shows the yellow infobar while attached). The previous
 *              meaning — MAIN-world `chrome.scripting.executeScript` — is no
 *              longer in use; the MAIN-world console-capture script that
 *              used it has been retired in favour of CDP.
 *            - "cdp"      — CDP `Input.*` commands (dispatchMouseEvent /
 *              insertText) and any CDP-driven path that doesn't go through
 *              Runtime.evaluate but still requires the `debugger` permission.
 *              Used by the page.act primary paths for click / dblclick /
 *              hover / type.
 *          The verdict names the world AND the path so callers can always
 *          tell which surface actually ran.
 * OWNS: The shape of execution truth.
 * EXPORTS: ExecutionVerdict
 * DOCS: .agents/reports/plan_runtime-verdict_2026-06-22.md §1,
 *       .agents/reports/plan_cdp-max-authority_2026-06-22.md,
 *       .agents/reports/plan_cdp-input-parity_2026-06-23.md
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
