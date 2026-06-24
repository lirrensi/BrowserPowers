/**
 * FILE: core/src/adapters/help-text.ts
 * PURPOSE: Single source of truth for BrowserPowers help text. Auto-generates
 *          comprehensive help from the commander program + MCP tool list + v2
 *          action enums — no string duplication with command definitions.
 *          Walks the registered commander program and the MCP tool registry
 *          so adding a new command / tool / page action automatically flows
 *          into the help output. The MCP `help` tool and the CLI's `help`
 *          subcommand both consume this module.
 *
 *          Exports:
 *            - buildHelpIndex()         — the full system reference (default
 *                                          output of `help` with no args)
 *            - buildCommandHelp(name)   — deep-dive on a single commander
 *                                          command (e.g. `help page.act`)
 *            - buildTopicHelp(topic)    — section deep-dive (e.g.
 *                                          `help page-read`)
 *            - buildToolHelp(name)      — MCP tool reference (matches the
 *                                          shape of `{ help: true }`)
 *            - getCommandNames()        — list of commander command names
 *            - getTopics()              — list of valid topic names
 *
 * OWNS: Help text registry, topic catalog, command catalog.
 * EXPORTS: buildHelpIndex, buildCommandHelp, buildTopicHelp, buildToolHelp,
 *          getCommandNames, getTopics.
 * DOCS: .agents/reports/plan_visual-help-csp-tighten_2026-06-23.md §2.4
 */

import type { Command } from "commander";

// ── Page action enums (mirrored from extension/src/v2) ────────────────

export const PAGE_READ_ACTIONS = [
  "inspect", "content", "text", "html", "attr", "meta", "forms", "count",
  "select", "summary", "frames", "generate_selector", "console",
  "runtime_status", "readable", "full_html",
] as const;

export const PAGE_ACT_ACTIONS = [
  "click", "fill", "check", "select_option", "press", "scroll", "submit",
  "wait_for", "type", "smart_click", "fill_form", "upload", "drag",
  "dblclick", "hover", "dialog_override", "dialog_respond",
  "click_at", "dblclick_at", "hover_at",
] as const;

// ── MCP tool catalog ───────────────────────────────────────────────────

export interface McpToolEntry {
  name: string;
  group: string;
  description: string;
  /** Detailed parameters (for the per-tool help view). */
  params?: string;
  /** Per-action sub-commands, if this tool is a dispatcher. */
  actions?: readonly string[];
}

const MCP_TOOL_CATALOG: McpToolEntry[] = [
  {
    name: "browsers",
    group: "browser-management",
    description: "List connected browsers with capabilities, status, and active tab info.",
    params: `- summary (boolean, optional): Condensed summary mode (name, active tab URL, capabilities, age).`,
  },
  {
    name: "screenshot",
    group: "browser-management",
    description: "Capture a screenshot of the active tab in a browser. Supports `overlay` for annotated visual layer.",
    params: `- browser_id or browser_name (one required)
- overlay (string, optional): "none" | "labels" | "coords" | "both" | "anchors_only"
- overlay_limit (number, optional): Max anchors to draw (default 50)
- overlay_color_by_type (boolean, optional): Color boxes by tag (default true)`,
  },
  {
    name: "tabs",
    group: "browser-management",
    description: "List, navigate, go back/forward, close browser tabs. Action discriminator.",
    actions: ["list", "navigate", "goBack", "goForward", "close"],
  },
  {
    name: "execute_all",
    group: "browser-management",
    description: "Execute a tool on ALL connected browsers at once.",
    params: `- tool (string, required): Tool name to run
- params (object, optional): Tool parameters`,
  },
  {
    name: "execute_batch",
    group: "browser-management",
    description: "Execute multiple tools across browsers in parallel.",
    params: `- commands (array, required): Array of { browser_id?, browser_name?, tool, params? }`,
  },
  {
    name: "page_read",
    group: "page-interaction",
    description: "Read page content without mutating it. Action discriminator.",
    actions: PAGE_READ_ACTIONS,
  },
  {
    name: "page_act",
    group: "page-interaction",
    description: "Interact with or mutate the page. Action discriminator. Most actions go through CDP `Input.*` (CSP-immune).",
    actions: PAGE_ACT_ACTIONS,
  },
  {
    name: "page_js",
    group: "page-interaction",
    description: "Execute JavaScript on the page via CDP `Runtime.evaluate` (gated escape hatch — CSP-immune).",
    params: `- code (string, required): JavaScript to evaluate
- timeout_ms (number, optional): Max wait (default 120000)`,
  },
  {
    name: "cookies",
    group: "browser-state",
    description: "Manage browser cookies (get, set, remove, list).",
    actions: ["get", "set", "remove", "list"],
  },
  {
    name: "windows",
    group: "browser-state",
    description: "Manage browser windows (list, create, focus, close).",
    actions: ["list", "create", "focus", "close"],
  },
  {
    name: "help",
    group: "system",
    description: "Get the full system reference (this tool's own output, in a different format).",
  },
];

