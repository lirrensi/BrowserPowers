/**
 * FILE: extension/src/net-install.ts
 * PURPOSE: One MAIN-world installer for the page.net hook via
 *          `chrome.scripting.executeScript ({ world: "MAIN" })`.
 *          Failures log the worker-side message (earlier versions swallowed
 *          it, making success-then-hook-died indistinguishable from failure).
 *          CDP `Page.addScriptToEvaluateOnNewDocument` was tried and dropped:
 *          registrations return identifiers but never fire (verified live —
 *          markers absent after both manual and CDP-driven reloads).
 * OWNS: runNetHookInstall
 * EXPORTS: runNetHookInstall
 */

/**
 * Install func into the page MAIN world. True on success, false otherwise.
 */
export async function runNetHookInstall(tabId: number, func: () => void): Promise<boolean> {
  // Primary: chrome.scripting.executeScript WORLD_MAIN. Earlier attempts
  // swallowed the error (returned false silently), so a failure here was
  // indistinguishable from success-then-hook-died. Now the error is logged
  // with its message — if this path fails we will SEE why.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: func as (...args: unknown[]) => unknown,
    });
    // Readback: the hook sets __bpNetHookInstalled synchronously on install.
    // Without this, a silent no-op (or a throw swallowed inside the func)
    // reports success while the page stays unhooked — the failure mode we
    // chased for a day.
    const [readback] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => (window as unknown as Record<string, unknown>).__bpNetHookInstalled === true,
    });
    const installed = readback?.result === true;
    if (!installed) {
      console.warn(`[bp-net] MAIN hook install readback FAILED on tab ${tabId} — executeScript succeeded but __bpNetHookInstalled is not set (func threw inside, or wrong world)`);
    }
    return installed;
  } catch (err) {
    console.warn(`[bp-net] scripting.executeScript WORLD_MAIN failed on tab ${tabId}: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}
