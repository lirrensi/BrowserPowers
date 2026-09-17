import { Command } from "commander";
import { loadConfig } from "../config.js";
import { stringify } from "yaml";
import { buildHelpIndex, buildCommandHelp, buildTopicHelp, getCommandNames, getTopics, buildToolHelp } from "./help-text.js";
import { VERSION } from "../version.js";

const config = loadConfig();
const BASE = `http://${config.host}:${config.port}${config.rest.path}`;
const FETCH_TIMEOUT_MS = 5000;

function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers ?? {});
  if (config.auth.apiKey) {
    headers.set("Authorization", `Bearer ${config.auth.apiKey}`);
  }
  return fetch(url, {
    ...options,
    headers,
    signal: options?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function cliError(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/** Format data as human-readable text instead of raw JSON (#009). */
function prettyPrint(data: unknown): string {
  if (data === null || data === undefined) return "(empty)";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (Array.isArray(data)) {
    return data.map(item => typeof item === "object" ? JSON.stringify(item, null, 2) : String(item)).join("\n");
  }
  return JSON.stringify(data, null, 2);
}

/** Execute a tool via REST, handling --async mode if set on the program */
async function executeViaRest(
  browserId: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const isAsync = program.opts().async;
  if (isAsync) {
    const res = await apiFetch(`${BASE}/browsers/${browserId}/execute-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, params }),
    });
    const data = await res.json() as { requestId?: string; error?: string };
    if (data.error) cliError(data.error);
    console.log(`⏳ Queued as ${data.requestId}`);
    console.log(`   Poll: GET ${BASE}/results/${data.requestId}`);
    return null;
  }
  const res = await apiFetch(`${BASE}/browsers/${browserId}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, params }),
  });
  return res.json();
}

const program = new Command();

program
  .name("browserpowers")
  .description("CLI for multi-browser agent control (`bp` is shorthand — same commands)")
  .version(VERSION)
  .option("--async", "Execute asynchronously — print requestId and exit immediately");

// ── Helper: auto-detect target type from shorthand string (#028) ──
// Mirrors Playwright's locator behavior:
//   "#id"     → CSS, ".class"   → CSS, "[attr]" → CSS
//   "text:"   → text literal
//   bare string  → text (matched against visible text)

function autoDetectTarget(input: string): Record<string, unknown> {
  input = input.trim();
  if (input.startsWith("#") || input.startsWith(".") || input.startsWith("[")) {
    return { css: input };
  }
  if (input.startsWith("text:")) {
    return { text: input.slice(5).trim() };
  }
  // Bare string — treat as text match
  return { text: input };
}

// ── Helper: parse key=value args and JSON into a params object ──

function parseParamArgs(args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const arg of args) {
    // Try JSON first
    try {
      const parsed = JSON.parse(arg);
      if (typeof parsed === "object" && parsed !== null) {
        Object.assign(params, parsed);
        continue;
      }
    } catch {
      // Not JSON, try key=value
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      const val = arg.slice(eqIdx + 1);
      // Try to parse as number or boolean
      if (val === "true") params[key] = true;
      else if (val === "false") params[key] = false;
      else if (!isNaN(Number(val))) params[key] = Number(val);
      else params[key] = val;
    }
  }
  return params;
}

// ── list ──
program
  .command("list")
  .description("List all connected browsers (id, name, capabilities, last heartbeat).")
  .action(async () => {
    const res = await apiFetch(`${BASE}/browsers`);
    const { browsers } = await res.json() as { browsers: any[] };
    if (browsers.length === 0) {
      console.log("No browsers connected.");
      return;
    }
    for (const b of browsers) {
      console.log(`  ${b.id}  "${b.name}"  [${b.capabilities.join(", ")}]  heartbeat: ${new Date(b.lastHeartbeat).toISOString()}`);
    }
  });

// ── navigate ──
program
  .command("navigate <browserId> <url>")
  .description("Navigate a browser to a URL. Creates a new tab. For existing-tab navigation, use `page read <browser> inspect` first to discover tab IDs.")
  .action(async (browserId: string, url: string) => {
    const result = await executeViaRest(browserId, "tabs.create", { url }) as any;
    if (result === null) return; // async mode
    console.log(result.success ? `✅ Navigated to ${url}` : `❌ ${result.error}`);
  });