// ── Topic catalog ──────────────────────────────────────────────────────

export const HELP_TOPICS = [
  "all",
  "navigation",
  "anchors",
  "gates",
  "page-read",
  "page-act",
  "page-js",
  "visual",
  "permissions",
] as const;
export type HelpTopic = typeof HELP_TOPICS[number];

/**
 * Get the list of valid help topics. Exported for the CLI `help topics` subcommand.
 */
export function getTopics(): string[] {
  return [...HELP_TOPICS];
}

// ── Public: build the full help index (the default `help` output) ──────

export function buildHelpIndex(): string {
  return [
    header(),
    "",
    "## Quick Reference — Top-Level Commands",
    quickReference(),
    "",
    "## Permission Groups",
    permissionTable(),
    "",
    "## How to Get Help",
    howToGetHelp(),
    "",
    "## Navigation Workflow",
    navigationWorkflow(),
    "",
    "## Element Targeting",
    elementTargeting(),
    "",
    "## Visual Layer (overlays & click_at)",
    visualLayer(),
    "",
    "## Readable & Full-HTML",
    readableFullHtml(),
    "",
    "## Gate / Approval Model",
    gateModel(),
    "",
    "## Tool Reference",
    toolReference(),
    "",
    "## Per-Action Reference — page.read",
    actionReference("page.read", PAGE_READ_ACTIONS),
    "",
    "## Per-Action Reference — page.act",
    actionReference("page.act", PAGE_ACT_ACTIONS),
    "",
    "## Per-Tool Help (MCP)",
    perToolHelp(),
    "",
    "## Connection Lifecycle",
    connectionLifecycle(),
    "",
    footer(),
  ].join("\n");
}

// ── Public: deep-dive on a single commander command ────────────────────

/**
 * Build the help text for a single commander command. Walks the
 * program.commands tree to find a command by name (top-level or dotted
 * sub-command path like "page.read"). Returns a friendly deep-dive.
 */
