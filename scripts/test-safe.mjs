#!/usr/bin/env node
/**
 * test-safe.mjs — the non-damaging test suit.
 *
 * Runs everything that needs NO browser, NO network, NO filesystem writes
 * outside mocks/temp:
 *   1. vitest core (mocked fs/ws — proves gates, audit redaction, MCP tools)
 *   2. vitest extension (mocked chrome.* — proves routers, anchor generations)
 *   3. evals validate (static manifest check — proves cases are well-formed)
 *   4. static guards: skill documents the CLI; eval smoke cases contain no
 *      destructive actions (nothing that deletes history/bookmarks/downloads)
 *
 * Needs a browser: `pnpm eval:smoke`, `pnpm test:manual`, `pnpm smoke`.
 * Those only touch example.com + data: URLs and never delete anything —
 * see docs/testing.md.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const step = (name) => process.stdout.write(`\n▶ ${name}...\n`);
const ok = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.error(`  ❌ ${msg}`); failures++; };
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, shell: true, stdio: "pipe", encoding: "utf-8" });

step("1/4 unit + integration (mocked, no browser)");
{
  const r = run("pnpm", ["test:core"]);
  if (r.status === 0) ok("core: gates, audit redaction, MCP tools, registry");
  else { fail("core tests failed"); process.stdout.write((r.stdout || "").slice(-2000)); }
}
{
  const r = run("pnpm", ["test:ext"]);
  if (r.status === 0) ok("extension: routers, anchors, generations");
  else { fail("extension tests failed"); process.stdout.write((r.stdout || "").slice(-2000)); }
}

step("2/4 eval manifests valid (no browser)");
{
  const r = run("node", ["evals/browser/cli.mjs", "validate"]);
  if (r.status === 0) ok((r.stdout || "").trim().split("\n").pop());
  else { fail("eval validate failed"); process.stdout.write(r.stdout || ""); }
}

step("3/4 skill documents MCP + CLI");
{
  const p = join(root, "skill", "browserpowers", "SKILL.md");
  if (!existsSync(p)) fail("skill/browserpowers/SKILL.md missing");
  else {
    const s = readFileSync(p, "utf-8");
    const need = ["browserpowers list", "browserpowers screenshot", "page read", "page act", "request-help", "doctor", "audit list"];
    const missing = need.filter((n) => !s.includes(n));
    if (missing.length === 0) ok(`skill covers CLI (${need.length} probes found)`);
    else fail(`skill missing CLI docs: ${missing.join(", ")}`);
  }
}

step("4/4 eval smoke cases are non-destructive (static scan)");
{
  const banned = ["delete_all", "history.delete", "bookmarks.delete", "downloads.open", "removeTree"];
  const cases = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".case.json")) cases.push(p);
    }
  };
  walk(join(root, "evals", "browser", "cases"));
  const hits = [];
  for (const c of cases) {
    const s = readFileSync(c, "utf-8");
    for (const b of banned) if (s.includes(b)) hits.push(`${c.split("cases")[1]} contains ${b}`);
  }
  if (hits.length === 0) ok(`${cases.length} cases scanned — read-only (navigate/inspect/fill localhost fixture/screenshot)`);
  else fail(hits.join("\n"));
}

console.log(failures === 0 ? "\n✅ test:safe green — nothing touched a browser, nothing deleted.\n" : `\n❌ test:safe: ${failures} failing group(s).\n`);
process.exit(failures === 0 ? 0 : 1);
