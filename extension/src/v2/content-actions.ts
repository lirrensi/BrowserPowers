/**
 * FILE: extension/src/v2/content-actions.ts
 * PURPOSE: All DOM interaction logic as real TypeScript functions — loaded in the persistent
 *          content script at document_start, replacing the fragile string-body injection pattern.
 * OWNS: Target resolution, inspection, act actions, dialog control, wait conditions, read operations.
 * EXPORTS: resolveTarget, inspectElements, listFrames,
 *          walkShadowPath, getShadowHostChain,
 *          clickElement, fillElement, checkElement, selectOption, pressKeys,
 *          scrollElement, submitForm, typeText, uploadFile, dragElement,
 *          dblclickElement, hoverElement, dialogOverride, dialogRespond,
 *          waitForElement, waitForTarget, waitForNetworkIdle, waitForFunction,
 *          fillFormFields,
 *          readContent, readTexts, readHtml, readAttr, readMeta, readForms,
 *          countElements, selectText, readSummary, generateSelector,
 *          initConsoleCapture, getConsoleEntries
 * DOCS: .agents/reports/plan_content-script-arch_2026-05-28.md,
 *       .agents/reports/plan_runtime-verdict_2026-06-22.md
 */

// ── Types ──

import type { ExecutionVerdict } from "../types.js";

export type { ExecutionVerdict } from "../types.js";

export interface Target {
  css?: string;
  text?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  /** Optional Playwright-style ">>"-separated chain (e.g. "my-app >> .btn-save"). */
  cssChain?: string[];
  /** Optional explicit shadow host chain (tag names) leading to a target inside a shadow root. */
  shadowPath?: string[];
}

export interface ActResult {
  success: boolean;
  message: string;
  evidence?: Record<string, unknown>;
  errorCode?: string;
  blocked?: boolean;
  matchCount?: number;
  /** Additive — every act path emits an ExecutionVerdict. */
  executionVerdict?: ExecutionVerdict;
}

export interface InspectResult {
  url: string;
  title: string;
  documentId: string;
  anchors: Array<Record<string, unknown>>;
}

export interface ResolutionResult {
  element?: Element;
  source?: string;
  summary?: string;
  matchCount?: number;
  found: boolean;
  error?: string;
  /** Which resolution strategy produced this result. */
  pathTaken?: "shadow-walk" | "css-chain" | "css-flat" | "text" | "anchor" | "role" | "label" | "placeholder" | "testId";
}

export interface FrameInfo {
  index: number;
  id?: string;
  name?: string;
  src?: string;
  sameOrigin: boolean;
  title?: string;
  url?: string;
}

// ── CSS Escape Helper ──

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  // Manual fallback: escape \, ", ], >, +, ~, :
  return value.replace(/[\\"\]>+~:]/g, '\\$&');
}

// ── Shadow-DOM Helpers ──

/**
 * Walk a host-chain of shadow roots to find an element matching `leafSelector`.
 * `path` is an array of CSS selectors — each one resolves the next shadow host
 * in the chain. The leaf is then resolved with `leafSelector`.
 *
 * Example: walkShadowPath(["my-app", "inner-card"], "button.btn-save")
 *   → finds document.querySelector("my-app").shadowRoot.querySelector("inner-card").shadowRoot.querySelector("button.btn-save")
 *
 * Returns null if any host is missing or its shadowRoot is closed.
 */
export function walkShadowPath(path: string[], leafSelector: string): Element | null {
  if (!path || path.length === 0) return null;
  let scope: Document | ShadowRoot = document;
  // Walk the host chain. The last entry of `path` is the deepest host
  // whose shadow root we should query with the leaf selector.
  for (let i = 0; i < path.length; i++) {
    const sel = path[i];
    const host: Element | null = scope.querySelector(sel);
    if (!host) return null;
    if (i === path.length - 1) {
      // Last host: query its shadow root (if any) OR fall through to leaf
      if (host.shadowRoot) {
        return host.shadowRoot.querySelector(leafSelector);
      }
      // No shadow on last host — query the host subtree directly
      return host.querySelector(leafSelector);
    }
    // Intermediate host: must have a shadow root
    if (!host.shadowRoot) return null;
    scope = host.shadowRoot;
  }
  return null;
}

/**
 * Build the shadow-host chain for a given element: starts with the element itself,
 * then walks up through every ShadowRoot.host, ending at the top-level element
 * (the one whose root is the document).
 *
 * Example: a button inside <my-app> inside <body> in MAIN world →
 *   [button, my-app, body, html]
 */
export function getShadowHostChain(el: Element): Element[] {
  const chain: Element[] = [el];
  let node: Node | null = el;
  while (node) {
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      const host = root.host as Element;
      chain.push(host);
      node = host;
    } else {
      break;
    }
  }
  return chain;
}

// ── Target Resolution ──

export function resolveTarget(target: Target, anchorShadowPath?: string[]): ResolutionResult {
  if (!target) return { found: false, error: "No target or anchor provided" };

  // 1. Explicit shadow path on the Target object itself
  const effectiveShadowPath = target.shadowPath && target.shadowPath.length > 0
    ? target.shadowPath
    : anchorShadowPath && anchorShadowPath.length > 0
      ? anchorShadowPath
      : undefined;

  // 2. Playwright-style ">>" chain in target.cssChain
  if (target.cssChain && target.cssChain.length > 0) {
    const chain = target.cssChain.map((s) => s.trim()).filter((s) => s.length > 0);
    if (chain.length > 0) {
      const leaf = chain[chain.length - 1];
      const hosts = chain.slice(0, -1);
      const el = walkShadowPath(hosts, leaf);
      if (el) {
        return {
          element: el,
          source: "css-chain",
          summary: chain.join(" >> "),
          matchCount: 1,
          found: true,
          pathTaken: "css-chain",
        };
      }
    }
  }

  // 3. Shadow path resolution
  if (effectiveShadowPath && target.css) {
    const el = walkShadowPath(effectiveShadowPath, target.css);
    if (el) {
      return {
        element: el,
        source: "shadow-walk",
        summary: [...effectiveShadowPath, target.css].join(" >> "),
        matchCount: 1,
        found: true,
        pathTaken: "shadow-walk",
      };
    }
    // Shadow walk failed — fall through to flat fallback, but record the path we tried.
    const flat = resolveTargetFlat(target, "css-flat");
    if (flat.found) return { ...flat, pathTaken: "css-flat" };
    return flat;
  }

  // 4. Flat fallback (the existing logic)
  return resolveTargetFlat(target, "css-flat");
}

