#!/usr/bin/env node
/**
 * Minimal eval harness (lite port of BrowserSkill evals/browser).
 * Commands: validate | list | coverage | smoke
 * - validate/list/coverage: no browser needed.
 * - smoke: needs daemon + connected browser (REST 127.0.0.1:4199). Honest
 *   passed vs unverified (no browser = unverified, never fake-pass).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "cases");
const cmd = process.argv[2] || "validate";
const filterCase = (process.argv.find((a) => a.startsWith("--case=")) || "").slice(7);

function loadCases() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".case.json")) {
        try { out.push({ file: p, manifest: JSON.parse(readFileSync(p, "utf-8")) }); }
        catch (err) { console.error(`❌ ${p}: ${err.message}`); process.exitCode = 1; }
      }
    }
  };
  walk(root);
  return out.sort((a, b) => String(a.manifest.id).localeCompare(String(b.manifest.id)));
}

const KNOWN_OPS = new Set(["tabs.navigate","tabs.list","page.read.inspect","page.read.readable","page.act.fill","screenshots.capture","tabs.create"]);

if (cmd === "validate") {
  const cases = loadCases();
  const ids = new Set();
  let bad = 0;
  for (const { file, manifest: m } of cases) {
    if (!m.id || !m.title || !m.suite || !m.smoke?.steps) { console.error(`❌ ${file}: missing id/title/suite/smoke.steps`); bad++; continue; }
    if (ids.has(m.id)) { console.error(`❌ duplicate id ${m.id}`); bad++; }
    ids.add(m.id);
    for (const op of m.coverage || []) if (!KNOWN_OPS.has(op)) console.warn(`⚠️ ${m.id}: unknown coverage op ${op}`);
  }
  console.log(bad === 0 ? `✅ ${cases.length} cases valid` : `❌ ${bad} problems`);
  process.exitCode = bad === 0 ? 0 : 1;
} else if (cmd === "list") {
  for (const { manifest: m } of loadCases()) {
    if (filterCase && m.id !== filterCase) continue;
    console.log(`- ${m.id} [${m.suite}] ${m.title}`);
  }
} else if (cmd === "coverage") {
  const ops = new Map();
  for (const { manifest: m } of loadCases()) for (const op of m.coverage || []) ops.set(op, (ops.get(op) || 0) + 1);
  console.log("# Operation coverage (capability count, not case count)");
  for (const [op, n] of [...ops.entries()].sort()) console.log(`- ${op}: ${n} case(s)`);
} else if (cmd === "smoke") {
  const { createServer } = await import("node:http");
  // Localhost fixture server: content scripts never inject into data: URLs,
  // so {fixture} placeholders in case steps resolve to this http origin.
  const FORM_HTML = `<!doctype html><html><head><title>Eval fixture</title></head><body><form><input id="t" placeholder="Name"><button>Save</button></form></body></html>`;
  const fixtures = createServer((req, res) => {
    if (req.url === "/form.html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(FORM_HTML); }
    else { res.writeHead(404); res.end("nope"); }
  });
  await new Promise((resolve) => fixtures.listen(0, "127.0.0.1", resolve));
  const fixtureBase = `http://127.0.0.1:${fixtures.address().port}`;
  const sub = (v) => typeof v === "string" ? v.replaceAll("{fixture}", fixtureBase) : v;
  const base = process.env.BP_BASE || "http://127.0.0.1:4199/api";
  const browserName = process.env.BP_BROWSER || "";
  const cases = loadCases().filter(({ manifest: m }) => !filterCase || m.id === filterCase);
  const api = async (path, init) => {
    const headers = { "Content-Type": "application/json", ...(process.env.BP_API_KEY ? { Authorization: `Bearer ${process.env.BP_API_KEY}` } : {}) };
    const res = await fetch(`${base}${path}`, { ...init, headers });
    return res.json();
  };
  const { browsers } = await api("/browsers").catch(() => ({ browsers: [] }));
  if (!browsers?.length) { console.log("⚠️ unverified: 0 browsers connected — start daemon + load extension, then re-run"); process.exit(0); }
  const browser = browserName ? browsers.find((b) => b.name === browserName || b.id === browserName) || browsers[0] : browsers[0];
  console.log(`Browser: ${browser.name} (${browser.id})`);
  let pass = 0, fail = 0;
  for (const { manifest: m } of cases) {
    try {
      for (const step of m.smoke.steps) {
        if (step.action === "navigate") await api(`/browsers/${browser.id}/execute`, { method: "POST", body: JSON.stringify({ tool: "tabs.navigate", params: { url: sub(step.url) } }) });
        else if (step.action === "inspect") await api(`/browsers/${browser.id}/execute`, { method: "POST", body: JSON.stringify({ tool: "page.read", params: { action: "inspect", limit: 10, compact: true } }) });
        else if (step.action === "fill") await api(`/browsers/${browser.id}/execute`, { method: "POST", body: JSON.stringify({ tool: "page.act", params: { action: "fill", target: step.target, value: step.value } }) });
        else if (step.action === "tabs_list") await api(`/browsers/${browser.id}/execute`, { method: "POST", body: JSON.stringify({ tool: "tabs.list", params: {} }) });
        else if (step.action === "screenshot") await api(`/browsers/${browser.id}/execute`, { method: "POST", body: JSON.stringify({ tool: "screenshots.capture", params: {} }) });
        else if (step.action === "readable") await api(`/browsers/${browser.id}/execute`, { method: "POST", body: JSON.stringify({ tool: "page.read", params: { action: "readable" } }) });
      }
      console.log(`✅ ${m.id}: passed`); pass++;
    } catch (err) { console.log(`❌ ${m.id}: ${err.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed, 0 unverified (browser present)`);
  fixtures.close();
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  console.error(`Unknown command ${cmd}. Use validate|list|coverage|smoke [--case=id]`);
  process.exitCode = 1;
}
