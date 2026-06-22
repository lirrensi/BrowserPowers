// FILE: core/src/index.ts
// PURPOSE: BrowserPowers CLI entry point: serve, start/stop/restart daemon, and run CLI commands.
// OWNS: Process-mode dispatch, detached daemon lifecycle, and graceful server startup.
// EXPORTS: none (side-effect entry point)
// DOCS: docs/spec/installer-hard-spec.md
//
// ═══════════════════════════════════════════════════════════════
// HARD SPEC — THE WINDOW RULE  (§0.0 of installer-hard-spec.md)
// ═══════════════════════════════════════════════════════════════
//   serve   = ONLY command allowed to open a window (foreground)
//   start   = NEVER a window.  Direct spawn with windowsHide:true
//   restart = NEVER a window.  Stop + start, zero visible console
//   stop    = NEVER a window.  Kill port, exit
//
//   Mechanism:  windowsHide: true → Win32 CREATE_NO_WINDOW flag
//   BANNED:     VBS, cmd /c start /b, ShowWindow(SW_HIDE), or
//               any post-hoc window-hiding trickery.
// ═══════════════════════════════════════════════════════════════

import { createServer } from "node:http";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { createConnection } from "node:net";
import { createApp } from "./server.js";
import { createWsServer } from "./ws-server.js";
import { loadConfig } from "./config.js";
import { runCli } from "./adapters/cli.js";
import { registry } from "./registry.js";
import { cleanupTempScreenshots } from "./screenshot.js";

const config = loadConfig();

/**
 * Entry point.
 *
 * Modes:
 *   `browserpowers serve`    — start the full server in the foreground (HTTP + WS + MCP)
 *   `browserpowers start`    — spawn the server in the background (no console) and exit.
 *                              Idempotent: if already running, prints a message and exits.
 *   `browserpowers restart`  — stop + start. Exits immediately.
 *   `browserpowers stop`     — stop the server (kill process on port).
 *   `browserpowers cli`      — run a CLI subcommand (list, navigate, screenshot, etc.)
 *   (no args)                — default to serve mode
 */

// ── Lifecycle helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Is anything listening on the given port? */
function isPortBusy(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ port, host: "127.0.0.1" }, () => {
      sock.destroy();
      res(true);
    });
    sock.on("error", () => res(false));
    setTimeout(() => { sock.destroy(); res(false); }, 500);
  });
}

/** Resolve the core directory and entry/tsx paths (location-agnostic). */
function resolvePaths() {
  const coreEntry = fileURLToPath(import.meta.url);
  const coreDir = resolve(dirname(coreEntry), "..");
  const tsxCli = resolve(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
  // launcher.exe is compiled once, committed to repo
  const launcherExe = resolve(coreDir, "launcher", "launcher.exe");
  return { coreEntry, coreDir, tsxCli, launcherExe };
}

// ── Windows Task Scheduler helpers ──────────────────────

/** Stop a scheduled task by name. Best-effort; never throws. */
function stopWindowsTask(name: string): void {
  const safeName = name.replace(/'/g, "''");
  try {
    execSync(
      `powershell -NoProfile -Command "Stop-ScheduledTask -TaskName '${safeName}' -EA SilentlyContinue"`,
      { stdio: "pipe", timeout: 8000, windowsHide: true }
    );
  } catch { /* task may not exist or may not be running */ }
}

/**
 * Start the server in a background process that survives its parent.
 *
 * Windows: uses launcher.exe, a compiled GUI-subsystem binary that spawns
 *          the daemon via Win32 CreateProcess(CREATE_NO_WINDOW).  Because
 *          the launcher itself is /SUBSYSTEM:WINDOWS, Windows physically
 *          cannot give it a console — zero window, guaranteed.
 * Unix:    standard detached spawn.
 */
async function startDetached(): Promise<void> {
  if (await isPortBusy(config.port)) {
    console.log(`BrowserPowers is already running on port ${config.port}.`);
    process.exit(0);
  }

  const { coreEntry, coreDir, tsxCli, launcherExe } = resolvePaths();

  if (process.platform === "win32") {
    if (existsSync(launcherExe)) {
      // Launcher is a GUI binary — spawn without shell to avoid
      // cmd.exe quoting issues. stdio:ignore + detached means
      // the launcher runs and exits independently.
      const child = spawn(
        launcherExe,
        [process.execPath, tsxCli, coreEntry, "serve"],
        { stdio: "ignore" }
      );
      child.on("error", () => {});
      child.unref();
      // Launcher exits immediately; daemon binds async.
      for (let i = 0; i < 12; i++) {
        await sleep(250);
        if (await isPortBusy(config.port)) break;
      }
    }
    if (!(await isPortBusy(config.port))) {
      // Fallback to direct spawn if launcher is missing
      const child = spawn(process.execPath, [tsxCli, coreEntry, "serve"], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        cwd: coreDir,
      });
      child.on("error", () => {});
      child.unref();
    }
  } else {
    const child = spawn(process.execPath, [tsxCli, coreEntry, "serve"], {
      detached: true,
      stdio: "ignore",
      cwd: coreDir,
    });
    child.on("error", () => {});
    child.unref();
  }

  // Poll port to confirm it came up. Max 5s.
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (await isPortBusy(config.port)) {
      console.log("BrowserPowers started.");
      process.exit(0);
    }
  }
  console.log("BrowserPowers start initiated.");
  process.exit(0);
}