function resolveTargetFlat(target: Target, defaultPathTaken: ResolutionResult["pathTaken"]): ResolutionResult {
  const candidates: Array<{ element: Element; source: string; summary: string; pathTaken: ResolutionResult["pathTaken"] }> = [];

  function collect(selector: string, source: string, pathTaken: ResolutionResult["pathTaken"]): void {
    try {
      const els = document.querySelectorAll(selector);
      for (let i = 0; i < els.length; i++) {
        candidates.push({ element: els[i], source, summary: selector, pathTaken });
        // Penetrate open shadow roots
        if (els[i].shadowRoot) {
          const shadowEls = els[i].shadowRoot!.querySelectorAll(selector);
          for (let j = 0; j < shadowEls.length; j++) {
            candidates.push({ element: shadowEls[j], source: source + "(shadow)", summary: selector, pathTaken });
          }
        }
      }
      // Penetrate same-origin iframes
      const frames = document.querySelectorAll<HTMLIFrameElement>("iframe");
      for (let f = 0; f < frames.length; f++) {
        try {
          if (frames[f].contentDocument) {
            const frameEls = frames[f].contentDocument!.querySelectorAll(selector);
            for (let k = 0; k < frameEls.length; k++) {
              candidates.push({ element: frameEls[k], source, summary: selector, pathTaken });
            }
          }
        } catch (_) { /* cross-origin */ }
      }
    } catch (_) { /* invalid selector */ }
  }

  if (target.css) collect(target.css, "css", "css-flat");
  if (target.role) {
    const roleSel = `[role="${cssEscape(target.role)}"]`;
    collect(roleSel, "role", "role");
  }
  if (target.label) {
    collect(`[aria-label="${cssEscape(target.label)}"]`, "label", "label");
    collect(`[aria-labelledby="${cssEscape(target.label)}"]`, "label", "label");
  }
  if (target.placeholder) {
    collect(`[placeholder="${cssEscape(target.placeholder)}"]`, "placeholder", "placeholder");
  }
  if (target.testId) {
    collect(`[data-testid="${cssEscape(target.testId)}"]`, "testId", "testId");
  }
  if (target.text) {
    const clickables = document.querySelectorAll(
      'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [tabindex]',
    );
    const t = target.text.toLowerCase();
    for (let ci = 0; ci < clickables.length; ci++) {
      const textContent = (clickables[ci].textContent || "").trim().toLowerCase();
      if (textContent.includes(t)) {
        candidates.push({ element: clickables[ci], source: "text", summary: "text:" + target.text, pathTaken: "text" });
      }
    }
  }

  if (candidates.length === 0) {
    return { found: false, error: "No element matched target", matchCount: 0, pathTaken: defaultPathTaken };
  }

  // Deduplicate by element reference
  const seen = new Set<Element>();
  const unique: typeof candidates = [];
  for (const c of candidates) {
    if (!seen.has(c.element)) {
      seen.add(c.element);
      unique.push(c);
    }
  }

  // If role+name, filter by name
  if (target.role && target.name) {
    const nameLower = target.name.toLowerCase();
    const named = unique.filter((u) => {
      const el = u.element as HTMLElement;
      const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
      const text = (el.textContent || "").trim().toLowerCase();
      const val = (el.getAttribute("value") || "").toLowerCase();
      return ariaLabel === nameLower || text === nameLower || val === nameLower;
    });
    if (named.length > 0) {
      return {
        element: named[0].element,
        source: named[0].source,
        summary: named[0].summary,
        matchCount: named.length,
        found: true,
        pathTaken: named[0].pathTaken,
      };
    }
  }

  return {
    element: unique[0].element,
    source: unique[0].source,
    summary: unique[0].summary,
    matchCount: unique.length,
    found: true,
    pathTaken: unique[0].pathTaken,
  };
}

// ── Inspection ──

export function inspectElements(
  limit: number,
  includeHidden: boolean,
  compact: boolean,
): InspectResult {
  const maxAnchors = limit || 50;
  const isCompact = !!compact;
  let anchorIndex = 0;

  function isInteractable(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const type = el.getAttribute("type") || "";

    const clickable =
      tag === "button" ||
      tag === "a" ||
      tag === "select" ||
      tag === "textarea" ||
      (tag === "input" && type !== "hidden") ||
      role === "button" ||
      role === "link" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "textbox" ||
      role === "combobox" ||
      role === "listbox" ||
      role === "tab" ||
      role === "menuitem" ||
      role === "option" ||
      el.hasAttribute("onclick") ||
      el.hasAttribute("tabindex") ||
      el.getAttribute("contenteditable") === "true";

    if (!clickable) return false;

    if (!includeHidden) {
      const htmlEl = el as HTMLElement;
      if (htmlEl.style.display === "none" || htmlEl.style.visibility === "hidden") return false;
      if (htmlEl.offsetParent === null && tag !== "a") {
        if (!el.getAttribute("aria-hidden")) return false;
      }
      if (el.getClientRects().length === 0 && tag !== "a") return false;
    }

    return true;
  }

  function getTarget(el: Element): Target {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const ariaLabel = el.getAttribute("aria-label");
    const placeholder = el.getAttribute("placeholder");
    const testId = el.getAttribute("data-testid");
    const text = (el.textContent || "").trim().slice(0, 100) || el.getAttribute("value") || "";

    if (role && ariaLabel) return { role, name: ariaLabel };
    if (role && text) return { role, name: text };
    if (testId) return { testId };
    if (ariaLabel) return { label: ariaLabel };
    if (placeholder) return { placeholder };
    if (el.id) return { css: "#" + el.id };
    if (tag === "button" || tag === "a") return { text };
    return { css: tag + (el.className ? "." + el.className.trim().split(/\s+/).join(".") : "") };
  }

  function getAnchorInfo(el: Element, compact: boolean, pathStack: string[]): Record<string, unknown> {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    const ariaLabel = el.getAttribute("aria-label");
    const placeholder = el.getAttribute("placeholder");
    const text = (el.textContent || "").trim().slice(0, 100);
    const htmlEl = el as HTMLElement;

    anchorIndex++;
    const id = "a" + anchorIndex;

    // The leaf selector is what getTarget() produces. The shadow path is the
    // chain of HOST tag names leading to this element (the element's own tag
    // is NOT in the path — it's the leaf, identified by the existing
    // `target.css`). Together: `walkShadowPath(shadowPath, target.css)`.
    const leafTarget = getTarget(el);
    const shadowPath = pathStack.length > 0 ? [...pathStack] : undefined;

    if (!compact) {
      const visible = !!(htmlEl.offsetParent !== null || tag === "a");
      const enabled = !(htmlEl as HTMLInputElement).disabled;
      const checked = (htmlEl as HTMLInputElement).checked;
      const selected = (htmlEl as HTMLOptionElement).selected;

      const info: Record<string, unknown> = {
        anchor: id,
        role: role || tag,
        name: ariaLabel || text.slice(0, 50) || undefined,
        label: ariaLabel || undefined,
        placeholder: placeholder || undefined,
        text: text || undefined,
        tag,
        type: type || undefined,
        visible,
      };
      if (enabled !== undefined) info.enabled = enabled;
      if (checked !== undefined) info.checked = checked;
      if (selected !== undefined) info.selected = selected;
      info.target = leafTarget;
      if (shadowPath) info.shadowPath = shadowPath;
      return info;
    }

    const info: Record<string, unknown> = {
      anchor: id,
      tag,
      text: text || undefined,
    };
    info.target = leafTarget;
    if (shadowPath) info.shadowPath = shadowPath;
    return info;
  }

  function walkElements(root: Node, collected: Array<Record<string, unknown>>, pathStack: string[]): void {
    if (collected.length >= maxAnchors) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node: Node | null;
    while ((node = walker.nextNode()) && collected.length < maxAnchors) {
      const el = node as Element;
      if (isInteractable(el)) {
        collected.push(getAnchorInfo(el, isCompact, pathStack));
      }
      if ((el as HTMLElement).shadowRoot) {
        // Enter shadow root: push this host's tag, recurse, pop on return.
        const hostTag = el.tagName.toLowerCase();
        pathStack.push(hostTag);
        walkElements((el as HTMLElement).shadowRoot!, collected, pathStack);
        pathStack.pop();
      }
    }
  }

  const collected: Array<Record<string, unknown>> = [];
  const rootEl = document.body ?? document.documentElement;
  if (rootEl) {
    walkElements(rootEl, collected, []);
  }

  const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe");
  for (let fi = 0; fi < iframes.length; fi++) {
    if (collected.length >= maxAnchors) break;
    try {
      if (iframes[fi].contentDocument && iframes[fi].contentDocument!.body) {
        walkElements(iframes[fi].contentDocument!.body, collected, []);
      }
    } catch (_) { /* cross-origin */ }
  }

  const documentId = "doc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  return {
    url: location.href,
    title: document.title,
    documentId,
    anchors: collected.slice(0, maxAnchors),
  };
}

