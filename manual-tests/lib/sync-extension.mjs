#!/usr/bin/env node
// FILE: manual-tests/lib/sync-extension.mjs
// PURPOSE: Build the extension, copy it to the live Chrome install dir
//          (~/.browserpowers/extension), then trigger a SW reload via
//          the `self.reload` capability. One command — the user
//          shouldn't have to remember to copy files between the build
//          output and the install dir.
//
//          The previous test cycle hit the "silent fallback" bug
//          because pnpm build only updates .output/chrome-mv3, but
//          Chrome loads from ~/.browserpowers/extension. This script
//          bridges the gap.

import { execSync } from "node:child_process";
import { existsSync, rmSync, cpSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { findBrowser, executeTool } from "./browser.mjs";

const REPO_DIR = process.cwd();
const BUILD_DIR = resolve(REPO_DIR, "extension", ".output", "chrome-mv3");
const INSTALL_DIR = resolve(homedir(), ".browserpowers", "extension");

const BOLD = "\x1b[1m", CYAN = "\x1b[36m", GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";

function step(msg) { console.log(`\n  ${BOLD}${msg}${RESET}`); console.log(`  ${"-".repeat(msg.length)}`); }
function run(cmd, cwd) {
  process.stdout.write(`  ${DIM}$ ${cmd}${RESET}\n`);
  return execSync(cmd, { stdio: "inherit", cwd: cwd ?? REPO_DIR, encoding: "utf-8" });
}

async function main() {
  step("1/4  Building extension");
  run("pnpm run build:chrome", resolve(REPO_DIR, "extension"));

  if (!existsSync(BUILD_DIR)) {
    throw new Error(`Build did not produce ${BUILD_DIR}`);
  }

  step("2/4  Copying to live install dir");
  // Atomic-ish swap. The extension dir is owned by the browser, so
  // rename-then-rm avoids the "directory in use" error on Windows.
  const backup = INSTALL_DIR + ".old";
  if (existsSync(backup)) {
    rmSync(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  if (existsSync(INSTALL_DIR)) {
    try {
      renameSync(INSTALL_DIR, backup);
    } catch {
      rmSync(INSTALL_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
  try {
    cpSync(BUILD_DIR, INSTALL_DIR, { recursive: true });
  } catch (err) {
    if (existsSync(backup)) {
      try { renameSync(backup, INSTALL_DIR); } catch {}
    }
    throw err;
  }
  if (existsSync(backup)) {
    rmSync(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log(`  ${GREEN}✓${RESET} ${INSTALL_DIR}`);

  step("3/4  Connecting to browser");
  const browser = await findBrowser();
  console.log(`  ${DIM}Browser: ${browser.id} "${browser.name}"${RESET}`);

  step("4/4  Triggering SW reload");
  const result = await executeTool(browser.id, "self.reload", { confirm: true });
  if (!result.success) {
    throw new Error(`self.reload failed: ${JSON.stringify(result)}`);
  }
  console.log(`  ${GREEN}✓${RESET} reload scheduled, delayMs=${result.data?.delayMs ?? "?"}`);
  console.log(`  ${DIM}wait ~2s for the new SW to attach, then run your tests.${RESET}`);
}

main().catch((err) => {
  console.error(`\n  ${BOLD}✖ sync-extension failed: ${err.message}${RESET}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