// ── screenshot ──
program
  .command("screenshot <browserId> [filepath]")
  .description("Take a screenshot. Saves to filepath if given, else prints base64 JSON (WSL/host-safe). Options: --overlay, --full-page, --json.")
  .option("--overlay <mode>", "Overlay mode: none|labels|coords|both|anchors_only (default none)")
  .option("--overlay-limit <n>", "Max anchors to draw (default 50)", (v) => Number(v))
  .option("--full-page", "Attempt full-page capture via CDP captureBeyondViewport")
  .option("--json", "Print raw JSON with base64 inline")
  .action(async (browserId: string, filepath?: string, options?: { overlay?: string; overlayLimit?: number; fullPage?: boolean; json?: boolean }) => {
    const params: Record<string, unknown> = {};
    if (options?.overlay) params.overlay = options.overlay;
    if (options?.overlayLimit !== undefined) params.overlay_limit = options.overlayLimit;
    if (options?.fullPage) params.full_page = true;
    const result = await executeViaRest(browserId, "screenshots.capture", params) as any;
    if (result === null) return; // async mode
    if (!result.success) {
      cliError(result.error ?? "Screenshot failed");
    }
    if (filepath && result.data?.base64) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filepath, Buffer.from(result.data.base64, "base64"));
      console.log(`✅ Screenshot saved to ${filepath}${result.data.full_page ? " (full_page)" : ""}${result.data.overlay && result.data.overlay !== "none" ? ` overlay=${result.data.overlay} drawn=${result.data.drawn ?? 0}` : ""}`);
      if (options?.json) console.log(JSON.stringify(result.data));
    } else {
      console.log(JSON.stringify(result.data));
    }
  });

// ── content ──
program
  .command("content <browserId> [selector]")
  .description("Get page content from a browser. If selector is omitted, returns the page's visible text (`document.body.innerText`); otherwise returns the matched element's text.")
  .action(async (browserId: string, selector?: string) => {
    const result = await executeViaRest(browserId, "page.read", { action: "content", target: selector ? { css: selector } : undefined }) as any;
    if (result === null) return; // async mode
    if (!result.success) {
      cliError(result.error ?? "Content fetch failed");
    }
    console.log(prettyPrint(result.data));
  });

// ── select ──
program
  .command("select <browserId>")
  .description("Get the currently selected text on the page. Returns an empty string if nothing is selected.")
  .action(async (browserId: string) => {
    const result = await executeViaRest(browserId, "page.read", { action: "select" }) as any;
    if (result === null) return; // async mode
    if (!result.success) {
      cliError(result.error ?? "Select text fetch failed");
    }
    console.log(prettyPrint(result.data));
  });

// ── tabs ──
program
  .command("tabs <browserId>")
  .description("List all open tabs in a browser. Returns id, url, title, and active status for each tab.")
  .action(async (browserId: string) => {
    const result = await executeViaRest(browserId, "tabs.list", {}) as any;
    if (result === null) return; // async mode
    if (!result.success) {
      cliError(result.error ?? "Tabs list failed");
    }
    console.log(prettyPrint(result.data));
  });

// ── exec ──
program
  .command("exec <browserId> <tool> [params...]")
  .description("Execute any tool with raw JSON params (escape hatch for tools not yet on the CLI). Example: `browserpowers exec my-browser page.read '{\"action\":\"inspect\"}'`")
  .action(async (browserId: string, tool: string, paramArgs: string[]) => {
    let params: Record<string, unknown> = {};
    if (paramArgs.length > 0) {
      try {
        params = JSON.parse(paramArgs.join(" "));
      } catch {
        cliError("Invalid JSON params");
      }
    }
    const result = await executeViaRest(browserId, tool, params) as any;
    if (result === null) return; // async mode
    console.log(JSON.stringify(result, null, 2));
  });

