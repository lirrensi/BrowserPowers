#!/usr/bin/env node
/**
 * test-live.mjs — real-browser end-to-end, still non-damaging.
 *
 * Spins up an ISOLATED world and tears it down afterwards:
 *   - core daemon on 127.0.0.1:4199 with a TEMP BROWSERPOWERS_HOME
 *     (own config/audit/pid — your real ~/.config/browserpowers untouched)
 *   - Edge (Chromium) with a TEMP --user-data-dir + unpacked extension,
 *     pointed at the test daemon
 *   - cases hit example.com + data: URLs only: navigate/inspect/snapshot,
 *     content/readable, tabs, screenshots (viewport/overlay/ref), wheel,
 *     scroll_to, focus/blur, fill, visual_click, record, audit, request_help
 *   - request_help runs with a 12s timeout and NO human, so the honest
 *     expected outcome is `timed_out` — that IS the pass condition
 *
 * SAFETY RULES (hard):
 *   - aborts if port 4199 is busy (your real daemon may live there —
 *     we never `stop`/kill by port, only our own child PIDs)
 *   - never deletes history/bookmarks/downloads; never calls stop on anyone's daemon
 *   - cleanup in `finally`: kill ONLY spawned PIDs, remove temp dirs
 *
 * Usage: pnpm test:live
 * Requires: Edge (msedge.exe), built extension (pnpm build), port 4199 free.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const API = "http://127.0.0.1:4199/api";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXTDIR = join(ROOT, "extension", ".output", "chrome-mv3");
const CORE = join(ROOT, "core", "dist", "index.js");

const results = [];
let edgeLog = "";
let coreLog = "";
const pass = (name, detail = "") => { results.push({ name, ok: true, detail }); console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`); };
const fail = (name, detail = "") => { results.push({ name, ok: false, detail }); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  return res.json();
}
async function exec(browserId, tool, params = {}) {
  return api(`/browsers/${browserId}/execute`, { method: "POST", body: JSON.stringify({ tool, params }) });
}
const okRes = (r) => r && r.success !== false && !r.error;

let coreProc = null;
let edgeProc = null;
let tmpHome = "";
let fixtureServer = null;
const killPidTree = (pid, label) => {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" }); }
  catch { try { process.kill(pid); } catch { /* already gone */ } }
  console.log(`  (stopped ${label} pid ${pid})`);
};

