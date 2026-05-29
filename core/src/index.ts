import { createServer } from "node:http";
import type { Server } from "node:http";
import { writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
 *   `browserpowers serve`  — start the full server (HTTP + WS + MCP)
 *   `browserpowers cli`    — run a CLI command (list, navigate, screenshot, etc.)
 *   (no args)              — default to serve mode
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "serve";

  // CLI mode: user typed `browserpowers <command>` directly
  // `browserpowers cli <command>` — strip "cli" prefix
  // `browserpowers <command>` — pass all args straight to Commander
  if (mode === "cli") {
    runCli(args.slice(1));
    return;
  }
  if (args.length > 0 && !["serve", "start"].includes(mode)) {
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