// ── exec-all ──
program
  .command("exec-all <tool> [params...]")
  .description("Execute a tool on ALL browsers (pretty-printed by default)")
  .option("--json", "Output raw JSON instead of pretty-printed table")
  .action(async (tool: string, paramArgs: string[], options: { json?: boolean }) => {
    let params: Record<string, unknown> = {};
    if (paramArgs.length > 0) {
      try {
        params = JSON.parse(paramArgs.join(" "));
      } catch {
        cliError("Invalid JSON params");
      }
    }
    const res = await apiFetch(`${BASE}/execute-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, params }),
    });
    const result = await res.json() as { results?: Array<{ browserId?: string; success?: boolean; error?: string; data?: unknown }> };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Pretty-print grouped by browser name
    const results = result.results ?? [];
    if (results.length === 0) {
      console.log("No browsers connected.");
      return;
    }

    // Fetch browser list for name mapping
    let nameMap = new Map<string, string>();
    try {
      const browsersRes = await apiFetch(`${BASE}/browsers`);
      const { browsers } = await browsersRes.json() as { browsers: Array<{ id: string; name: string }> };
      nameMap = new Map(browsers.map(b => [b.id, b.name]));
    } catch {
      // If fetch fails, fall back to showing IDs only
    }

    console.log(`\n  Tool: ${tool}`);
    console.log(`  Results (${results.length} browser(s)):\n`);
    for (const r of results) {
      const icon = r.success ? "✅" : "❌";
      const brief = r.success ? "OK" : (r.error ?? "Unknown error").slice(0, 80);
      const displayName = nameMap.get(r.browserId ?? "") ?? r.browserId ?? "?";
      console.log(`    ${icon} ${displayName}  — ${brief}`);
    }
    console.log("");
  });

// ── page read ──
program
  .command("page")
  .description("Page operations — read (no mutation) or act (mutation). Sub-commands: `page read <browserId> <action>`, `page act <browserId> <action>`. Run `browserpowers help page-read` or `browserpowers help page-act` for the full action list.")
  .addCommand(
    new Command("read")
      .description("Read page content without mutating it. Use `browserpowers help page-read` to list all read actions.")
      .argument("<browserId>", "Target browser ID")
      .argument("<action>", "Read action (e.g. inspect, content, text, html, attr, meta, forms, count, select, summary, frames, generate_selector, console, runtime_status, readable, full_html). Run `help page-read` for the full list with descriptions.")
      .argument("[params...]", "key=value params or JSON. Examples: target=#my-button, target={text:Submit}, limit=20")
      .option("--json", "Output raw JSON")
      .action(async (browserId: string, action: string, paramArgs: string[], options: { json?: boolean }) => {
        const params = parseParamArgs(paramArgs);

        // Auto-detect target from shorthand (#028)
        if (params.target && typeof params.target === "string") {
          params.target = autoDetectTarget(params.target as string);
        }

        const res = await executeViaRest(browserId, "page.read", { action, ...params }) as any;
        if (res === null) return; // async mode
        if (!res.success) {
          cliError(res.error ?? "Page read failed");
        }
        if (options.json) {
          console.log(JSON.stringify(res.data, null, 2));
        } else {
          console.log(prettyPrint(res.data));
        }
      }),
  )
  .addCommand(
    new Command("act")
      .description("Interact with or mutate the page. Most actions run via CDP `Input.*` (CSP-immune). Use `browserpowers help page-act` to list all act actions.")
      .argument("<browserId>", "Target browser ID")
      .argument("<action>", "Act action: click, fill, check, select_option, press, scroll, submit, wait_for, type, smart_click, fill_form, upload, drag, dblclick, hover, click_at, dblclick_at, hover_at, dialog_override, dialog_respond. Run `help page-act` for the full list with descriptions.")
      .argument("[params...]", "key=value params or JSON. Examples: target=#my-button, target={text:Submit}, x=120, y=200")
      .option("--json", "Output raw JSON")
      .action(async (browserId: string, action: string, paramArgs: string[], options: { json?: boolean }) => {
        const params = parseParamArgs(paramArgs);

        // Auto-detect target from shorthand (#028)
        if (params.target && typeof params.target === "string") {
          params.target = autoDetectTarget(params.target as string);
        }

        // For common commands, allow shorthand like "css=#my-button"
        if (params.css) {
          params.target = { css: params.css };
          delete params.css;
        }
        if (params.text) {
          params.target = { text: params.text };
          delete params.text;
        }

        const result = await executeViaRest(browserId, "page.act", { action, ...params }) as any;
        if (result === null) return; // async mode
        if (!result.success) {
          cliError(result.error ?? "Page act failed");
        }
        if (options.json) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          // Compact output for common actions
          const data = result.data;
          if (data?.message) {
            console.log(`  ✅ ${data.message}`);
            if (data.evidence) {
              console.log(`     ${JSON.stringify(data.evidence)}`);
            }
          } else {
            console.log(JSON.stringify(data, null, 2));
          }
        }
      }),
  );

// ── status (health) ──
// Health = daemon alive + browser connected + heartbeat fresh.
// Dedicated automation browser model: user does NOT use this browser day-to-day,
// so stale heartbeat (>60s) means extension asleep/crashed — reload extension.
program
  .command("status")
  .description("Check daemon health, uptime, and connected browsers (heartbeat fresh = healthy)")
  .option("--json", "Output raw JSON health")
  .action(async (options: { json?: boolean }) => {
    // Check if REST API is alive
    try {
      const browsersRes = await apiFetch(`${BASE}/browsers`, {
        signal: AbortSignal.timeout(3000),
      });
      const { browsers } = await browsersRes.json() as { browsers: any[] };
      let approvals: any[] = [];
      try {
        const apprRes = await apiFetch(`${BASE}/approvals`, { signal: AbortSignal.timeout(3000) });
        approvals = ((await apprRes.json()) as { approvals: any[] }).approvals ?? [];
      } catch { /* approvals best-effort */ }
      let health: { status?: string; uptime?: number } = {};
      try {
        const hRes = await apiFetch(`${BASE.replace(/\/api$/, "/api")}/health`, { signal: AbortSignal.timeout(3000) });
        if (hRes.ok) health = await hRes.json();
      } catch { /* health best-effort — /health lives under /api */ }

      if (options.json) {
        console.log(JSON.stringify({ ok: true, health, browsers, pendingApprovals: approvals.length }, null, 2));
        return;
      }

      // Try to read PID file
      const { homedir } = await import("node:os");
      const { readFileSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const pidPath = resolve(homedir(), ".browserpowers", "daemon.pid");

      console.log("\n  🔥 BrowserPowers Daemon\n");

      if (existsSync(pidPath)) {
        const pid = readFileSync(pidPath, "utf-8").trim();
        console.log(`  PID:      ${pid}`);
        console.log(`  Running:  ✅ Yes\n`);
      } else {
        console.log(`  PID:      (no PID file)`);
        console.log(`  Running:  ✅ (API responds)\n`);
      }

      console.log(`  API:      ${BASE}`);
      if (health.uptime !== undefined) console.log(`  Uptime:   ${health.uptime}s`);
      console.log(`  Browsers: ${browsers.length} connected`);
      console.log(`  Approvals pending: ${approvals.length}\n`);

      if (browsers.length === 0) {
        console.log("  No browsers connected. Load the extension and check it's connecting to this server.");
      } else {
        for (const b of browsers) {
          const age = Math.round((Date.now() - b.connectedAt) / 1000);
          const hbAgeMs = Date.now() - (b.lastHeartbeat ?? Date.now());
          const hbNote = hbAgeMs > 60_000 ? `  ⚠️ STALE heartbeat ${Math.round(hbAgeMs / 1000)}s ago — reload extension` : `  heartbeat ${Math.round(hbAgeMs / 1000)}s ago`;
          console.log(`    • ${b.id}  "${b.name}"  [${(b.capabilities || []).map((c: any) => c.tool || c).join(", ")}]  connected ${age}s ago${hbNote}`);
        }
        if (approvals.length > 0) console.log(`\n  ${approvals.length} approval(s) waiting in extension popup (Approve Once/Session/Forever or Reject).`);
      }
      console.log("");
    } catch (err) {
      console.log("\n  🔥 BrowserPowers Daemon\n");
      console.log(`  Running:  ❌ Not responding\n`);
      console.log(`  API:      ${BASE}`);
      console.log(`  Error:    ${(err as Error).message}\n`);
      console.log("  Start the daemon:  browserpowers serve\n");
      cliError("Daemon not responding");
    }
  });

// ── request-help (human-loop, no borrow) ──
program
  .command("request-help <browserId>")
  .description("Ask the human to complete an in-page step (login/CAPTCHA/OTP/confirm). Shows OS notification with Continue/Cancel.")
  .requiredOption("--prompt <text>", "Precise human instruction, e.g. \"Please complete sign-in\"")
  .option("--target <target>", "Element context: shorthand (#id/.class/text:.../bare text) or JSON")
  .option("--anchor <id>", "Anchor ID for element context")
  .option("--timeout <ms>", "Max wait 10s-10m in ms (default 300000)", (v) => Number(v))
  .option("--url-contains <s>", "Auto-complete when active tab URL contains this string")
  .option("--url-matches <re>", "Auto-complete when active tab URL matches this regex")
  .option("--json", "Output raw JSON")
  .action(async (browserId: string, options: { prompt: string; target?: string; anchor?: string; timeout?: number; urlContains?: string; urlMatches?: string; json?: boolean }) => {
    const params: Record<string, unknown> = { prompt: options.prompt };
    if (options.target) {
      try {
        params.target = JSON.parse(options.target);
      } catch {
        params.target = autoDetectTarget(options.target);
      }
    }
    if (options.anchor) params.anchor = options.anchor;
    if (options.timeout !== undefined) params.timeout_ms = options.timeout;
    if (options.urlContains || options.urlMatches) {
      params.completion_criteria = {
        ...(options.urlContains ? { url_contains: options.urlContains } : {}),
        ...(options.urlMatches ? { url_matches: options.urlMatches } : {}),
      };
    }
    const result = await executeViaRest(browserId, "human.requestHelp", params) as any;
    if (result === null) return; // async mode
    if (!result.success) cliError(result.error ?? "request-help failed");
    if (options.json) console.log(JSON.stringify(result.data, null, 2));
    else {
      const d = result.data as Record<string, unknown>;
      console.log(`  ${d.outcome === "continued" || d.outcome === "completed" ? "✅" : "❌"} ${d.outcome} (${d.elapsed_ms}ms) — ${d.hint ?? ""}`);
      if (d.outcome === "continued" || d.outcome === "completed") console.log("  Re-inspect before next action — refs are stale.");
    }
  });

// ── init ──
program
  .command("init")
  .description("Run the first-time setup wizard")
  .action(async () => {
    const { createInterface } = await import("node:readline");
    const { existsSync, writeFileSync, mkdirSync, chmodSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { resolve } = await import("node:path");
    const { loadConfig } = await import("../config.js");

    const configDir = resolve(homedir(), ".config", "browserpowers");
    const configPath = resolve(configDir, "config.yaml");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const question = (query: string): Promise<string> =>
      new Promise((resolve) => rl.question(query, resolve));

    console.log(`
  ╔══════════════════════════════════════╗
  ║       BrowserPowers Setup Wizard     ║
  ╚══════════════════════════════════════╝
    `);

    if (existsSync(configPath)) {
      const overwrite = await question("Config already exists. Overwrite? (y/N) ");
      if (overwrite.toLowerCase() !== "y") {
        console.log("Setup cancelled. Existing config preserved.");
        rl.close();
        return;
      }
    }

    const port = await question("Core server port (default: 4199): ");
    const host = await question("Core server host (default: 127.0.0.1): ");
    const browserName = await question("Default browser name (default: My Browser): ");

    rl.close();

    const config = {
      port: port ? parseInt(port, 10) : 4199,
      host: host || "127.0.0.1",
      mcp: { enabled: true, path: "/mcp" },
      rest: { enabled: true, path: "/api" },
      ws: { path: "/ws", heartbeatIntervalMs: 30000 },
      gates: { defaultPermission: "ask" },
      browsers: {
        "default": {
          name: browserName || "My Browser",
          permissions: {
            tabs: "allow",
            "page.read": "allow",
            "page.act": "ask",
            "page.execute": "deny",
            screenshots: "allow",
            history: "deny",
            bookmarks: "deny",
            downloads: "deny",
            network: "deny",
            storage: "deny",
          },
        },
      },
    };

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, stringify(config), "utf-8");
    chmodSync(configPath, 0o600);

    console.log(`\n✅ Config created at ${configPath}`);
    console.log("\n── Next steps ──");
    console.log("1. Start the core:    browserpowers serve");
    console.log("2. Load the extension in your browser (chrome://extensions → Load unpacked → extension/.output/chrome-mv3/)");
    console.log("3. Connect your MCP client to: http://127.0.0.1:4199/mcp");
    console.log("4. Run `browserpowers mcp-config --client claude` for Claude Desktop setup");
    console.log("5. Connect: The extension auto-connects to the core via WebSocket");
    console.log("6. Verify:  Run `browserpowers list` to see connected browsers\n");
  });

// ── stop ──
program
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    const { homedir } = await import("node:os");
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const pidPath = resolve(homedir(), ".browserpowers", "daemon.pid");

    // First try REST graceful shutdown
    try {
      const res = await apiFetch(`${BASE}/browsers`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log("To stop: press Ctrl+C in the server terminal, or kill the process.");
        console.log(`If you have a PID file at ${pidPath}, use: taskkill /PID $(type ${pidPath})`);
        return;
      }
    } catch {
      // Server not responding
    }

    // Try PID file
    if (existsSync(pidPath)) {
      const pid = readFileSync(pidPath, "utf-8").trim();
      console.log(`Found PID ${pid} from ${pidPath}`);
      console.log(`Run: taskkill /PID ${pid} (Windows) or kill ${pid} (Unix)`);
    } else {
      console.log("Cannot determine how to stop the daemon. No PID file found and API not responding.");
      process.exit(1);
    }
  });

// ── config ──
program
  .command("config")
  .description("Show configuration")
  .addCommand(
    new Command("show")
      .description("Print current configuration")
      .action(async () => {
        const { loadConfig } = await import("../config.js");
        const cfg = loadConfig();
        console.log(JSON.stringify(cfg, null, 2));
      })
  )
  .addCommand(
    new Command("path")
      .description("Print config file location")
      .action(async () => {
        const { CONFIG_PATH } = await import("../config.js");
        console.log(CONFIG_PATH);
      })
  );

// ── sdk ──
// The installer vendors the zero-dep script client (client.js + .d.ts +
// package.json) into the install dir so the repo is deletable afterwards.
// `sdk path` prints that stable directory; `run` executes inline JS against it.
async function resolveSdkDir(): Promise<string> {
  const { homedir } = await import("node:os");
  const { resolve } = await import("node:path");
  const home = process.env.BROWSERPOWERS_HOME?.trim() || homedir();
  return process.env.BROWSERPOWERS_HOME?.trim()
    ? resolve(home, "sdk")
    : resolve(home, ".browserpowers", "sdk");
}
program
  .command("sdk")
  .description("Script client (SDK) helpers — vendored by the installer, repo-independent")
  .addCommand(
    new Command("path")
      .description("Print the vendored SDK directory (stable import source for any project)")
      .action(async () => {
        const { resolve } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const sdkDir = await resolveSdkDir();
        if (!existsSync(resolve(sdkDir, "package.json")) || !existsSync(resolve(sdkDir, "client.js"))) {
          console.error(`❌ SDK not found at ${sdkDir} — re-run: node scripts/install.mjs`);
          process.exit(1);
        }
        console.log(sdkDir);
      })
  );

// ── run ──
// Inline scripting with zero setup: no project, no npm install, no file.
// `bp` is a prebound BrowserPowersClient, `sdk` the vendored module namespace.
// The inline code runs inside an async wrapper, so `await` works at the top
// level and an explicit `return` surfaces its completion value. Verified live:
// `Object.keys(sdk)` -> ["BrowserPowersClient", ...] (NOT `import 'sdk'` —
// commander would swallow that; the namespace is prebound, not resolvable).
// Examples (quote so the shell passes one arg):
//   bp run "return (await bp.listBrowsers()).length"
//   bp run "await bp.navigate((await bp.waitForBrowser()).id, 'https://example.com')"
//   bp run "return Object.keys(sdk)"
program
  .command("run")
  .description("Run inline JS against the vendored SDK — no project, no file. `bp` prebound.")
  .option("-e, --eval <code>", "Inline script (alternatively pass code as bare args, joined with spaces)")
  .option("--json", "Print the completion value as JSON instead of util.inspect")
  .argument("[code...]", "Inline JS. `bp` and `sdk` are prebound; top-level await works; `return` prints.")
  .action(async (code: string[], options: { eval?: string; json?: boolean }) => {
    const { resolve } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const { pathToFileURL } = await import("node:url");
    const sdkDir = await resolveSdkDir();
    const clientPath = resolve(sdkDir, "client.js");
    if (!existsSync(clientPath)) {
      cliError(`SDK not found at ${sdkDir} — re-run: node scripts/install.mjs`);
    }
    const inline = [options.eval, ...(code ?? [])].filter(Boolean).join(" ").trim();
    if (!inline) {
      cliError(`No script given. Example: bp run "return (await bp.listBrowsers()).length"`);
    }
    let sdk: unknown;
    try {
      sdk = await import(pathToFileURL(clientPath).href);
    } catch (e) {
      cliError(`Failed to load SDK at ${sdkDir}: ${(e as Error).message}`);
    }
    if (!sdk || typeof sdk !== "object" || !("BrowserPowersClient" in sdk)) {
      cliError(`SDK at ${sdkDir} has no BrowserPowersClient export — re-run: node scripts/install.mjs`);
    }
    const ctorUnknown: unknown = sdk.BrowserPowersClient;
    if (typeof ctorUnknown !== "function") {
      cliError(`SDK at ${sdkDir} has no BrowserPowersClient export — re-run: node scripts/install.mjs`);
    }
    const bp: unknown = Reflect.construct(ctorUnknown, []);
    const factory: unknown = new Function("bp", "sdk", `"use strict"; return (async () => { ${inline} })();`);
    if (typeof factory !== "function") {
      cliError(`Failed to compile inline script`);
    }
    try {
      const value: unknown = await Reflect.apply(factory, undefined, [bp, sdk]);
      if (value !== undefined) {
        if (options.json) console.log(JSON.stringify(value, null, 2));
        else {
          const { inspect } = await import("node:util");
          console.log(inspect(value, { depth: 10, colors: process.stdout.isTTY }));
        }
      }
    } catch (e) {
      console.error(`❌ ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(1);
    }
  });