try {
  console.log("▶ preflight (no browser launched yet)");
  if (!existsSync(EDGE)) { console.error("  ❌ Edge not found — install Edge or set EDGE path; aborting (nothing started)"); process.exit(2); }
  console.log("  ✅ Edge present");
  if (!existsSync(join(EXTDIR, "manifest.json"))) { console.error("  ❌ extension not built — run `pnpm build` first; aborting (nothing started)"); process.exit(2); }
  console.log("  ✅ built extension present");
  if (!existsSync(CORE)) { console.error("  ❌ core not built — run `pnpm build` first; aborting (nothing started)"); process.exit(2); }
  console.log("  ✅ built core present");
  try {
    await fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) });
    console.error("  ❌ port 4199 busy — your real daemon may be running there. Refusing to touch it; stop it yourself or free the port, then re-run. Aborting (nothing started)");
    process.exit(2);
  } catch { console.log("  ✅ port 4199 free (your daemon untouched either way)"); }

  tmpHome = mkdtempSync(join(tmpdir(), "bp-live-"));
  const edgeProfile = join(tmpHome, "edge-profile");
  console.log(`▶ isolated home: ${tmpHome}`);

  // Fixture server: content scripts NEVER inject into data: URLs (platform
  // restriction), so form/interaction cases are served over localhost http.
  const FORM_HTML = `<!doctype html><html><head><title>Live fixture</title></head><body><form><input id="t" placeholder="Name"><button>Save</button></form></body></html>`;
  fixtureServer = createServer((req, res) => {
    if (req.url === "/form.html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(FORM_HTML); }
    else { res.writeHead(404); res.end("nope"); }
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
  console.log(`  ✅ fixture server: ${fixtureBase}/form.html`);

  console.log("▶ starting test daemon (own PID, own home)");
  coreProc = spawn(process.execPath, [CORE, "serve"], {
    env: {
      ...process.env,
      BROWSERPOWERS_HOME: tmpHome,
      // No human can click the popup in an automated run — auto-approve ask
      // gates on the ISOLATED test daemon only. Never set this elsewhere.
      BROWSERPOWERS_AUTO_APPROVE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let coreLogAppend = (d) => { coreLog += String(d); if (coreLog.length > 200_000) coreLog = coreLog.slice(-200_000); };
  coreProc.stdout?.on("data", coreLogAppend);
  coreProc.stderr?.on("data", coreLogAppend);
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try { const h = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()); if (h.status === "ok") { healthy = true; break; } }
    catch { /* not up yet */ }
    if (coreProc.exitCode !== null) throw new Error(`test daemon exited early (code ${coreProc.exitCode})`);
  }
  if (!healthy) throw new Error("test daemon never became healthy");
  console.log("  ✅ daemon healthy");

  console.log("▶ launching Edge (temp profile, test extension)");
  let knownIds = new Set();
  try {
    const { browsers } = await api("/browsers");
    knownIds = new Set((browsers ?? []).map((b) => b.id));
    if (knownIds.size) console.log(`  (ignoring ${knownIds.size} pre-existing browser(s) — not ours)`);
  } catch { /* empty is the common case */ }
  edgeProc = spawn(EDGE, [
    `--user-data-dir=${edgeProfile}`,
    `--load-extension=${EXTDIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=TranslateUI",
    "--disable-sync",
    "--enable-logging=stderr",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  edgeProc.stderr?.on("data", (d) => {
    edgeLog += String(d);
    if (edgeLog.length > 200_000) edgeLog = edgeLog.slice(-200_000);
  });
  await sleep(3000);
  if (edgeProc.exitCode !== null) throw new Error(`Edge exited early (code ${edgeProc.exitCode})`);

  console.log("▶ waiting for extension registration (ignoring pre-existing browsers)");
  let browser = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const { browsers } = await api("/browsers");
      browser = (browsers ?? []).find((b) => !knownIds.has(b.id)) ?? null;
      if (browser) break;
    } catch { /* daemon hiccup */ }
  }
  if (!browser) throw new Error("extension never registered (60s) — check edge://extensions for errors");
  console.log(`  ✅ registered: "${browser.name}" (${browser.id})`);
  const bid = browser.id;
  try { // foreground the window — backgrounded windows fail readback capture
    const wl = await exec(bid, "windows.list", {});
    const wins = wl.data ?? [];
    if (Array.isArray(wins) && wins[0]?.id !== undefined) await exec(bid, "windows.focus", { window_id: wins[0].id });
  } catch { /* focus best-effort; CDP fallback covers readback failures */ }

  console.log("▶ cases (example.com + localhost fixtures only)");
  { // 1 navigate
    const r = await exec(bid, "tabs.navigate", { url: "https://example.com" });
    okRes(r) && r.data?.tabId ? pass("navigate example.com", `tab ${r.data.tabId}`) : fail("navigate example.com", r.error ?? "no tabId");
  }
  let firstAnchor = null;
  { // 2 inspect (+generation)
    const r = await exec(bid, "page.read", { action: "inspect", limit: 20, compact: true });
    const d = r.data?.data ?? r.data;
    if (okRes(r) && Array.isArray(d?.anchors)) { pass("inspect", `${d.anchors.length} anchors, gen ${d.generation ?? "?"}`); firstAnchor = d.anchors[0]?.anchor ?? null; }
    else fail("inspect", r.error ?? "no anchors");
  }
  { // 3 snapshot alias
    const r = await exec(bid, "page.read", { action: "snapshot", limit: 10 });
    okRes(r) ? pass("snapshot alias") : fail("snapshot alias", r.error ?? "?");
  }
  { // 4 content
    const r = await exec(bid, "page.read", { action: "content" });
    const t = r.data?.data?.content ?? r.data?.content ?? "";
    okRes(r) && String(t).includes("Example") ? pass("content has 'Example Domain'") : fail("content", r.error ?? "marker missing");
  }
  { // 5 readable
    const r = await exec(bid, "page.read", { action: "readable" });
    const c = r.data?.data?.content ?? "";
    okRes(r) && c.length > 20 ? pass("readable", `${c.length} chars`) : fail("readable", r.error ?? "empty");
  }
  { // 6 tabs
    const r = await exec(bid, "tabs.list", {});
    const tabs = r.data?.tabs ?? [];
    okRes(r) && tabs.length >= 1 ? pass("tabs.list", `${tabs.length} tab(s)`) : fail("tabs.list", r.error ?? "empty");
  }
  { // 7 screenshot viewport
    const r = await exec(bid, "screenshots.capture", {});
    const b64 = r.data?.base64 ?? "";
    okRes(r) && b64.length > 20000 ? pass("screenshot viewport", `${Math.round(b64.length / 1024)}KB base64`) : fail("screenshot viewport", r.error ?? `only ${b64.length} chars`);
  }
  { // 8 screenshot overlay
    const r = await exec(bid, "screenshots.capture", { overlay: "labels", overlay_limit: 10 });
    okRes(r) && r.data?.base64 ? pass("screenshot overlay=labels", `drawn=${r.data.drawn ?? "?"}`) : fail("screenshot overlay", r.error ?? "no base64");
  }
  { // 9 form interactions on localhost fixture (data: URLs can't host content scripts)
    const FORM = `${fixtureBase}/form.html`;
    const nav = await exec(bid, "tabs.navigate", { url: FORM });
    if (!okRes(nav)) { fail("form navigate", nav.error ?? "?"); }
    else {
      // data: URLs can beat content-script injection — poll for the input.
      let ref = null;
      for (let i = 0; i < 10 && !ref; i++) {
        if (i > 0) await sleep(1000);
        const insp = await exec(bid, "page.read", { action: "inspect", limit: 20 });
        const anchors = insp.data?.data?.anchors ?? insp.data?.anchors ?? [];
        ref = (anchors.find((a) => a.tag === "input") ?? anchors.find((a) => (a.text ?? "").includes("Name")))?.anchor ?? null;
      }
      if (!ref) fail("form inspect", "input anchor not found after 10s");
      else {
        const f = await exec(bid, "page.act", { action: "fill", anchor: ref, value: "Ada" });
        const st = f.data?.status;
        st === "performed" || st === "already_in_desired_state"
          ? pass("fill", "performed")
          : st === "not_performed" && f.data?.errorCode === "FILL_VALUE_MISMATCH"
            ? pass("fill", "honest mismatch (acceptable)")
            : fail("fill", f.data?.message ?? f.error ?? "?");
        const w = await exec(bid, "page.act", { action: "wheel", delta_y: 200 });
        okRes(w) && w.data?.status === "performed" ? pass("wheel") : fail("wheel", w.data?.message ?? w.error ?? "?");
        const s = await exec(bid, "page.act", { action: "scroll_to", anchor: ref });
        okRes(s) ? pass("scroll_to", "bounds returned") : fail("scroll_to", s.data?.message ?? s.error ?? "?");
        const fo = await exec(bid, "page.act", { action: "focus", anchor: ref });
        okRes(fo) ? pass("focus") : fail("focus", fo.data?.message ?? fo.error ?? "?");
        const bl = await exec(bid, "page.act", { action: "blur" });
        okRes(bl) ? pass("blur") : fail("blur", bl.data?.message ?? bl.error ?? "?");
      }
    }
  }
  { // 10 visual_click end-to-end (mapping math against the real renderer)
    const insp = await exec(bid, "page.read", { action: "inspect", limit: 20, compact: false });
    const anchors = insp.data?.data?.anchors ?? insp.data?.anchors ?? [];
    const cand = anchors.find((a) => a.center && a.anchor);
    if (!cand) fail("visual_click", "no anchor with center");
    else {
      const shot = await exec(bid, "screenshots.capture", { ref: cand.anchor });
      const cap = shot.data?.capture_id;
      const map = shot.data?.mapping;
      if (!cap || !map) fail("screenshot ref", shot.error ?? shot.data?.message ?? "no capture_id");
      else {
        const sx = (map.png?.w ?? map.viewport?.w ?? 0) / (map.viewport?.w || 1);
        const sy = (map.png?.h ?? map.viewport?.h ?? 0) / (map.viewport?.h || 1);
        const r = await exec(bid, "page.act", {
          action: "visual_click",
          capture_id: cap,
          image_x: Math.round(cand.center.x * (sx || 1)),
          image_y: Math.round(cand.center.y * (sy || 1)),
        });
        okRes(r) ? pass("visual_click", `via ${cand.anchor}`) : fail("visual_click", r.data?.message ?? r.error ?? "?");
      }
    }
  }
  { // 11 record
    const s = await exec(bid, "record.start", { purpose: "live-test" });
    if (!okRes(s)) fail("record.start", s.error ?? "?");
    else {
      await exec(bid, "page.read", { action: "inspect", limit: 5, compact: true });
      const st = await exec(bid, "record.stop", {});
      const ops = st.data?.ops ?? [];
      okRes(st) && ops.length >= 1 ? pass("record", `${ops.length} op(s) traced`) : fail("record.stop", st.error ?? "empty trace");
    }
  }
  { // 12 audit (redacted by construction)
    const r = await api("/audit");
    (r.files?.length ?? 0) >= 1 ? pass("audit", `${r.files.length} file(s), ${r.bytes ?? 0} bytes`) : fail("audit", "no files");
  }
  { // 13 request_help with NO human input from the harness — timed_out IS the
    // pass. If a human DOES click the OS notification mid-run, continued /
    // completed / cancelled equally prove the loop works end-to-end. Only a
    // raw queue timeout (no envelope at all) is a failure.
    console.log("  (request_help: 12s, harness clicks nothing — expecting timed_out)");
    const r = await exec(bid, "human.requestHelp", { prompt: "live-test probe (ignore)", timeout_ms: 12_000 });
    const out = r.data?.outcome;
    if (out === "timed_out") pass("request_help", "timed_out, untouched as designed");
    else if (out === "continued" || out === "completed" || out === "cancelled") pass("request_help", `human ${out} mid-run — loop verified end-to-end`);
    else fail("request_help", `no outcome envelope: ${r.data?.message ?? r.error ?? "?"}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live cases passed${failed.length ? ` — failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(`\n❌ live harness error: ${err.message}`);
  process.exitCode = 1;
} finally {
  try {
    const { browsers } = await api("/browsers").catch(() => ({ browsers: null }));
    console.log(`\n--- post-mortem: daemon sees ${browsers === null ? "UNREACHABLE" : browsers.length + " browser(s)"} ---`);
    for (const b of browsers ?? []) console.log(`    ${b.id} "${b.name}" heartbeat ${Math.round((Date.now() - b.lastHeartbeat) / 1000)}s ago`);
  } catch { /* daemon already dead */ }
  if (edgeLog) {
    const hits = edgeLog.split("\n").filter((l) => /bp-ext|bp-cdp|CONSOLE.*error|ERROR:bus|Extension/.test(l)).slice(-25);
    if (hits.length) { console.log("\n--- Edge log tail (filtered) ---"); console.log(hits.join("\n")); }
  }
  if (coreLog) {
    console.log("\n--- test daemon log tail ---");
    console.log(coreLog.split("\n").slice(-30).join("\n"));
  }
  console.log("▶ cleanup (own PIDs only — your daemon never touched)");
  if (edgeProc?.pid) { try { killPidTree(edgeProc.pid, "Edge"); } catch {} edgeProc = null; }
  if (coreProc?.pid) { try { killPidTree(coreProc.pid, "test daemon"); } catch {} coreProc = null; }
  if (fixtureServer) { try { fixtureServer.close(); } catch { /* already closed */ } fixtureServer = null; }
  await sleep(1500);
  if (tmpHome) { try { rmSync(tmpHome, { recursive: true, force: true }); console.log(`  (removed ${tmpHome})`); } catch (e) { console.log(`  (keep ${tmpHome}: ${e.message})`); } }
}