export function listFrames(): FrameInfo[] {
  const frames: FrameInfo[] = [];
  const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe");
  for (let i = 0; i < iframes.length; i++) {
    const iframe = iframes[i];
    const frameInfo: FrameInfo = {
      index: i,
      id: iframe.id || undefined,
      name: iframe.name || undefined,
      src: (iframe.src || "").slice(0, 200),
      sameOrigin: false,
    };
    try {
      if (iframe.contentDocument) {
        frameInfo.sameOrigin = true;
        frameInfo.title = iframe.contentDocument.title || undefined;
        frameInfo.url = iframe.contentDocument.URL || undefined;
      }
    } catch (_) {
      // Cross-origin — can't access content
    }
    frames.push(frameInfo);
  }
  return frames;
}

// ── Act Actions ──

function isDescendantOrSelf(ancestor: Element, descendant: Element): boolean {
  let current: Element | null = descendant;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentElement;
  }
  return false;
}

export function clickElement(el: Element, clickDelayMs?: number): Promise<ActResult> {
  if (!el) return Promise.resolve({ success: false, message: "No element" });
  if ((el as HTMLInputElement).disabled) return Promise.resolve({ success: false, message: "Element is disabled" });

  return new Promise((resolve) => {
    const start = performance.now();
    el.scrollIntoView({ behavior: "instant", block: "center" });
    setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const topEl = document.elementFromPoint(cx, cy);

      // Shadow-aware actionability gate.
      // Acceptable if:
      //   - topEl === el (exact hit)
      //   - topEl is a descendant of el (light-DOM overlay within our element)
      //   - topEl is in el's shadow-host chain (target is inside a shadow root;
      //     host is the topmost visible hit) — this is the common case for
      //     custom elements that host the real interactive control.
      //   - el is a descendant of topEl, AND topEl is interactable (existing
      //     conservative behaviour for clickable wrappers).
      const chain = getShadowHostChain(el);
      const hostChain = new Set(chain);
      const gateOk = !!topEl && (
        topEl === el
        || isDescendantOrSelf(topEl, el)
        || hostChain.has(topEl)
        || (isDescendantOrSelf(el, topEl) && isInteractableForGate(topEl))
      );

      if (topEl && !gateOk) {
        const topHtml = topEl as HTMLElement;
        const topTag = topHtml.tagName.toLowerCase();
        const topRole = topHtml.getAttribute("role") || "";
        const topClass = (topHtml.className || "").toString().slice(0, 50);
        const durationMs = performance.now() - start;
        resolve({
          success: false,
          message: "Click intercepted by overlay",
          evidence: {
            targetTag: el.tagName.toLowerCase(),
            overlayTag: topTag,
            overlayRole: topRole,
            overlayClass: topClass,
            targetCenterX: Math.round(cx),
            targetCenterY: Math.round(cy),
          },
          blocked: true,
          executionVerdict: {
            executed: false,
            world: "isolated",
            durationMs,
            path: "isolated.elClick",
            error: { name: "ClickBlocked", message: `Overlay ${topTag} covers target ${el.tagName.toLowerCase()}` },
          },
        });
        return;
      }

      // Install a one-shot capture-phase click listener that records whether
      // the event reached the target. We dispatch a composed MouseEvent first
      // (so listeners inside shadow roots see it), then fall back to el.click()
      // which fires its own (non-composed) click.
      let eventFired = false;
      const onCapture = (ev: Event): void => {
        if (ev.type === "click" && (ev.target === el || (ev.target && chain.includes(ev.target as Element)))) {
          eventFired = true;
        }
      };
      // Capture phase: gets the event before the target. `composed: true` lets
      // it traverse shadow boundaries.
      document.addEventListener("click", onCapture, { capture: true, once: false });

      try {
        // 1) Synthetic composed dispatch — reaches listeners inside shadow roots.
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        // 2) Native click() — synthesises a non-composed event through the
        // element's normal event path. Belt-and-braces for non-shadow cases.
        (el as HTMLElement).click();
      } catch (e) {
        document.removeEventListener("click", onCapture, { capture: true });
        const durationMs = performance.now() - start;
        resolve({
          success: false,
          message: `Click dispatch failed: ${(e as Error).message}`,
          errorCode: "CLICK_FAILED",
          executionVerdict: {
            executed: false,
            world: "isolated",
            durationMs,
            path: "isolated.elClick",
            error: { name: (e as Error).name || "Error", message: (e as Error).message || String(e) },
          },
        });
        return;
      }

      // Flush synchronous event delivery before removing the probe.
      setTimeout(() => {
        document.removeEventListener("click", onCapture, { capture: true });
        const durationMs = performance.now() - start;
        resolve({
          success: true,
          message: `Clicked ${el.tagName.toLowerCase()}${el.textContent ? ' "' + el.textContent.trim().slice(0, 30) + '"' : ""}`,
          evidence: { tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 100) },
          executionVerdict: {
            executed: true,
            world: "isolated",
            eventFired,
            domMutated: true,
            durationMs,
            path: "isolated.elClick",
          },
        });
      }, 0);
    }, clickDelayMs ?? 100);
  });
}