// ── mcp-config ──
program
  .command("mcp-config")
  .description("Generate MCP client configuration snippet")
  .option("-c, --client <name>", "Target client: claude, cursor, or generic")
  .action(async (options: { client?: string }) => {
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    const baseUrl = `http://${config.host}:${config.port}${config.mcp.path}`;

    const client = (options.client || "generic").toLowerCase();

    const snippets: Record<string, object> = {
      generic: {
        mcpServers: {
          browserpowers: {
            url: baseUrl,
          },
        },
      },
      claude: {
        mcpServers: {
          browserpowers: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-stdio"],
            url: baseUrl,
          },
        },
      },
      cursor: {
        mcpServers: {
          browserpowers: {
            url: baseUrl,
            type: "streamable-http",
          },
        },
      },
    };

    const snippet = snippets[client] ?? snippets.generic;

    console.log(JSON.stringify(snippet, null, 2));
    console.log(`\n// Paste the above into your ${client === "generic" ? "MCP client" : client + " config"} file to connect BrowserPowers.\n`);
  });

// ── disconnect ──
program
  .command("disconnect <browserId>")
  .description("Disconnect a browser from the daemon")
  .action(async (browserId: string) => {
    try {
      const res = await apiFetch(`${BASE}/browsers/${browserId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        console.log(`✅ Disconnected browser ${browserId}`);
      } else {
        const err = await res.json() as { error?: string };
        cliError(err.error || `Failed to disconnect browser ${browserId}`);
      }
    } catch (e) {
      cliError(`Failed to disconnect: ${(e as Error).message}`);
    }
  });

// ── approvals ──
program
  .command("approvals")
  .description("Manage pending approval requests")
  .addCommand(
    new Command("list")
      .description("List all pending approvals")
      .action(async () => {
        try {
          const res = await apiFetch(`${BASE}/approvals`);
          const data = await res.json() as { approvals: any[] };
          if (data.approvals.length === 0) {
            console.log("No pending approvals.");
            return;
          }
          for (const a of data.approvals) {
            console.log(`  ${a.requestId}  tool: ${a.tool}  browser: ${a.browserId}  waiting since ${new Date(a.requestedAt).toISOString()}`);
          }
        } catch (e) {
          cliError(`Failed to list approvals: ${(e as Error).message}`);
        }
      })
  )
  .addCommand(
    new Command("cancel <requestId>")
      .description("Cancel a pending approval request")
      .action(async (requestId: string) => {
        try {
          const res = await apiFetch(`${BASE}/approvals/${requestId}`, { method: "DELETE" });
          if (res.ok) {
            console.log(`✅ Cancelled approval ${requestId}`);
          } else {
            const err = await res.json() as { error?: string };
            cliError(err.error || `Failed to cancel approval`);
          }
        } catch (e) {
          cliError(`Failed to cancel: ${(e as Error).message}`);
        }
      })
  );

// ── capabilities ──
program
  .command("capabilities <browserId>")
  .description("List capabilities for a specific browser")
  .action(async (browserId: string) => {
    try {
      const res = await apiFetch(`${BASE}/browsers/${browserId}/capabilities`);
      const data = await res.json() as { capabilities: Array<{ tool: string; description: string; group: string }> | string[] };
      const caps = data.capabilities;
      if (!caps || caps.length === 0) {
        console.log(`No capabilities for browser ${browserId}`);
        return;
      }
      for (const c of caps) {
        if (typeof c === "string") {
          console.log(`  • ${c}`);
        } else {
          console.log(`  • ${c.tool}  (${c.group})  — ${c.description || "no description"}`);
        }
      }
    } catch (e) {
      cliError(`Failed to list capabilities: ${(e as Error).message}`);
    }
  });

// ── record lite ──
program
  .command("record <browserId> <action>")
  .description("Record ops into trace.json textbook (start|stop|status). Never banking/SSO. stop prints trace JSON.")
  .option("--purpose <text>", "Goal label (start only)")
  .option("--out <file>", "Write trace JSON to file (stop only)")
  .action(async (browserId: string, action: string, options: { purpose?: string; out?: string }) => {
    if (!["start", "stop", "status"].includes(action)) cliError(`record action must be start|stop|status (got ${action})`);
    const params: Record<string, unknown> = {};
    if (options.purpose) params.purpose = options.purpose;
    const result = await executeViaRest(browserId, `record.${action}`, params) as any;
    if (result === null) return;
    if (!result.success) cliError(result.error ?? "record failed");
    if (action === "stop" && options.out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(options.out, JSON.stringify(result.data, null, 2));
      console.log(`✅ Trace written to ${options.out} (${(result.data as { ops?: unknown[] }).ops?.length ?? 0} ops)`);
    } else {
      console.log(JSON.stringify(result.data, null, 2));
    }
  });

// ── audit (redacted read API) ──
program
  .command("audit")
  .description("Inspect redacted audit log (list|show|rm). 30d retention, origin-only URLs, values redacted.")
  .addCommand(new Command("list").description("List audit files").action(async () => {
    const res = await apiFetch(`${BASE}/audit`);
    console.log(JSON.stringify(await res.json(), null, 2));
  }))
  .addCommand(new Command("show <file>").description("Show entries (paginated)").option("--offset <n>", "Offset", (v) => Number(v), 0).option("--limit <n>", "Limit 1-500", (v) => Number(v), 100).action(async (file: string, options: { offset: number; limit: number }) => {
    const res = await apiFetch(`${BASE}/audit/${encodeURIComponent(file)}?offset=${options.offset}&limit=${options.limit}`);
    console.log(JSON.stringify(await res.json(), null, 2));
  }))
  .addCommand(new Command("rm <file>").description("Delete an audit file").action(async (file: string) => {
    const res = await apiFetch(`${BASE}/audit/${encodeURIComponent(file)}`, { method: "DELETE" });
    console.log(JSON.stringify(await res.json(), null, 2));
  }));

// ── serve ──
program
  .command("serve")
  .description("Start the BrowserPowers core server (HTTP + WebSocket + MCP). The server runs in the foreground; press Ctrl+C to stop.")
  .option("--pid-file <path>", "Path to write PID file for process management")
  .action(() => {
    // Serve mode is handled in index.ts, not here.
    // This command exists so --pid-file appears in --help output.
    console.log("To start the server, run: browserpowers serve");
    console.log("The server will start in the foreground. Press Ctrl+C to stop.");
  });

// ── doctor lite (health triage) ──
program
  .command("doctor")
  .description("Run diagnostics: home writable, config, daemon, extension, skill. Prints ok/WARN/FAIL per check.")
  .option("--json", "Machine-readable output")
  .action(async (options: { json?: boolean }) => {
    const rows: Array<{ check: string; status: "ok" | "WARN" | "FAIL"; detail: string; hint?: string }> = [];
    // 1. home writable
    try {
      const { getHomeDir, CONFIG_DIR, CONFIG_PATH } = await import("../config.js");
      const { mkdirSync, writeFileSync, unlinkSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const home = getHomeDir();
      const probeDir = process.env.BROWSERPOWERS_HOME?.trim() ? home : CONFIG_DIR;
      mkdirSync(probeDir, { recursive: true });
      const probe = join(probeDir, ".doctor-probe");
      writeFileSync(probe, "ok");
      unlinkSync(probe);
      rows.push({ check: "home writable", status: "ok", detail: process.env.BROWSERPOWERS_HOME ? `BROWSERPOWERS_HOME=${home}` : probeDir });
    } catch (e) {
      rows.push({ check: "home writable", status: "FAIL", detail: (e as Error).message, hint: "Check BROWSERPOWERS_HOME mount + permissions (same mount on host/sandbox, not just same text)" });
    }
    // 2. config
    try {
      const { loadConfig, CONFIG_PATH } = await import("../config.js");
      loadConfig();
      rows.push({ check: "config", status: "ok", detail: CONFIG_PATH });
    } catch (e) {
      rows.push({ check: "config", status: "FAIL", detail: (e as Error).message, hint: "Fix or delete config YAML to regenerate defaults" });
    }
    // 3. daemon
    let browsers: any[] = [];
    try {
      const res = await apiFetch(`${BASE}/browsers`, { signal: AbortSignal.timeout(3000) });
      browsers = ((await res.json()) as { browsers: any[] }).browsers ?? [];
      rows.push({ check: "daemon running", status: "ok", detail: BASE });
    } catch (e) {
      rows.push({ check: "daemon running", status: "FAIL", detail: (e as Error).message, hint: "Run: browserpowers serve (or npm run dev:core)" });
    }
    // 4. extension
    if (browsers.length > 0) {
      const stale = browsers.filter((b: any) => Date.now() - (b.lastHeartbeat ?? Date.now()) > 60_000);
      rows.push(stale.length === 0
        ? { check: "extension connected", status: "ok", detail: `${browsers.length} browser(s), heartbeats fresh` }
        : { check: "extension connected", status: "WARN", detail: `${stale.length}/${browsers.length} stale heartbeat >60s`, hint: "Reload extension, check WS URL + API key" });
    } else {
      rows.push({ check: "extension connected", status: "FAIL", detail: "0 browsers", hint: "Load extension (chrome://extensions → Load unpacked), check core URL" });
    }
    // 5. skill
    try {
      const { existsSync } = await import("node:fs");
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      // CLI runs from core/dist — walk up to repo root for skill/SKILL.md.
      const here = dirname(fileURLToPath(import.meta.url));
      const candidates = [resolve(here, "../../../skill/SKILL.md"), resolve(process.cwd(), "skill/SKILL.md")];
      const found = candidates.find((p) => existsSync(p));
      rows.push(found
        ? { check: "skill", status: "ok", detail: found }
        : { check: "skill", status: "WARN", detail: "skill/SKILL.md not found", hint: "Copy skill/SKILL.md into your agent harness skills dir" });
    } catch (e) {
      rows.push({ check: "skill", status: "WARN", detail: (e as Error).message });
    }
    // 6. version
    rows.push({ check: "version", status: "ok", detail: VERSION });
    const hasFail = rows.some((r) => r.status === "FAIL");
    if (options.json) {
      console.log(JSON.stringify({ ok: !hasFail, checks: rows }, null, 2));
    } else {
      console.log("\n  🩺 BrowserPowers Doctor\n");
      for (const r of rows) {
        const icon = r.status === "ok" ? "✅" : r.status === "WARN" ? "⚠️" : "❌";
        console.log(`  ${icon} ${r.check}: ${r.detail}`);
        if (r.hint) console.log(`     → ${r.hint}`);
      }
      console.log(hasFail ? "\n  1+ FAIL — follow hints above, re-run doctor.\n" : "\n  All green (WARN ok).\n");
    }
    if (hasFail) process.exitCode = 1;
  });

// ── help [topic] — comprehensive reference (overrides commander's default) ──
//
// Commander ships a built-in `help` that just prints `--help` output. We
// override it with a richer reference that auto-generates from the
// registered commander program + MCP tool catalog + v2 action enums. The
// generated output is also reachable via the `help` topic in `help all`.

program
  .command("help [topic...]")
  .description("Show the full help reference. No arg = full reference. `help <command>` (e.g. `help page.act`) deep-dives a command. `help <topic>` (e.g. `help page-read`) deep-dives a section. `help topics` lists available topics. `help commands` lists all commands.")
  .action((topicParts?: string[]) => {
    const topic = topicParts && topicParts.length > 0 ? topicParts.join(".") : undefined;
    if (!topic) {
      console.log(buildHelpIndex());
      return;
    }
    if (topic === "topics") {
      console.log(buildTopicHelp("topics"));
      return;
    }
    if (topic === "commands") {
      const names = getCommandNames(program);
      console.log("# Available commands\n");
      for (const n of names) console.log(`- \`${n}\``);
      return;
    }
    // Recognised topics?
    if (getTopics().includes(topic)) {
      console.log(buildTopicHelp(topic));
      return;
    }
    // Try MCP tool name first (e.g. `help page_act`), then commander
    // command (e.g. `help page.act` or `help status`).
    if (topic.includes(".") || /^[\w-]+$/.test(topic)) {
      const toolHelp = buildToolHelp(topic);
      if (!toolHelp.startsWith("No help available")) {
        console.log(toolHelp);
        return;
      }
      const cmdHelp = buildCommandHelp(program, topic);
      if (!cmdHelp.startsWith("Unknown command")) {
        console.log(cmdHelp);
        return;
      }
    }
    // Last resort: surface the available topics + commands.
    console.log(`Unknown help target: "${topic}".\n`);
    console.log(buildTopicHelp("topics"));
  });

export function runCli(args: string[]): void {
  program.parse(["node", "browserpowers", ...args]);
}

export default program;
