/**
 * FILE: manual-tests/run-all.mjs
 * PURPOSE: Run every manual test in sequence. Prints a summary.
 *          Each test is a standalone .mjs file; we spawn them so
 *          their output streams independently and a failure in one
 *          doesn't poison the others.
 *
 *          Usage:
 *            node manual-tests/run-all.mjs
 *            pnpm test:manual
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";

function listTests() {
  return readdirSync(__dirname)
    .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
    .map((f) => join(__dirname, f))
    .filter((f) => statSync(f).isFile())
    .sort();
}

function runOne(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("close", (code) => resolve({ script, code: code ?? 1 }));
  });
}

async function main() {
  const tests = listTests();
  console.log(`${BOLD}Manual test suite — ${tests.length} tests against the real connected browser${RESET}\n`);

  const results = [];
  for (const t of tests) {
    const name = t.split(/[\\/]/).pop();
    console.log(`\n${BOLD}── ${name} ─────────────────────────${RESET}`);
    const r = await runOne(t);
    results.push({ name, code: r.code });
  }

  const passed = results.filter((r) => r.code === 0).length;
  const failed = results.length - passed;
  console.log(`\n${BOLD}── Summary ─────────────────────────${RESET}`);
  for (const r of results) {
    const icon = r.code === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${r.name}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed of ${results.length} total`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}runner crashed: ${err.message}${RESET}`);
  if (err.stack) console.error(DIM + err.stack + RESET);
  process.exit(2);
});