export function buildCommandHelp(program: Command, name: string): string {
  // Try top-level first, then dotted sub-command.
  const path = name.split(".");
  let current: Command | undefined = program;
  const trail: Command[] = [];
  for (const segment of path) {
    if (!current) break;
    const sub: Command | undefined = current.commands.find((c: Command) => c.name() === segment);
    if (!sub) break;
    trail.push(sub);
    current = sub;
  }
  if (trail.length === 0) {
    return `Unknown command "${name}".\n\nRun \`browserpowers help\` for the full reference, or \`browserpowers help topics\` for the topic list.`;
  }
  const cmd = trail[trail.length - 1];
  const lines: string[] = [];
  lines.push(`# browserpowers ${trail.map((c) => c.name()).join(" ")}`);
  lines.push("");
  lines.push(cmd.description() || "(no description)");
  lines.push("");
  lines.push("## Synopsis");
  lines.push("```");
  lines.push(`browserpowers ${trail.map((c) => c.name()).join(" ")}${cmd.usage ? " " + cmd.usage() : ""}`);
  lines.push("```");
  lines.push("");

  // Options
  const opts = cmd.options;
  if (opts.length > 0) {
    lines.push("## Options");
    for (const o of opts) {
      const flag = o.flags.replace(/^--?/, "").split(/[ ,|]/)[0];
      const negatable = o.flags.includes("[boolean]");
      const desc = o.description ?? "";
      lines.push(`- \`--${flag}\`${negatable ? " / \`--no-" + flag + "\`" : ""} — ${desc}`);
    }
    lines.push("");
  }

  // Args
  const args = (cmd as unknown as { _args?: Array<{ name: string; required: boolean; description: string }> })._args ?? [];
  if (args.length > 0) {
    lines.push("## Arguments");
    for (const a of args) {
      // Commander stores the name and description on the Argument instance;
      // their getters are functions. We just call them.
      let name: string;
      let description: string;
      try {
        name = typeof a.name === "function" ? (a.name as () => string)() : String(a.name);
      } catch {
        name = String(a.name);
      }
      try {
        description = typeof a.description === "function" ? (a.description as () => string)() : String(a.description ?? "");
      } catch {
        description = String(a.description ?? "");
      }
      lines.push(`- \`<${name}>\`${a.required ? " (required)" : " (optional)"} — ${description}`);
    }
    lines.push("");
  }

  // Sub-commands (for dispatcher commands like `page`)
  if (cmd.commands.length > 0) {
    lines.push("## Sub-commands");
    for (const sub of cmd.commands) {
      lines.push(`- \`${sub.name()}\` — ${sub.description()}`);
    }
    lines.push("");
  }

  // Page-action enrichment for `page read` / `page act`
  if (trail[trail.length - 2]?.name() === "page") {
    const actionCmd = cmd.name();
    if (actionCmd === "read") {
      lines.push("## Available actions for `page read`");
      for (const a of PAGE_READ_ACTIONS) lines.push(`- \`${a}\``);
      lines.push("");
    } else if (actionCmd === "act") {
      lines.push("## Available actions for `page act`");
      for (const a of PAGE_ACT_ACTIONS) lines.push(`- \`${a}\``);
      lines.push("");
    }
  }

  // Per-action deep dive: `help page.act click` / `help page.read inspect`
  if (path.length === 3 && (path[1] === "read" || path[1] === "act")) {
    const action = path[2];
    lines.push(`## Action: ${action}`);
    lines.push(actionDeepDive(path[1] as "read" | "act", action));
    lines.push("");
  }

  return lines.join("\n");
}

// ── Public: deep-dive on a topic ───────────────────────────────────────

export function buildTopicHelp(topic: string): string {
  if (topic === "topics") {
    return [
      "# Available help topics",
      "",
      ...HELP_TOPICS.map((t) => `- \`${t}\` — ${describeTopic(t)}`),
      "",
      "Usage: `browserpowers help <topic>`",
    ].join("\n");
  }
  if (!(HELP_TOPICS as readonly string[]).includes(topic)) {
    return `No topic found for "${topic}".\n\nAvailable topics: ${HELP_TOPICS.join(", ")}.\n\nRun \`browserpowers help topics\` for descriptions.`;
  }
  return renderTopic(topic as HelpTopic);
}

// ── Public: get the list of commander command names ────────────────────

export function getCommandNames(program: Command): string[] {
  const out: string[] = [];
  const visit = (cmd: Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      const name = prefix ? `${prefix}.${sub.name()}` : sub.name();
      out.push(name);
      visit(sub, name);
    }
  };
  visit(program, "");
  return out;
}

// ── Public: per-tool help (matches MCP `help: true` shape) ────────────