/** Minimal interactability check used by the click gate (lighter than the
 *  inspect-time isInteractable — only what we need to accept wrappers). */
function isInteractableForGate(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || tag === "summary" || tag === "label") return true;
  const role = el.getAttribute("role") || "";
  if (role === "button" || role === "link" || role === "checkbox" || role === "radio") return true;
  if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
  return false;
}

export function fillElement(el: Element, value: string): ActResult {
  const start = performance.now();
  if (!el) {
    return {
      success: false,
      message: "No element",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.nativeSetter" },
    };
  }
  const input = el as HTMLInputElement;

  // Bypass React controlled input protection
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype, "value"
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const valueMatched = input.value === value;
  return {
    success: true,
    message: `Filled with value`,
    evidence: { tag: el.tagName.toLowerCase() },
    executionVerdict: {
      executed: true,
      world: "isolated",
      value: input.value,
      valueMatched,
      domMutated: true,
      durationMs: performance.now() - start,
      path: "isolated.nativeSetter",
    },
  };
}

export function checkElement(el: Element, checked?: boolean): ActResult {
  const start = performance.now();
  const input = el as HTMLInputElement;
  if (!el || (input.type !== "checkbox" && input.type !== "radio")) {
    return {
      success: false,
      message: "Not a checkbox/radio",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.dispatchEvent" },
    };
  }
  const newState = checked !== undefined ? checked : !input.checked;
  input.checked = newState;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    success: true,
    message: `${newState ? "Checked" : "Unchecked"} ${input.name || "element"}`,
    evidence: { checked: newState },
    executionVerdict: {
      executed: true,
      world: "isolated",
      value: newState,
      domMutated: true,
      durationMs: performance.now() - start,
      path: "isolated.dispatchEvent",
    },
  };
}

export function selectOption(el: Element, value?: string, label?: string): ActResult {
  const start = performance.now();
  const select = el as HTMLSelectElement;
  if (!el || select.tagName !== "SELECT") {
    return {
      success: false,
      message: "Not a SELECT element",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.dispatchEvent" },
    };
  }
  let option: HTMLOptionElement | undefined;
  if (value !== undefined) {
    option = Array.from(select.options).find((o) => o.value === value);
  }
  if (!option && label !== undefined) {
    option = Array.from(select.options).find((o) => (o.textContent || "").trim() === label);
  }
  if (!option) {
    return {
      success: false,
      message: "Option not found",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.dispatchEvent" },
    };
  }
  option.selected = true;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    success: true,
    message: `Selected option '${(option.textContent || "").trim()}'`,
    executionVerdict: {
      executed: true,
      world: "isolated",
      value: option.value,
      domMutated: true,
      durationMs: performance.now() - start,
      path: "isolated.dispatchEvent",
    },
  };
}

export function pressKeys(el: Element, key?: string, keys?: string[]): ActResult {
  const start = performance.now();
  if (!el) {
    return {
      success: false,
      message: "No element",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.dispatchEvent" },
    };
  }
  (el as HTMLElement).focus();

  const keyList = keys || (key ? [key] : []);
  if (keyList.length === 0) {
    return {
      success: false,
      message: "No key specified",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.dispatchEvent" },
    };
  }

  const modMap: Record<string, number> = { Control: 0, Alt: 1, Shift: 2, Meta: 3 };
  const modFlags = [false, false, false, false];

  // Process all keys except the last one as potential modifiers
  for (let i = 0; i < keyList.length - 1; i++) {
    const idx = modMap[keyList[i]];
    if (idx !== undefined) modFlags[idx] = true;
  }

  const activeKey = keyList[keyList.length - 1];

  const init: KeyboardEventInit = {
    key: activeKey,
    ctrlKey: modFlags[0],
    altKey: modFlags[1],
    shiftKey: modFlags[2],
    metaKey: modFlags[3],
    bubbles: true,
  };

  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keypress", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  return {
    success: true,
    message: `Pressed keys: ${keyList.join("+")}`,
    evidence: { keys: keyList },
    executionVerdict: {
      executed: true,
      world: "isolated",
      domMutated: true,
      durationMs: performance.now() - start,
      path: "isolated.dispatchEvent",
    },
  };
}

export function scrollElement(el: Element | null, direction: string, amount?: number): ActResult {
  const start = performance.now();
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return {
      success: true,
      message: "Scrolled to element",
      evidence: { newPosition: window.scrollY },
      executionVerdict: {
        executed: true,
        world: "isolated",
        domMutated: true,
        durationMs: performance.now() - start,
        path: "isolated.scrollIntoView",
      },
    };
  }
  const px = amount || window.innerHeight;
  window.scrollBy({ top: direction === "up" ? -px : px, behavior: "smooth" });
  return {
    success: true,
    message: `Scrolled ${direction || "down"}`,
    evidence: { newPosition: window.scrollY },
    executionVerdict: {
      executed: true,
      world: "isolated",
      domMutated: true,
      durationMs: performance.now() - start,
      path: "isolated.scrollBy",
    },
  };
}

export function submitForm(el: Element): ActResult {
  const start = performance.now();
  if (!el) {
    return {
      success: false,
      message: "No element",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.form.submit" },
    };
  }
  const form = el.tagName === "FORM" ? (el as HTMLFormElement) : el.closest<HTMLFormElement>("form");
  if (!form) {
    return {
      success: false,
      message: "No form found",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.form.submit" },
    };
  }
  form.submit();
  return {
    success: true,
    message: "Form submitted",
    executionVerdict: {
      executed: true,
      world: "isolated",
      domMutated: true,
      durationMs: performance.now() - start,
      path: "isolated.form.submit",
    },
  };
}