/** Kill whatever process owns the given port. Best-effort, never throws. */
function killServerOnPort(port: number): void {
  if (process.platform === "win32") {
    try {
      execSync(
        `powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort ${port} -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($p) { Stop-Process -Id $p -Force }"`,
        { stdio: "pipe", timeout: 8000 }
      );
    } catch { /* no listener */ }
    // Wait for the port to actually be free.
    try {
      for (let i = 0; i < 10; i++) {
        const r = execSync(
          `powershell -NoProfile -Command "[bool](Get-NetTCPConnection -LocalPort ${port} -EA SilentlyContinue)"`,
          { stdio: "pipe", encoding: "utf-8", timeout: 5000 }
        );
        if (r.trim().toLowerCase() !== "true") break;
        execSync("powershell -NoProfile -Command Start-Sleep -Milliseconds 500", { stdio: "pipe" });
      }
    } catch { /* port check failed, assume free */ }
  } else {
    try { execSync(`fuser -k ${port}/tcp 2>/dev/null || lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: "pipe", timeout: 5000 }); } catch {}
  }
}

async function restartDetached(): Promise<void> {
  if (process.platform === "win32") {
    stopWindowsTask("BrowserPowers");
  }
  killServerOnPort(config.port);
  await startDetached();
}

async function stopDetached(): Promise<void> {
  if (process.platform === "win32") {
    stopWindowsTask("BrowserPowers");
  }
  killServerOnPort(config.port);
  // Wait for port to actually free.
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (!(await isPortBusy(config.port))) {
      console.log("BrowserPowers stopped.");
      process.exit(0);
    }
  }
  console.log("BrowserPowers stop signal sent.");
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "serve";

  if (mode === "cli") {
    runCli(args.slice(1));
    return;
  }
  if (mode === "start") {
    await startDetached();
    return;
  }
  if (mode === "restart") {
    await restartDetached();
    return;
  }
  if (mode === "stop") {
    await stopDetached();
    return;
  }
  if (mode !== "serve" && args.length > 0) {
    runCli(args);
    return;
  }

  // ── Server mode ──

  // Write daemon PID file if one was requested (used by the daemon/scheduled task)
  const pidFlagIndex = args.indexOf("--pid-file");
  if (pidFlagIndex !== -1 && args[pidFlagIndex + 1]) {
    try {
      writeFileSync(args[pidFlagIndex + 1], String(process.pid), "utf-8");
    } catch { /* ignore — non-critical */ }
  }

  console.log(`
  ╔══════════════════════════════════════╗
  ║       🔥 BrowserPowers Core          ║
  ║       Multi-Browser Agent Server     ║
  ╚══════════════════════════════════════╝
  `);

  const app = createApp();

  // Create raw Node HTTP server so we can share it with WebSocket
  const httpServer = createServer(async (req, res) => {
    // Node's IncomingMessage IS a ReadableStream at runtime — cast for TS
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = hasBody ? req as unknown as ReadableStream<Uint8Array> : undefined;

    const honoReq = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body,
      duplex: hasBody ? "half" : undefined,
    } as RequestInit);

    const honoRes = await app.fetch(honoReq);

    // Copy Hono response to Node response
    res.statusCode = honoRes.status;
    honoRes.headers.forEach((value, key) => res.setHeader(key, value));

    if (honoRes.body) {
      const reader = honoRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            break;
          }
          res.write(value);
        }
      };
      pump().catch((err) => {
        console.error("[http] Stream error:", err);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
    } else {
      res.end();
    }
  });

  // Attach WebSocket server to same HTTP server
  createWsServer(httpServer);

  // Start
  httpServer.listen(config.port, config.host, () => {
    console.log(`
  ┌──────────────────────────────────────┐
  │  Server listening:                   │
  │    HTTP:  http://${config.host}:${config.port}${config.rest.path.padEnd(4)} │
  │    MCP:   http://${config.host}:${config.port}${config.mcp.path.padEnd(4)} │
  │    WS:    ws://${config.host}:${config.port}${config.ws.path.padEnd(4)} │
  │                                      │
  │  Ready for browser connections...    │
  └──────────────────────────────────────┘
  `);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[core] Shutting down...");

    // Clean up PID file
    if (pidFlagIndex !== -1 && args[pidFlagIndex + 1]) {
      try { unlinkSync(args[pidFlagIndex + 1]); } catch { /* ignore */ }
    }

    // Reject all pending requests so callers don't hang forever
    const allBrowsers = registry.list();
    for (const browser of allBrowsers) {
      registry.rejectAllForBrowser(browser.id, new Error("Server shutting down"));
    }

    // Clean up temp screenshot files
    await cleanupTempScreenshots();

    // Close HTTP server (stops accepting new connections, drains existing ones)
    httpServer.close(() => {
      console.log("[core] HTTP server closed");
    });

    // Give in-flight work a moment, then exit
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[core] Fatal error:", err);
  process.exit(1);
});
