import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { findBrowser, executeTool, navigate, waitForContentScript, expect } from "./lib/browser.mjs";

const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const banner = (s) => console.log(`\n\x1b[1m=== ${s} ===\x1b[0m`);
const ok = (s) => console.log(`${GREEN}✓${RESET} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));

// (WS framing is handled by the `ws` package — same dep the core uses.)
async function main() {
  banner("page.net fixture — local WS echo + HTTP server");
  const browser = await findBrowser();
  console.log(`Browser: ${browser.id} "${browser.name}"`);

  // ── Fixture server ──
  const FIXTURE = readFileSync(join(HERE, "test-pages", "ws-echo.html"), "utf8");
  const server = createServer((req, res) => {
    if (req.url === "/ws-echo.html" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(FIXTURE);
      return;
    }
    if (req.url.startsWith("/api/echo")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("echo-ok probe=" + req.url);
      return;
    }
    res.writeHead(404); res.end("nope");
  });
  // WS echo on /ws-echo via the `ws` package (same dep the core uses).
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send("echo:" + data.toString()));
  });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/ws-echo")) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`Fixture: ${base}/ws-echo.html`);
  // NOTE: fixture binds 127.0.0.1; Chrome resolves `localhost` → ::1 first,
  // so the page MUST use the 127.0.0.1 base (not location.host if the test
  // ever navigates via localhost) or the WS handshake never reaches us.
  try {
    banner("navigate + wait for socket");
    await navigate(browser.id, `${base}/ws-echo.html`);
    await waitForContentScript(browser.id);
    // Auto-open fires on load; give the handshake a beat.
    await sleep(2500);

    banner("ws_list sees the hooked socket");
    let hookId = null;
    for (let i = 0; i < 6 && !hookId; i++) {
      const r = await executeTool(browser.id, "page.net", { action: "ws_list" });
      const d = r.data?.data ?? r.data ?? {};
      const hooks = d.hooks ?? [];
      console.log(`  poll ${i + 1}: ${hooks.length} hook(s)${hooks.length ? " — " + hooks.map((h) => h.url).join(", ") : ""}`);
      hookId = hooks.find((h) => (h.url || "").includes("/ws-echo"))?.hookId ?? hooks[0]?.hookId ?? null;
      if (!hookId) await sleep(1500);
    }
    expect(!!hookId, true, "ws_list reports the /ws-echo socket");
    ok(`hooked socket: ${hookId}`);

    banner("ws_tail shows page-sent frames");
    await executeTool(browser.id, "page.act", { action: "click", target: { text: "Send ping" } }).catch(() => ({}));
    await sleep(1500);
    {
      const r = await executeTool(browser.id, "page.net", { action: "ws_tail", hook_id: hookId, limit: 20 });
      const d = r.data?.data ?? r.data ?? {};
      const frames = d.frames ?? [];
      const texts = frames.map((f) => `${f.dir}:${f.data}`);
      console.log("  frames: " + JSON.stringify(texts.slice(-6)));
      expect(frames.some((f) => (f.data || "").includes("ping-from-page")), true, "outbound ping frame observed");
      expect(frames.some((f) => (f.data || "").includes("echo:")), true, "echo reply frame observed");
      ok(`${frames.length} frame(s) tailed`);
    }

    banner("ws_send injects from the outside");
    {
      const token = "bp-inject-" + Date.now();
      await executeTool(browser.id, "page.net", { action: "ws_send", hook_id: hookId, data: token });
      await sleep(1500);
      const r = await executeTool(browser.id, "page.net", { action: "ws_tail", hook_id: hookId, limit: 20 });
      const d = r.data?.data ?? r.data ?? {};
      const texts = (d.frames ?? []).map((f) => f.data || "");
      expect(texts.some((t) => t.includes(token)), true, "injected token echoed back");
      ok(`round-trip: ${token} → echo:${token}`);
    }

    banner("http_observe logs fixture fetches");
    {
      await executeTool(browser.id, "page.act", { action: "click", target: { text: "Fetch /api/echo" } }).catch(() => ({}));
      await sleep(1500);
      const r = await executeTool(browser.id, "page.net", { action: "http_observe", pattern: "/api/echo" });
      const d = r.data?.data ?? r.data ?? {};
      expect((d.matchCount ?? 0) >= 1, true, "at least one /api/echo fetch logged");
      ok(`${d.matchCount} match(es): ${(d.matches ?? []).map((m) => `${m.method} ${m.status}`).join(", ")}`);
    }

    banner("http_block 403s, http_unblock restores");
    {
      const b = await executeTool(browser.id, "page.net", { action: "http_block", pattern: "/api/echo" });
      const bd = b.data?.data ?? b.data ?? {};
      const ruleId = bd.rule?.id;
      expect(!!ruleId, true, "block rule created");
      const probe = await executeTool(browser.id, "page.js", { code: `fetch("/api/echo?probe=block").then(r=>"status:"+r.status).catch(e=>"err:"+e.message)` });
      const text = probe.data?.data?.result ?? probe.data?.result ?? JSON.stringify(probe);
      expect(String(text).includes("403"), true, `blocked fetch 403s (got ${String(text).slice(0, 60)})`);
      ok(`blocked → ${String(text).slice(0, 40)}`);
      await executeTool(browser.id, "page.net", { action: "http_unblock", id: ruleId });
      const probe2 = await executeTool(browser.id, "page.js", { code: `fetch("/api/echo?probe=after").then(r=>"status:"+r.status).catch(e=>"err:"+e.message)` });
      const text2 = probe2.data?.data?.result ?? probe2.data?.result ?? JSON.stringify(probe2);
      expect(String(text2).includes("200"), true, `unblocked fetch 200s (got ${String(text2).slice(0, 60)})`);
      ok(`unblocked → ${String(text2).slice(0, 40)}`);
    }

    console.log(`\n${GREEN}✓ PASS${RESET} — ws_list/tail/send + http_observe/block/unblock all live against the local fixture.`);
    process.exit(0);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(`\n${RED}✗ FAIL${RESET} — ${err.message}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(1);
});