export function typeText(el: Element, text: string, delay: number): Promise<ActResult> {
  if (!el || !text) {
    return Promise.resolve({
      success: false,
      message: "No element or text",
      executionVerdict: { executed: false, world: "isolated", durationMs: 0, path: "isolated.nativeSetter" },
    });
  }
  const start = performance.now();
  const chars = text.split("");
  let i = 0;
  const htmlEl = el as HTMLInputElement;

  // Get native value setter once
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype, "value"
  )?.set;

  return new Promise((resolve) => {
    function typeNext(): void {
      if (i >= chars.length) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        const valueMatched = htmlEl.value === text || htmlEl.value.endsWith(text);
        resolve({
          success: true,
          message: `Typed ${chars.length} characters`,
          evidence: { charCount: chars.length },
          executionVerdict: {
            executed: true,
            world: "isolated",
            value: htmlEl.value,
            valueMatched,
            domMutated: true,
            durationMs: performance.now() - start,
            path: "isolated.nativeSetter",
          },
        });
        return;
      }
      const ch = chars[i++];
      htmlEl.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));

      // Use native setter for React compatibility
      const currentValue = htmlEl.value;
      const newValue = currentValue + ch;
      if (nativeSetter) {
        nativeSetter.call(htmlEl, newValue);
      } else {
        htmlEl.value = newValue;
      }

      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      setTimeout(typeNext, delay || 30);
    }
    typeNext();
  });
}

export function uploadFile(el: Element, fileData: string, fileName?: string, fileType?: string): ActResult {
  const start = performance.now();
  const input = el as HTMLInputElement;
  if (!el || input.tagName !== "INPUT" || input.type !== "file") {
    return {
      success: false,
      message: "Not a file input element",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.fileInput" },
    };
  }
  try {
    const dt = new DataTransfer();
    const byteString = atob(fileData);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
    const blob = new Blob([ab], { type: fileType || "application/octet-stream" });
    dt.items.add(new File([blob], fileName || "file"));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      success: true,
      message: `File uploaded: ${fileName || "file"}`,
      executionVerdict: {
        executed: true,
        world: "isolated",
        value: fileName || "file",
        domMutated: true,
        durationMs: performance.now() - start,
        path: "isolated.fileInput",
      },
    };
  } catch (e) {
    return {
      success: false,
      message: `Upload failed: ${(e as Error).message || e}`,
      executionVerdict: {
        executed: false,
        world: "isolated",
        durationMs: performance.now() - start,
        path: "isolated.fileInput",
        error: { name: (e as Error).name || "Error", message: (e as Error).message || String(e) },
      },
    };
  }
}

export function dragElement(el: Element, x?: number, y?: number): ActResult {
  const start = performance.now();
  if (!el) {
    return {
      success: false,
      message: "No element",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.dispatchEvent" },
    };
  }
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = x !== undefined && x !== null ? x : cx;
  const dy = y !== undefined && y !== null ? y : cy;

  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: cx, clientY: cy }));
  el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: dx, clientY: dy }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: dx, clientY: dy }));
  return {
    success: true,
    message: `Dragged to (${Math.round(dx)}, ${Math.round(dy)})`,
    evidence: { fromX: Math.round(cx), fromY: Math.round(cy), toX: Math.round(dx), toY: Math.round(dy) },
    executionVerdict: {
      executed: true,
      world: "isolated",
      domMutated: true,
      durationMs: performance.now() - start,
      path: "isolated.dispatchEvent",
    },
  };
}

export function dblclickElement(el: Element): ActResult {
  const start = performance.now();
  if (!el) {
    return {
      success: false,
      message: "No element",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.dispatchEvent" },
    };
  }
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: cx, clientY: cy }));
  return {
    success: true,
    message: `Double-clicked ${el.tagName.toLowerCase()}`,
    evidence: { tag: el.tagName.toLowerCase() },
    executionVerdict: {
      executed: true,
      world: "isolated",
      domMutated: true,
      durationMs: performance.now() - start,
      path: "isolated.dispatchEvent",
    },
  };
}

export function hoverElement(el: Element): ActResult {
  const start = performance.now();
  if (!el) {
    return {
      success: false,
      message: "No element",
      executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.dispatchEvent" },
    };
  }
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: cx, clientY: cy }));
  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: cx, clientY: cy }));
  el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: cx, clientY: cy }));
  return {
    success: true,
    message: `Hovered ${el.tagName.toLowerCase()}`,
    evidence: { tag: el.tagName.toLowerCase(), x: Math.round(cx), y: Math.round(cy) },
    executionVerdict: {
      executed: true,
      world: "isolated",
      domMutated: false,
      durationMs: performance.now() - start,
      path: "isolated.dispatchEvent",
    },
  };
}

// ── Dialog ──

const BP_DIALOG_OVERRIDDEN = Symbol.for("bp.dialogOverridden");
const BP_LAST_DIALOG = Symbol.for("bp.lastDialog");
const BP_DIALOG_RESPONSE = Symbol.for("bp.dialogResponse");
const BP_ORIG_ALERT = Symbol.for("bp.origAlert");
const BP_ORIG_CONFIRM = Symbol.for("bp.origConfirm");
const BP_ORIG_PROMPT = Symbol.for("bp.origPrompt");

export function dialogOverride(): ActResult {
  const start = performance.now();
  if ((window as any)[BP_DIALOG_OVERRIDDEN]) {
    return {
      success: true,
      message: "Dialog override already active",
      executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.dialogOverride" },
    };
  }
  (window as any)[BP_DIALOG_OVERRIDDEN] = true;
  (window as any)[BP_LAST_DIALOG] = null;
  (window as any)[BP_DIALOG_RESPONSE] = null;

  (window as any)[BP_ORIG_ALERT] = window.alert;
  (window as any)[BP_ORIG_CONFIRM] = window.confirm;
  (window as any)[BP_ORIG_PROMPT] = window.prompt;

  window.alert = function (msg?: string) {
    (window as any)[BP_LAST_DIALOG] = { type: "alert", message: String(msg || "") };
    const orig = (window as any)[BP_ORIG_ALERT];
    return orig.call(window, msg);
  };

  window.confirm = function (msg?: string) {
    (window as any)[BP_LAST_DIALOG] = { type: "confirm", message: String(msg || "") };
    const resp = (window as any)[BP_DIALOG_RESPONSE];
    (window as any)[BP_DIALOG_RESPONSE] = null;
    if (resp && resp.confirm !== undefined) return resp.confirm;
    const orig = (window as any)[BP_ORIG_CONFIRM];
    return orig.call(window, msg);
  };

  window.prompt = function (msg?: string, defaultVal?: string) {
    (window as any)[BP_LAST_DIALOG] = { type: "prompt", message: String(msg || ""), defaultVal: defaultVal || "" };
    const resp = (window as any)[BP_DIALOG_RESPONSE];
    (window as any)[BP_DIALOG_RESPONSE] = null;
    if (resp && resp.prompt !== undefined) return resp.prompt;
    const orig = (window as any)[BP_ORIG_PROMPT];
    return orig.call(window, msg, defaultVal);
  };

  return {
    success: true,
    message: "Dialog override active",
    executionVerdict: { executed: true, world: "isolated", domMutated: true, durationMs: performance.now() - start, path: "isolated.dialogOverride" },
  };
}