export function buildToolHelp(toolName: string): string {
  const tool = MCP_TOOL_CATALOG.find((t) => t.name === toolName);
  if (!tool) {
    return `No help available for \`${toolName}\`. Use \`help\` to list all tools.`;
  }
  const lines: string[] = [];
  lines.push(`## ${tool.name}`);
  lines.push("");
  lines.push(tool.description);
  lines.push("");
  if (tool.actions && tool.actions.length > 0) {
    lines.push("### Actions");
    for (const a of tool.actions) lines.push(`- \`${a}\``);
    lines.push("");
  }
  if (tool.params) {
    lines.push("### Parameters");
    lines.push(tool.params);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Internal: header / footer ──────────────────────────────────────────

function header(): string {
  return [
    "# BrowserPowers — Help",
    "",
    "BrowserPowers is a browser automation system that exposes real (non-headless) browser",
    "control to AI agents through MCP, REST, CLI, and WebSocket. The system uses the Chrome",
    "DevTools Protocol (CDP) via the browser extension for input injection (CSP-immune, page-",
    "variable access), plus a content-script fallback for the rare CDP-denied case.",
    "",
    "Run `help <topic>` for a section deep-dive, or `help <command>` for a single command.",
  ].join("\n");
}

function footer(): string {
  return [
    "---",
    "",
    "Generated by the BrowserPowers help system. The help text auto-reflects the registered",
    "commander commands, MCP tools, and v2 page action enums — no string duplication.",
  ].join("\n");
}

// ── Internal: section renderers ────────────────────────────────────────

function quickReference(): string {
  const tools = MCP_TOOL_CATALOG.map((t) => `- \`${t.name}\` — ${t.description.split(".")[0]}`);
  return [
    "### Browser Management",
    "- `list` — List connected browsers",
    "- `navigate <browserId> <url>` — Navigate a browser to a URL",
    "- `screenshot <browserId> [filepath]` — Take a screenshot (supports `overlay=`)",
    "- `tabs <browserId>` — List browser tabs",
    "- `status` — Daemon health + connected browsers",
    "- `disconnect <browserId>` — Disconnect a browser",
    "- `capabilities <browserId>` — List a browser's capabilities",
    "",
    "### Page Operations (unified CLI)",
    "- `page read <browserId> <action> [params...]` — Read page content",
    "- `page act <browserId> <action> [params...]` — Interact with / mutate the page",
    "",
    "### System",
    "- `exec <browserId> <tool> [params...]` — Run any tool with JSON params",
    "- `exec-all <tool> [params...]` — Run a tool across all browsers",
    "- `init` — First-time setup wizard",
    "- `serve` — Start the core server",
    "- `mcp-config` — Print MCP client config snippet",
    "- `approvals` — Manage pending approval requests",
    "- `config show` / `config path` — View / locate config",
    "- `stop` — Stop the daemon",
    "",
    "### MCP Tools (consumed via MCP clients)",
    ...tools,
  ].join("\n");
}

function permissionTable(): string {
  return [
    "| Group | Default | Tools |",
    "|---|---|---|",
    "| `tabs` | `allow` | list, navigate, goBack, goForward, close, update |",
    "| `page.read` | `allow` | inspect, content, text, html, attr, meta, forms, count, select, summary, readable, full_html |",
    "| `page.act` | `ask` | click, fill, check, select_option, press, scroll, submit, type, click_at, dblclick_at, hover_at, … |",
    "| `page.execute` | `deny` | page.js (gated escape hatch) |",
    "| `screenshots` | `allow` | capture |",
    "| `history` | `deny` | search, delete |",
    "| `bookmarks` | `deny` | list, create, remove |",
    "| `downloads` | `deny` | search, open |",
    "| `network` | `deny` | (reserved) |",
    "| `storage` | `deny` | get, set |",
    "| `cookies` | `deny` (group-level gate) | get, set, remove, list |",
    "| `windows` | `deny` (group-level gate) | list, create, focus, close |",
    "",
    "All groups support three levels: `allow`, `ask`, `deny`. Site-level overrides",
    "let you allow/deny/ask per URL pattern — see the options page in the extension.",
  ].join("\n");
}

function howToGetHelp(): string {
  return [
    "Three call patterns, in increasing detail:",
    "",
    "1. `browserpowers --help` — one-page cheat sheet (built-in commander).",
    "2. `browserpowers help` — this comprehensive reference.",
    "3. `browserpowers help <command>` — deep-dive on a single command (e.g. `help page.act`).",
    "4. `browserpowers help <topic>` — section deep-dive (e.g. `help page-read`, `help visual`).",
    "5. `browserpowers help topics` — list of available topics with one-line descriptions.",
    "",
    "Via MCP, call the `help` tool with `topic` (default `all`).",
  ].join("\n");
}

function navigationWorkflow(): string {
  return [
    "1. `browsers` (or `list`) — Find a connected browser. Prefer the browser's NAME; fall back to ID.",
    "2. `tabs({ action: \"navigate\", url })` — Navigate to a URL. Set `snapshot: true` to get the page tree.",
    "3. `page_read({ action: \"inspect\" })` — See all interactable elements as a tree with anchor IDs.",
    "4. `page_act({ action: \"click\", anchor: \"a7\" })` — Interact using the anchor fast-path.",
    "",
    "For pages where the inspector misses something, take a screenshot with overlay and use `click_at`:",
    "- `screenshots.capture({ overlay: \"both\" })` — PNG with anchor IDs AND (x, y) coords painted on.",
    "- `page_act({ action: \"click_at\", x: 420, y: 160 })` — click at literal viewport coords.",
  ].join("\n");
}

function elementTargeting(): string {
  return [
    "Three strategies, in order of preference:",
    "",
    "1. **Text targeting (most stable)** — `target: { text: \"Submit\" }` survives page reloads.",
    "2. **Anchor fast-path (fastest)** — `anchor: \"a7\"` from inspect output, skips CSS resolution.",
    "3. **CSS / Role / TestID targeting** — `target: { css: \"#id\" }`, `target: { role: \"button\" }`, etc.",
    "",
    "Shadow DOM: pass `shadowPath: [\"host-tag\", ...]` alongside `target` to descend into shadow roots.",
    "The CDP path can hit CLOSED shadow roots (the isolated-world resolver can't).",
  ].join("\n");
}

function visualLayer(): string {
  return [
    "The `screenshots.capture` overlay mode paints annotated boxes on the captured PNG so the agent",
    "can see where the elements are:",
    "",
    "- `overlay: \"none\"` (default for backward compat) — raw PNG, no overlay.",
    "- `overlay: \"labels\"` — boxes + anchor IDs (a1, a2, …) + tag#id (e.g. `a1 button#Submit`).",
    "- `overlay: \"coords\"` — boxes + (x, y) coords of the element center.",
    "- `overlay: \"both\"` (default when overlay is enabled) — labels AND coords.",
    "- `overlay: \"anchors_only\"` — boxes only, no text inside (cleaner for visually-noisy pages).",
    "",
    "Box colors: button=blue, input/textarea=green, link=orange, select=purple, default=gray.",
    "Boxes for elements outside the viewport are skipped. `overlay_limit` (default 50) caps the",
    "number of boxes drawn.",
    "",
    "Coordinate-based act actions (no selector resolution, no shadow walk):",
    "- `page.act action=click_at x=420 y=160` — click at literal viewport coords.",
    "- `page.act action=dblclick_at x=420 y=160` — same, but dblclick.",
    "- `page.act action=hover_at x=420 y=160` — hover at literal coords.",
    "",
    "The `inspect` action also exposes `boundingRect` and `center` on every anchor so the agent",
    "can compute coords without needing the overlay.",
  ].join("\n");
}

function readableFullHtml(): string {
  return [
    "Two new read actions extract page content at different granularities:",
    "",
    "- `page.read action=readable` — Trafilatura-style extraction. Strips nav / footer / ads /",
    "  sidebars and returns the main article text. Hard cap 1 MB (truncated + `truncated: true`",
    "  if exceeded). Response shape: `{ title, content, excerpt, length, fallback }`.",
    "- `page.read action=full_html` — Returns `document.documentElement.outerHTML`. The whole",
    "  document including `<html>`, `<head>`, `<body>`, all attributes. Hard cap 5 MB.",
    "",
    "Use `readable` when you want the article text. Use `full_html` when you want the raw page",
    "structure (for parsing, scraping, or saving).",
  ].join("\n");
}

function gateModel(): string {
  return [
    "Some tools require explicit approval before execution:",
    "",
    "- **Browser connection** — initial browser connection triggers an approval prompt.",
    "- **`page.execute` / `page_js`** — gated escape hatch; default deny.",
    "- **`page.act`** — default `ask`; user approves each invocation in the extension popup.",
    "- **`cookies` / `windows`** — gated at the group level (one gate for the whole group).",
    "",
    "Pending approvals are listed via `approvals list` (CLI) or in the extension popup.",
  ].join("\n");
}

function toolReference(): string {
  return [
    "Each tool also accepts a `help: true` parameter for per-tool help without executing.",
    "Use this to explore tool capabilities before making real calls.",
    "",
    "Example: `page_act({ help: true })` returns the full parameter reference for `page_act`.",
  ].join("\n");
}

function actionReference(toolName: "page.read" | "page.act", actions: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`All \`${toolName}\` actions (one-line summary):`);
  lines.push("");
  for (const a of actions) {
    lines.push(`- \`${toolName} action=${a}\` — ${actionOneLiner(toolName, a)}`);
  }
  return lines.join("\n");
}

function actionOneLiner(tool: "page.read" | "page.act", action: string): string {
  const m: Record<string, Record<string, string>> = {
    "page.read": {
      inspect: "Return a tree of interactable elements with anchor IDs",
      content: "Return the page's visible text",
      text: "Return text of elements matching a CSS selector",
      html: "Return outerHTML of elements matching a CSS selector",
      attr: "Read a specific attribute",
      meta: "Return page metadata (title, OG tags, canonical URL)",
      forms: "List forms with structured field data",
      count: "Count elements matching a CSS selector",
      select: "Return the currently selected text",
      summary: "Lightweight page overview",
      frames: "List iframes on the page",
      generate_selector: "Generate ranked CSS selectors for a target",
      console: "Read captured console entries (CDP-driven)",
      runtime_status: "Return full surface state (isolated + CDP)",
      readable: "Trafilatura-style article extraction (strips nav/footer/ads)",
      full_html: "Return `document.documentElement.outerHTML`",
    },
    "page.act": {
      click: "Click the element (CDP `Input.dispatchMouseEvent`)",
      fill: "Set an input value (CDP `Runtime.evaluate` in main world)",
      check: "Toggle a checkbox/radio",
      select_option: "Select a `<select>` option by value or label",
      press: "Press a key on a focused element (CDP `Input.dispatchKeyEvent`)",
      scroll: "Scroll the page or scroll to an element",
      submit: "Submit a form",
      wait_for: "Wait for an element/condition/URL",
      type: "Type text into a focused element (CDP `Input.insertText`)",
      smart_click: "Click using only a semantic target (no anchor needed)",
      fill_form: "Fill multiple form fields in one call",
      upload: "Upload a file to a file input",
      drag: "Drag an element to (x, y) — synthetic",
      dblclick: "Double-click the element (CDP — two press/release pairs)",
      hover: "Hover the element (CDP `Input.dispatchMouseEvent` mouseMoved)",
      dialog_override: "Install dialog interceptors",
      dialog_respond: "Set the next dialog response",
      click_at: "Click at literal viewport coords (CDP — no resolution)",
      dblclick_at: "Double-click at literal viewport coords (CDP)",
      hover_at: "Hover at literal viewport coords (CDP)",
    },
  };
  return m[tool]?.[action] ?? "(see `help page.act " + action + "`)";
}

function actionDeepDive(tool: "read" | "act", action: string): string {
  if (tool === "act" && action === "click") {
    return [
      "Click an element. Use anchor fast-path or structured target.",
      "",
      "Parameters:",
      "- `target` (object, optional): Structured target (css, text, role, label, placeholder, testId).",
      "- `anchor` (string, optional): Anchor ID from `page.read action=inspect`.",
      "- `shadowPath` (array, optional): Chain of host tag names for shadow-DOM descent.",
      "",
      "Implementation:",
      "- Primary: CDP `Input.dispatchMouseEvent` at element center coords (browser-level input).",
      "- Fallback: synthetic `MouseEvent` + `el.click()` if CDP attach is denied.",
      "- Verdict: `world: \"cdp\"`, `path: \"cdp.input.dispatchMouseEvent\"` on success;",
      "  `world: \"isolated\"`, `path: \"isolated.fallbackClick\"` on fallback.",
      "",
      "Examples:",
      "```",
      "page_act({ action: \"click\", target: { text: \"Submit\" } })",
      "page_act({ action: \"click\", anchor: \"a7\" })",
      "page_act({ action: \"click\", target: { css: \"#inner-btn\" }, shadowPath: [\"host\"] })",
      "```",
    ].join("\n");
  }
  if (tool === "act" && (action === "click_at" || action === "dblclick_at" || action === "hover_at")) {
    return [
      `Click/dblclick/hover at literal viewport coords. No selector resolution, no shadow walk.`,
      ``,
      `Parameters:`,
      `- x (number, required): Viewport x coordinate.`,
      `- y (number, required): Viewport y coordinate.`,
      `- button (string, optional): "left" | "right" | "middle" (default "left").`,
      `- clickCount (number, optional): For click_at only.`,
      ``,
      `Implementation: pure CDP \`Input.dispatchMouseEvent\`. No fallback.`,
      `Verdict: \`world: "cdp"\`, \`path: "cdp.input.dispatchMouseEvent"\`.`,
      ``,
      `Use case: pair with \`screenshots.capture({ overlay: "both" })\` to read coords off the`,
      `overlay and click literal positions on canvas-rendered UI / games / maps.`,
    ].join("\n");
  }
  if (tool === "act" && action === "press") {
    return [
      "Press a keyboard key on a focused element (or globally if no target).",
      "",
      "Parameters:",
      "- `target` (object, optional): Structured target to focus first.",
      "- `anchor` (string, optional): Anchor ID from `page.read action=inspect`.",
      "- `key` (string, required if no `keys`): Key name (e.g. \"Enter\", \"Tab\", \"Escape\").",
      "- `keys` (array, optional): Playwright-style key combination (last entry is the active key, earlier entries are modifiers).",
      "",
      "Implementation:",
      "- Primary: CDP `Input.dispatchKeyEvent` (keyDown + keyUp) with key→code mapping.",
      "- Fallback: synthetic KeyboardEvent if CDP attach is denied.",
      "- Verdict: `world: \"cdp\"`, `path: \"cdp.input.dispatchKeyEvent\"` on success.",
      "",
      "Examples:",
      "```",
      "page_act({ action: \"press\", target: { css: \"#input\" }, key: \"Enter\" })",
      "page_act({ action: \"press\", keys: [\"Control\", \"a\"] })",
      "page_act({ action: \"press\", key: \"Escape\" })  # global",
      "```",
    ].join("\n");
  }
  if (tool === "act" && action === "fill") {
    return [
      "Set a form field's value programmatically.",
      "",
      "Parameters:",
      "- `target` (object, optional): Structured target.",
      "- `anchor` (string, optional): Anchor ID.",
      "- `value` (string, required): Value to set.",
      "",
      "Implementation:",
      "- Primary: CDP `Runtime.evaluate` in main world — uses the prototype's native value setter",
      "  to bypass React controlled-input protection, then dispatches `input` and `change`.",
      "- Fallback: isolated-world native setter + events.",
      "- Verdict: `world: \"main\"`, `path: \"cdp.runtime.evaluate\"` on success.",
    ].join("\n");
  }
  if (tool === "read" && action === "inspect") {
    return [
      "Discover all interactable elements on the page and assign anchor IDs.",
      "",
      "Parameters:",
      "- `limit` (number, optional): Max anchors to return (default 50).",
      "- `include_hidden` (boolean, optional): Include hidden/off-screen elements (default false).",
      "- `compact` (boolean, optional): Return minimal fields only (default false).",
      "",
      "Output: `{ url, title, documentId, anchors: [{ anchor, tag, role, text, type, visible, enabled, checked, selected, target, shadowPath, boundingRect, center }] }`",
      "",
      "Non-compact anchors include `boundingRect: { x, y, width, height }` and `center: { x, y }`,",
      "sourced from `getBoundingClientRect()`. Both are integers. Use these to drive `click_at`",
      "or to draw your own overlay.",
    ].join("\n");
  }
  if (tool === "read" && action === "readable") {
    return [
      "Trafilatura-style article extraction. Strips nav / footer / ads / sidebars.",
      "",
      "Parameters: (none — operates on the full page)",
      "",
      "Output: `{ title, content, excerpt, byline?, length, fallback, truncated? }`",
      "",
      "Hard cap: 1 MB. If exceeded, `truncated: true` and content is sliced.",
      "Verdict: `world: \"isolated\"`, `path: \"isolated.readable\"`.",
    ].join("\n");
  }
  if (tool === "read" && action === "full_html") {
    return [
      "Return the entire document HTML (the literal `document.documentElement.outerHTML`).",
      "",
      "Parameters: (none)",
      "",
      "Output: `{ html, length, originalLength, truncated? }`",
      "",
      "Hard cap: 5 MB. If exceeded, `truncated: true` and html is sliced.",
      "Verdict: `world: \"isolated\"`, `path: \"isolated.fullHtml\"`.",
    ].join("\n");
  }
  return `See the per-tool help for full details. Try \`help ${tool === "read" ? "page-read" : "page-act"}\` for an overview, or call \`${tool === "read" ? "page_read" : "page_act"}\` with \`{ help: true }\` for parameters.`;
}

function perToolHelp(): string {
  const lines: string[] = [];
  lines.push("Every MCP tool accepts a `help: true` parameter. Example:");
  lines.push("```");
  lines.push("page_act({ help: true })  // returns full page_act reference");
  lines.push("```");
  lines.push("");
  lines.push("Available tools: " + MCP_TOOL_CATALOG.map((t) => `\`${t.name}\``).join(", "));
  return lines.join("\n");
}

function connectionLifecycle(): string {
  return [
    "1. Client connects via MCP (streamable HTTP), REST, CLI, or WebSocket.",
    "2. Browser extension auto-registers with the core via WebSocket.",
    "3. Tool calls flow: client → core → (gate check) → WS → extension → chrome.* API.",
    "4. Verdict flows back: chrome.* API → extension → WS → core → client.",
    "5. Heartbeats every 30s. Stale browsers (>60s no heartbeat) are removed.",
  ].join("\n");
}

function renderTopic(topic: HelpTopic): string {
  switch (topic) {
    case "all":
      return buildHelpIndex();
    case "navigation":
      return `# Navigation Workflow\n\n${navigationWorkflow()}`;
    case "anchors":
      return `# Element Targeting & Anchors\n\n${elementTargeting()}`;
    case "gates":
      return `# Gate / Approval Model\n\n${gateModel()}`;
    case "page-read":
      return `# page.read Reference\n\n${actionReference("page.read", PAGE_READ_ACTIONS)}\n\nFor per-action deep-dive, run \`help page.read <action>\` (e.g. \`help page.read inspect\`).`;
    case "page-act":
      return `# page.act Reference\n\n${actionReference("page.act", PAGE_ACT_ACTIONS)}\n\nFor per-action deep-dive, run \`help page.act <action>\` (e.g. \`help page.act click\`).`;
    case "page-js":
      return [
        "# page.js — JavaScript escape hatch",
        "",
        "Execute arbitrary JavaScript on the page via CDP `Runtime.evaluate` — bypasses page CSP,",
        "full access to page variables. Gated by `page.execute` (default deny).",
        "",
        "Parameters:",
        "- `code` (string, required): JavaScript expression or statement to evaluate.",
        "- `timeout_ms` (number, optional): Max wait (default 120000).",
        "",
        "Verdict: `world: \"main\"`, `path: \"cdp.runtime.evaluate\"`.",
        "",
        "Use only when `page.read` and `page.act` cannot express the task.",
      ].join("\n");
    case "visual":
      return `# Visual Layer\n\n${visualLayer()}`;
    case "permissions":
      return `# Permissions\n\n${permissionTable()}\n\n${gateModel()}`;
  }
}

function describeTopic(t: string): string {
  const map: Record<string, string> = {
    all: "The full system reference (default).",
    navigation: "Connect, navigate, inspect, act workflow.",
    anchors: "Element targeting strategies (text, anchor, CSS, role).",
    gates: "Approval model for sensitive tools.",
    "page-read": "All `page.read` actions with one-line descriptions.",
    "page-act": "All `page.act` actions with one-line descriptions.",
    "page-js": "The `page.js` escape hatch — when and how to use it.",
    visual: "Screenshot overlay, click_at, hover_at, boundingRect.",
    permissions: "Permission groups, default levels, and the gate model.",
  };
  return map[t] ?? "(no description)";
}