export function dialogRestore(): ActResult {
  const start = performance.now();
  const overridden = (window as any)[BP_DIALOG_OVERRIDDEN];
  if (!overridden) {
    return {
      success: true,
      message: "Dialog override not active",
      executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.dialogOverride" },
    };
  }

  const origAlert = (window as any)[BP_ORIG_ALERT];
  const origConfirm = (window as any)[BP_ORIG_CONFIRM];
  const origPrompt = (window as any)[BP_ORIG_PROMPT];

  if (origAlert) window.alert = origAlert;
  if (origConfirm) window.confirm = origConfirm;
  if (origPrompt) window.prompt = origPrompt;

  delete (window as any)[BP_DIALOG_OVERRIDDEN];
  delete (window as any)[BP_ORIG_ALERT];
  delete (window as any)[BP_ORIG_CONFIRM];
  delete (window as any)[BP_ORIG_PROMPT];
  delete (window as any)[BP_LAST_DIALOG];
  delete (window as any)[BP_DIALOG_RESPONSE];

  return {
    success: true,
    message: "Dialog override removed",
    executionVerdict: { executed: true, world: "isolated", domMutated: true, durationMs: performance.now() - start, path: "isolated.dialogOverride" },
  };
}

export function dialogRespond(response?: Record<string, unknown>): ActResult {
  const start = performance.now();
  (window as any)[BP_DIALOG_RESPONSE] = response || {};
  const d = (window as any)[BP_LAST_DIALOG];
  (window as any)[BP_LAST_DIALOG] = null;
  return {
    success: true,
    message: "Dialog response set",
    evidence: { lastDialog: d },
    executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.dialogOverride" },
  };
}

// ── Wait Conditions ──

export function waitForElement(
  selector: string,
  condition: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ActResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const wallStart = Date.now();
    const check = (): void => {
      const el = document.querySelector(selector) as HTMLElement | null;
      const elapsed = Date.now() - wallStart;

      if (condition === "exists") {
        if (el) {
          clearInterval(timer);
          resolve({ success: true, message: `Element appeared after ${elapsed}ms`, evidence: { condition: "exists", appeared: true, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: "css-flat" } });
          return;
        }
      } else if (condition === "visible") {
        if (el && el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden") {
          clearInterval(timer);
          resolve({ success: true, message: `Element visible after ${elapsed}ms`, evidence: { condition: "visible", appeared: true, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: "css-flat" } });
          return;
        }
      } else if (condition === "hidden") {
        if (!el || el.offsetParent === null || getComputedStyle(el).visibility === "hidden") {
          clearInterval(timer);
          resolve({ success: true, message: `Element hidden after ${elapsed}ms`, evidence: { condition: "hidden", appeared: false, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: "css-flat" } });
          return;
        }
      } else if (condition === "enabled") {
        if (el && !(el as HTMLInputElement).disabled && el.getAttribute("aria-disabled") !== "true") {
          clearInterval(timer);
          resolve({ success: true, message: `Element enabled after ${elapsed}ms`, evidence: { condition: "enabled", appeared: true, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: "css-flat" } });
          return;
        }
      } else if (condition === "disabled") {
        if (el && ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true")) {
          clearInterval(timer);
          resolve({ success: true, message: `Element disabled after ${elapsed}ms`, evidence: { condition: "disabled", appeared: true, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: "css-flat" } });
          return;
        }
      } else if (condition === "stable") {
        if (el) {
          clearInterval(timer); // Stop outer polling
          let prev: DOMRect | null = null;
          const st = setInterval(() => {
            const c = el.getBoundingClientRect();
            if (prev && c.top === prev.top && c.left === prev.left && c.width === prev.width && c.height === prev.height) {
              clearInterval(st);
              resolve({ success: true, message: `Element stable after ${Date.now() - wallStart}ms`, evidence: { condition: "stable", elapsed_ms: Date.now() - wallStart }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: "css-flat" } });
            } else {
              prev = c;
            }
          }, 50);
          return;
        }
      }

      if (elapsed >= timeoutMs) {
        clearInterval(timer);
        resolve({ success: false, message: `Timeout waiting for '${condition}' after ${elapsed}ms`, evidence: { condition, appeared: false, elapsed_ms: elapsed }, errorCode: "TIMEOUT", executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: "css-flat", error: { name: "TimeoutError", message: `Condition '${condition}' not met within ${timeoutMs}ms` } } });
      }
    };
    const timer = setInterval(check, pollIntervalMs);
    check();
  });
}

/**
 * Wait for a condition on a target element (resolves target fresh each poll cycle).
 * Used when the service worker can't pre-resolve to a simple CSS selector.
 */
export function waitForTarget(
  target: Target,
  condition: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ActResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const wallStart = Date.now();
    let lastPathTaken: ResolutionResult["pathTaken"];
    const check = (): void => {
      const resolution = resolveTarget(target);
      lastPathTaken = resolution.pathTaken;
      const el = resolution.found ? resolution.element as HTMLElement : null;
      const elapsed = Date.now() - wallStart;

      if (condition === "exists") {
        if (el) {
          clearInterval(timer);
          resolve({ success: true, message: `Element appeared after ${elapsed}ms`, evidence: { condition: "exists", appeared: true, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: lastPathTaken } });
          return;
        }
      } else if (condition === "visible") {
        if (el && el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden") {
          clearInterval(timer);
          resolve({ success: true, message: `Element visible after ${elapsed}ms`, evidence: { condition: "visible", appeared: true, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: lastPathTaken } });
          return;
        }
      } else if (condition === "hidden") {
        if (!el || el.offsetParent === null || getComputedStyle(el).visibility === "hidden") {
          clearInterval(timer);
          resolve({ success: true, message: `Element hidden after ${elapsed}ms`, evidence: { condition: "hidden", appeared: false, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: lastPathTaken } });
          return;
        }
      } else if (condition === "enabled") {
        if (el && !(el as HTMLInputElement).disabled && el.getAttribute("aria-disabled") !== "true") {
          clearInterval(timer);
          resolve({ success: true, message: `Element enabled after ${elapsed}ms`, evidence: { condition: "enabled", appeared: true, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: lastPathTaken } });
          return;
        }
      } else if (condition === "disabled") {
        if (el && ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true")) {
          clearInterval(timer);
          resolve({ success: true, message: `Element disabled after ${elapsed}ms`, evidence: { condition: "disabled", appeared: true, elapsed_ms: elapsed }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: lastPathTaken } });
          return;
        }
      } else if (condition === "stable") {
        if (el) {
          clearInterval(timer); // Stop outer polling
          let prev: DOMRect | null = null;
          const st = setInterval(() => {
            const c = el.getBoundingClientRect();
            if (prev && c.top === prev.top && c.left === prev.left && c.width === prev.width && c.height === prev.height) {
              clearInterval(st);
              clearInterval(timer);
              resolve({ success: true, message: `Element stable after ${Date.now() - wallStart}ms`, evidence: { condition: "stable", elapsed_ms: Date.now() - wallStart }, executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: lastPathTaken } });
            } else {
              prev = c;
            }
          }, 50);
          return;
        }
      }

      if (elapsed >= timeoutMs) {
        clearInterval(timer);
        resolve({ success: false, message: `Timeout waiting for '${condition}' after ${elapsed}ms`, evidence: { condition, appeared: false, elapsed_ms: elapsed }, errorCode: "TIMEOUT", executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.waitFor", pathTaken: lastPathTaken, error: { name: "TimeoutError", message: `Condition '${condition}' not met within ${timeoutMs}ms` } } });
      }
    };
    const timer = setInterval(check, pollIntervalMs);
    check();
  });
}

export function waitForNetworkIdle(idleThreshold: number, timeoutMs: number): Promise<ActResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    let lastRequestTime = Date.now();
    let outerTimeout: ReturnType<typeof setTimeout>;
    let idleTimer: ReturnType<typeof setTimeout>;

    const origFetch = window.fetch;
    if (origFetch) {
      (window as any).fetch = function (...args: unknown[]) {
        lastRequestTime = Date.now();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(onIdle, idleThreshold);
        return origFetch.apply(window, args as Parameters<typeof fetch>);
      };
    }

    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (...args: unknown[]) {
      lastRequestTime = Date.now();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, idleThreshold);
      return origXHROpen.apply(this, args as Parameters<typeof XMLHttpRequest["open"]>);
    };
    XMLHttpRequest.prototype.send = function (...args: unknown[]) {
      lastRequestTime = Date.now();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, idleThreshold);
      return origXHRSend.apply(this, args as Parameters<typeof XMLHttpRequest["send"]>);
    };

    function onIdle(): void {
      clearTimeout(outerTimeout);
      resolve({
        success: true,
        message: `Network idle for ${idleThreshold}ms`,
        evidence: { condition: "network_idle", elapsed_ms: Date.now() - wallStart, idle_for_ms: idleThreshold },
        executionVerdict: { executed: true, world: "isolated", durationMs: performance.now() - start, path: "isolated.networkIdle" },
      });
    }

    const wallStart = Date.now();
    outerTimeout = setTimeout(() => {
      resolve({
        success: false,
        message: `Network idle timeout after ${Date.now() - wallStart}ms`,
        evidence: { condition: "network_idle", timed_out: true, elapsed_ms: Date.now() - wallStart },
        executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.networkIdle", error: { name: "TimeoutError", message: `Network not idle within ${timeoutMs}ms` } },
      });
    }, timeoutMs);

    // Check if already idle
    if (Date.now() - lastRequestTime >= idleThreshold) {
      onIdle();
    }
  });
}

export function waitForFunction(
  expression: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ActResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const wallStart = Date.now();
    let lastError: string | undefined;
    const timer = setInterval(() => {
      try {
        const result = new Function(expression)();
        if (result) {
          clearInterval(timer);
          resolve({
            success: true,
            message: `Function returned truthy after ${Date.now() - wallStart}ms`,
            evidence: { condition: "function", result, elapsed_ms: Date.now() - wallStart },
            executionVerdict: { executed: true, world: "isolated", value: result, durationMs: performance.now() - start, path: "isolated.newFunction" },
          });
        }
      } catch (e) {
        // Expression failed — continue polling, but note the last error
        lastError = (e as Error).message;
      }
      if (Date.now() - wallStart >= timeoutMs) {
        clearInterval(timer);
        const evidence: Record<string, unknown> = { condition: "function", timed_out: true, elapsed_ms: Date.now() - wallStart };
        if (lastError) evidence.lastError = lastError;
        resolve({
          success: false,
          message: `Function condition timeout after ${Date.now() - wallStart}ms`,
          evidence,
          executionVerdict: { executed: false, world: "isolated", durationMs: performance.now() - start, path: "isolated.newFunction", error: { name: "TimeoutError", message: `Function did not return truthy within ${timeoutMs}ms`, ...(lastError ? { message: `${lastError} (last error)` } : {}) } },
        });
      }
    }, pollIntervalMs);
  });
}

// ── Batch Fill ──

export function fillFormFields(
  fields: Array<{ selector: string; value: string }>,
): ActResult & { filled: number; total: number; errors?: string[] } {
  const start = performance.now();
  let filled = 0;
  const errors: string[] = [];
  for (const { selector, value } of fields) {
    try {
      const el = document.querySelector(selector) as HTMLInputElement | null;
      if (!el) {
        errors.push(`Selector "${selector}" not found`);
        continue;
      }
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      filled++;
    } catch (e) {
      errors.push(`Error filling "${selector}": ${(e as Error).message}`);
    }
  }
  return {
    success: errors.length === 0,
    message: `Filled ${filled}/${fields.length} fields`,
    filled,
    total: fields.length,
    errors: errors.length > 0 ? errors : undefined,
    executionVerdict: {
      executed: true,
      world: "isolated",
      value: filled,
      domMutated: filled > 0,
      durationMs: performance.now() - start,
      path: "isolated.nativeSetter",
    },
  };
}

// ── Read Actions ──

export function readContent(target: Target | null): string {
  if (target?.css) {
    const el = document.querySelector(target.css);
    return el?.textContent || `No element matching "${target.css}"`;
  }
  return document.body?.innerText || document.documentElement.innerText;
}

export function readTexts(selector: string, limit: number): string[] {
  const els = document.querySelectorAll(selector);
  const results: string[] = [];
  const max = Math.min(els.length, limit);
  for (let i = 0; i < max; i++) {
    const text = els[i].textContent?.trim();
    if (text) results.push(text);
  }
  return results;
}

export function readHtml(selector: string, limit: number): string[] {
  const els = document.querySelectorAll(selector);
  const max = Math.min(els.length, limit);
  const results: string[] = [];
  for (let i = 0; i < max; i++) {
    results.push(els[i].outerHTML);
  }
  return results;
}

export function readAttr(selector: string, name: string): string | null {
  const el = document.querySelector(selector);
  return el?.getAttribute(name) ?? null;
}

export function readMeta(): Record<string, unknown> {
  const getMetaByName = (name: string): string | undefined => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el?.getAttribute("content") ?? undefined;
  };
  const getMetaByProperty = (property: string): string | undefined => {
    const el = document.querySelector(`meta[property="${property}"]`);
    return el?.getAttribute("content") ?? undefined;
  };
  return {
    title: document.title,
    description: getMetaByName("description"),
    ogTitle: getMetaByProperty("og:title"),
    ogDescription: getMetaByProperty("og:description"),
    ogImage: getMetaByProperty("og:image"),
    canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined,
    language: document.documentElement.lang || undefined,
    author: getMetaByName("author"),
  };
}

export function readForms(limit: number): Record<string, unknown>[] {
  const forms = document.querySelectorAll<HTMLFormElement>("form");
  const results: Record<string, unknown>[] = [];
  const max = Math.min(forms.length, limit);
  for (let i = 0; i < max; i++) {
    const form = forms[i];
    const fields = Array.from(form.querySelectorAll("input, select, textarea, button")).map((el: Element) => {
      const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;
      const field: Record<string, unknown> = {
        name: input.name || input.id || "",
        type: (input as HTMLInputElement).type || el.tagName.toLowerCase(),
        required: input.required || false,
        disabled: input.disabled || false,
        placeholder: (input as HTMLInputElement).placeholder || undefined,
      };
      if (el.tagName === "SELECT") {
        const select = el as HTMLSelectElement;
        field.options = Array.from(select.options).map((o: HTMLOptionElement) => ({
          value: o.value,
          text: o.textContent?.trim(),
          selected: o.selected,
        }));
      }
      return field;
    });
    results.push({
      id: form.id || undefined,
      name: form.name || undefined,
      action: form.action || undefined,
      method: (form.method || "get").toUpperCase(),
      fields,
    });
  }
  return results;
}

export function countElements(selector: string): number {
  return document.querySelectorAll(selector).length;
}

export function selectText(): string {
  return window.getSelection()?.toString() ?? "";
}

export function readSummary(): Record<string, unknown> {
  const getAll = (sel: string) => document.querySelectorAll(sel).length;

  const buttons = getAll("button,a,input[type!=hidden],select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[tabindex]:not([tabindex='-1'])");
  const forms = getAll("form");
  const fillableFields = getAll("input:not([type=hidden]),select,textarea");
  const links = getAll("a");
  const modals = getAll("[role=dialog],[role=alertdialog],.modal,.overlay,[aria-modal='true']");
  const spinners = getAll("[role=progressbar],[class*=spinner],[class*=loading],[aria-busy='true']");

  const bodyText = (document.body?.innerText || "").trim().slice(0, 200);
  const hasContent = bodyText.length > 0;
  const contentType = bodyText.length > 500 ? "full" : bodyText.length > 50 ? "partial" : "minimal";

  return {
    url: location.href,
    title: document.title,
    anchorCount: buttons,
    formCount: forms,
    interactiveElementCount: buttons,
    fillableFieldCount: fillableFields,
    linkCount: links,
    hasModal: modals > 0,
    hasLoadingSpinner: spinners > 0,
    hasContent,
    contentType,
    contentPreview: bodyText.slice(0, 200) || undefined,
  };
}

export function generateSelector(css: string): Record<string, unknown> {
  const el = document.querySelector(css) as HTMLElement | null;
  if (!el) return { success: false, message: "No element found for selector: " + css };

  const selectors: Array<{ selector: string; method: string; specificity: number }> = [];

  // 1. By ID (highest specificity)
  if (el.id) {
    selectors.push({ selector: "#" + CSS.escape(el.id), method: "id", specificity: 100 });
  }

  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).filter((c: string) => c.length > 0);

  // 2. By tag + class(es)
  if (classes.length > 0) {
    selectors.push({ selector: tag + "." + classes.map((c: string) => CSS.escape(c)).join("."), method: "tag+class", specificity: 10 + classes.length });
  }

  // 3. By nth-child
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children);
    const idx = siblings.indexOf(el) + 1;
    selectors.push({ selector: tag + ":nth-child(" + idx + ")", method: "nth-child", specificity: 10 });
  }

  // 4. By name attribute
  const name = el.getAttribute("name");
  if (name) {
    selectors.push({ selector: tag + "[name='" + name.replace(/'/g, "\\'") + "']", method: "name", specificity: 20 });
  }

  // 5. By aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) {
    selectors.push({ selector: tag + "[aria-label='" + ariaLabel.replace(/'/g, "\\'") + "']", method: "aria-label", specificity: 30 });
  }

  // 6. By placeholder
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) {
    selectors.push({ selector: tag + "[placeholder='" + placeholder.replace(/'/g, "\\'") + "']", method: "placeholder", specificity: 25 });
  }

  // 7. By tag path (short chains only)
  const path: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    path.unshift(cur.tagName.toLowerCase());
    cur = cur.parentElement;
  }
  if (path.length > 0 && path.length <= 5) {
    selectors.push({ selector: path.join(" > "), method: "path", specificity: 1 });
  }

  // Sort by specificity descending, deduplicate
  selectors.sort((a, b) => b.specificity - a.specificity);
  const seen = new Set<string>();
  const unique = selectors.filter((s) => {
    if (seen.has(s.selector)) return false;
    seen.add(s.selector);
    return true;
  });

  return {
    success: true,
    selectors: unique,
    tag,
    id: el.id || undefined,
    textContent: (el.textContent || "").trim().slice(0, 100) || undefined,
    elementSummary: tag + (el.id ? "#" + el.id : "") + (classes.length ? "." + classes.slice(0, 2).join(".") : ""),
  };
}
