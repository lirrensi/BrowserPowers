#!/usr/bin/env node

/**
 * BrowserPowers — One-shot install / update / uninstall.
 *
 * Copies everything to ~/.browserpowers/, installs dependencies,
 * builds the extension, puts CLI on PATH, starts daemon via PM2.
 *
 * Prerequisites (script checks these & tells you how to install):
 *   - Node.js >= 18
 *   - pnpm >= 9 (globally)
 *   - PM2 (globally)
 *   - tsx (globally)
 *
 * Usage:
 *   node scripts/install.mjs              fresh install or update
 *   node scripts/install.mjs --force      reinstall same version
 *   node scripts/install.mjs --uninstall  remove everything
 */

// ── Platform detection ──────────────────────────────────
// Must be first so all platform branches work downstream.

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const IS_LINUX = !IS_WIN && !IS_MAC;

// ── Imports ─────────────────────────────────────────────

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { resolve, relative, sep } from "node:path";

// ── Paths ───────────────────────────────────────────────

const REPO_DIR = process.cwd();
const BP_DIR = resolve(homedir(), ".browserpowers");
const BP_CORE = resolve(BP_DIR, "core");
const BP_EXT = resolve(BP_DIR, "extension");
const BP_BIN = resolve(BP_DIR, "bin");
const PKG_CORE = resolve(REPO_DIR, "core", "package.json");

// ── ANSI styling (minimal, safe) ────────────────────────

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function bold(s)    { return `${BOLD}${s}${RESET}`; }
function red(s)     { return `${RED}${s}${RESET}`; }
function green(s)   { return `${GREEN}${s}${RESET}`; }
function yellow(s)  { return `${YELLOW}${s}${RESET}`; }
function cyan(s)    { return `${CYAN}${s}${RESET}`; }

// ── Helpers ─────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function log(...args) {
  console.log(`  ${args.join(" ")}`);
}

function step(num, msg) {
  console.log(`\n  ${bold(`[${num}/7] ${msg}`)}`);
  console.log(`  ${"-".repeat(msg.length + 6)}`);
}

function fatal(message) {
  console.error(`\n  ${red("✖")} ${message}\n`);
  process.exit(1);
}

/**
 * Run a shell command, capturing output. Fails with a clear message on error.
 * The error does NOT exit the process — caller decides.
 */
function tryRun(cmd, opts = {}) {
  const cwd = opts.cwd || BP_DIR;
  log(`  $ ${cyan(cmd)}`);
  try {
    return execSync(cmd, { cwd, stdio: "pipe", timeout: 120000, encoding: "utf-8", ...opts });
  } catch (err) {
    const stderr = (err.stderr || "").toString().trim();
    const stdout = (err.stdout || "").toString().trim();
    return { error: true, message: stderr || stdout || err.message, stderr, stdout };
  }
}

function mustRun(cmd, opts = {}) {
  const result = tryRun(cmd, opts);
  if (result && result.error) {
    fatal(`Command failed: ${cmd}\n  ${result.message}`);
  }
  return result;
}

// ── Version comparison ──────────────────────────────────

function satisfiesVersion(actual, required) {
  const a = actual.split(".").map(Number);
  const r = required.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    const av = a[i] || 0;
    const rv = r[i] || 0;
    if (av > rv) return true;
    if (av < rv) return false;
  }
  return true;
}

// ── Platform helpers ────────────────────────────────────

/** Shell config file for PATH additions (macOS/Linux). */
function shellRc() {
  if (IS_MAC || IS_LINUX) {
    const shell = (process.env.SHELL || "").toLowerCase();
    if (shell.includes("zsh"))  return "~/.zshrc";
    if (shell.includes("bash")) return "~/.bashrc";
    return "~/.profile";
  }
  return null;
}

/** Platform-specific PATH instruction snippet. */
function pathInstructions() {
  if (IS_WIN) {
    return [
      `  ${bold("PowerShell:")}`,
      `    [Environment]::SetEnvironmentVariable("Path",`,
      `      "$env:USERPROFILE\\.browserpowers\\bin;$env:Path",`,
      `      "User")`,
      ``,
      `  ${bold("Or manually:")}`,
      `    System Properties → Advanced → Environment Variables → User PATH`,
      `    Add: ${BP_BIN}`,
    ].join("\n");
  }
  // macOS / Linux
  const rc = shellRc();
  return [
    `  Add to your ${bold(rc || "shell config")}:`,
    `    export PATH="\$PATH:${BP_BIN}"`,
    ``,
    `  Then reload:`,
    `    source ${rc || "~/.profile"}`,
  ].join("\n");
}

/** Binary name with platform-appropriate extension. */
function binName(base) {
  return IS_WIN ? `${base}.cmd` : base;
}

// ── Prerequisite checks ─────────────────────────────────
// ALL checks run first, collecting every failure.
// The user gets a complete shopping list, not a whack-a-mole.

function checkPrerequisites() {
  const failures = [];

  // ── 0. Running from repo root? ──
  if (!existsSync(PKG_CORE)) {
    fatal(`Run this script from the repo root.\n  Expected: ${PKG_CORE}`);
  }

  // ── 1. Node.js >= 18 ──
  const nodeVer = process.version.replace(/^v/, "");
  if (!satisfiesVersion(nodeVer, "18")) {
    failures.push({
      name: "Node.js >= 18",
      detail: `Found: v${nodeVer}`,
      install: IS_WIN
        ? "  Download from: https://nodejs.org/  (LTS recommended)"
        : "  Install via your package manager or nvm:\n" +
          "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash\n" +
          "    nvm install 22\n" +
          "    nvm use 22",
    });
  }

  // ── 2. pnpm >= 9 ──
  const pnpmResult = tryRun("pnpm --version", { cwd: REPO_DIR });
  if (pnpmResult && pnpmResult.error) {
    failures.push({
      name: "pnpm >= 9",
      detail: "Not found",
      install: IS_WIN
        ? "    npm install -g pnpm"
        : "    npm install -g pnpm\n" +
          "    or: curl -fsSL https://get.pnpm.io/install.sh | sh -",
    });
  } else {
    const pnpmVer = (pnpmResult || "").toString().trim();
    if (!satisfiesVersion(pnpmVer, "9")) {
      failures.push({
        name: "pnpm >= 9",
        detail: `Found: ${pnpmVer}`,
        install: "    npm install -g pnpm@latest",
      });
    }
  }

  // ── 3. PM2 ──
  const pm2Result = tryRun("pm2 --version", { cwd: REPO_DIR });
  if (pm2Result && pm2Result.error) {
    failures.push({
      name: "PM2",
      detail: "Not found — needed for daemon mode (auto-start on boot)",
      install: "    pnpm add -g pm2",
    });
  }

  // ── 4. tsx ──
  const tsxResult = tryRun("tsx --version", { cwd: REPO_DIR });
  if (tsxResult && tsxResult.error) {
    failures.push({
      name: "tsx",
      detail: "Not found — needed to run the CLI wrapper",
      install: "    pnpm add -g tsx",
    });
  }

  // ── Report ──
  if (failures.length > 0) {
    console.error(`\n  ${bold(red("✖ Prerequisites not met"))}`);
    console.error(`  ${"─".repeat(30)}\n`);
    for (const f of failures) {
      console.error(`  ${bold(f.name)}`);
      console.error(`    ${yellow(f.detail)}`);
      console.error(`    ${green("Install:")}`);
      console.error(`${f.install}`);
      console.error();
    }
    console.error(`  ${bold("Fix the above, then run the script again.")}\n`);
    process.exit(1);
  }

  log(`  ${green("All prerequisites satisfied.")}`);
}

// ── File copy filter ────────────────────────────────────
// Strips repo prefix using path.relative (cross-platform safe).

function copyFilter(src) {
  const rel = relative(REPO_DIR, src);
  if (rel.includes("node_modules")) return false;
  if (rel.includes(".output"))      return false;
  if (rel.includes("dist"))         return false;
  if (rel.endsWith("pnpm-lock.yaml")) return false;
  return true;
}

// ── Kill existing daemon ────────────────────────────────

function killDaemon() {
  try { execSync("pm2 delete browserpowers", { stdio: "pipe" }); } catch {
    // not running — fine
  }
}

// ── Create CLI wrappers ─────────────────────────────────
// Platform-appropriate wrappers so `browserpowers` works from any terminal.

function writeCliWrappers(tsxCli, coreEntry) {
  // ── Windows: .cmd batch file ──
  if (IS_WIN) {
    const cmdPath = resolve(BP_BIN, "browserpowers.cmd");
    const cmdContent = [
      `@echo off`,
      `node "${tsxCli}" "${coreEntry}" %*`,
    ].join("\r\n");
    writeFileSync(cmdPath, cmdContent, "utf-8");
    log(`  ${cmdPath}`);
  }

  // ── Windows: PowerShell wrapper (better for PS users) ──
  if (IS_WIN) {
    const psPath = resolve(BP_BIN, "browserpowers.ps1");
    const psContent = [
      `#!/usr/bin/env pwsh`,
      `$tsx = "${tsxCli.replace(/\\/g, "\\\\")}"`,
      `$entry = "${coreEntry.replace(/\\/g, "\\\\")}"`,
      `& node $tsx $entry @args`,
    ].join("\n");
    writeFileSync(psPath, psContent, "utf-8");
    log(`  ${psPath}`);
  }

  // ── Unix: shell script ──
  if (!IS_WIN) {
    const shPath = resolve(BP_BIN, "browserpowers");
    const shContent = [
      `#!/bin/sh`,
      `exec node "${tsxCli}" "${coreEntry}" "$@"`,
    ].join("\n");
    writeFileSync(shPath, shContent, "utf-8");
    chmodSync(shPath, 0o755);
    log(`  ${shPath}`);
  }

  // ── All platforms: Node.js .mjs wrapper ──
  // (used by the .cmd / .sh wrappers above, also runnable directly)
  const mjsPath = resolve(BP_BIN, "browserpowers.mjs");
  const mjsContent = [
    `#!/usr/bin/env node`,
    `import { spawn } from "node:child_process";`,
    `import { resolve, dirname } from "node:path";`,
    `import { fileURLToPath } from "node:url";`,
    `const __dirname = dirname(fileURLToPath(import.meta.url));`,
    `const coreDir = resolve(__dirname, "../core");`,
    `const tsxPath = resolve(coreDir, "node_modules/tsx/dist/cli.mjs");`,
    `const entryPath = resolve(coreDir, "src/index.ts");`,
    `const child = spawn(process.execPath, [tsxPath, entryPath, ...process.argv.slice(2)], { stdio: "inherit", cwd: coreDir });`,
    `child.on("exit", (code) => process.exit(code ?? 0));`,
    // SIGINT/SIGTERM forwarding — safe on all platforms
    `try { process.on("SIGINT", () => child.kill("SIGINT")); } catch {}`,
    `try { process.on("SIGTERM", () => child.kill("SIGTERM")); } catch {}`,
  ].join("\n");
  writeFileSync(mjsPath, mjsContent, "utf-8");
  // Make executable on Unix
  if (!IS_WIN) chmodSync(mjsPath, 0o755);
  log(`  ${mjsPath}`);
}

// ── Create PM2 ecosystem config ─────────────────────────

function writeEcosystemConfig() {
  const ecosystemPath = resolve(BP_DIR, "ecosystem.config.js");
  // Escape backslashes for JavaScript strings (Windows paths)
  const escapedCoreDir = BP_CORE.replace(/\\/g, "\\\\");
  const content = [
    "module.exports = {",
    "  apps: [{",
    "    name: 'browserpowers',",
    "    script: 'src/index.ts',",
    `    cwd: '${escapedCoreDir}',`,
    "    interpreter: 'node',",
    "    node_args: ['--import=tsx/esm'],",
    IS_WIN ? "    windowsHide: true," : "    // windowsHide: only relevant on Windows",
    "  }]",
    "};",
  ].join("\n");
  writeFileSync(ecosystemPath, content, "utf-8");
  log(`  ${ecosystemPath}`);
  return ecosystemPath;
}

// ── Set up PM2 daemon ───────────────────────────────────

function setupDaemon(ecosystemPath) {
  // Start via PM2 ecosystem config
  const startResult = tryRun(`pm2 start "${ecosystemPath}"`, { timeout: 15000 });
  if (startResult && startResult.error) {
    log(`  ${yellow("⚠ PM2 start failed:")} ${startResult.message.slice(0, 120)}`);
    log(`  ${yellow("  Start manually:")} pm2 start "${ecosystemPath}"`);
    return false;
  }
  log("  PM2 started.");

  // Save process list
  tryRun("pm2 save", { timeout: 10000 });
  log("  PM2 process list saved.");

  // Set up startup (auto-restart on boot)
  const startupResult = tryRun("pm2 startup", { timeout: 15000 });
  if (startupResult && startupResult.error) {
    const msg = (startupResult.message || "").toLowerCase();
    if (msg.includes("already") || msg.includes("not modified")) {
      log("  PM2 startup already configured.");
    } else if (msg.includes("permission") || msg.includes("denied") || msg.includes("sudo") || msg.includes("eacces")) {
      log(`  ${yellow("⚠ PM2 startup needs sudo on this platform.")}`);
      log(`  ${yellow("  Run manually:")} pm2 startup`);
      if (IS_LINUX) log(`  ${yellow("  (you may need: sudo pm2 startup)")}`);
    } else {
      log(`  ${yellow("⚠ PM2 startup:")} ${startupResult.message.slice(0, 80)}`);
      log(`  ${yellow("  Run manually if needed:")} pm2 startup`);
    }
  } else {
    log("  PM2 startup configured (auto-restarts on boot).");
  }

  return true;
}

// ── Print done banner ───────────────────────────────────

function printDone(version, extChrome, extFirefox) {
  const pathHint = pathInstructions();

  console.log(`
  ${bold(green("✅ BrowserPowers " + version + " installed"))}

     ${BP_DIR}

  ${bold("📋 CLI:")}

     ${binName("browserpowers")} status        Check daemon + connected browsers
     ${binName("browserpowers")} serve         Run server in foreground
     ${binName("browserpowers")} list          List connected browsers
     ${binName("browserpowers")} page read     Read page content
     ${binName("browserpowers")} page act      Interact with pages

  ${bold("🌐 Chrome Extension:")}

     Load this folder in chrome://extensions:
     ${extChrome}

     (Check "Developer mode" → "Load unpacked" → pick that folder)

  ${bold("🦊 Firefox Extension:")}

     Load this folder in about:debugging:
     ${extFirefox}

     (Check "Enable add-on debugging" → "Load Temporary Add-on" → pick manifest.json)

  ${bold("🔌 MCP:")}

     Connect your MCP client to:
     http://localhost:4199/mcp

     Or run: ${binName("browserpowers")} mcp-config --client claude

  ${bold("📌 Add to PATH")}

${pathHint}

  ${bold("🔄 Update:")}

     git pull
     node scripts/install.mjs

  ${bold("🗑  Uninstall:")}

     node scripts/install.mjs --uninstall

  ${bold("📊 PM2:")}

     pm2 status                  Show all PM2 processes
     pm2 logs browserpowers      Show daemon logs
     pm2 stop browserpowers      Stop daemon
     pm2 restart browserpowers   Restart daemon
`);
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);
  const isUninstall = args.includes("--uninstall");
  const isForce = args.includes("--force");

  // ── Greeting ──
  console.log(`\n  ${bold("BrowserPowers Installer")}  ${cyan("v1.0.0")}`);
  console.log(`  ${"─".repeat(35)}`);

  // ── Gate 1: Check ALL prerequisites before doing anything ──
  checkPrerequisites();

  // ── Gate 2: Handle --uninstall ──
  if (isUninstall) {
    console.log(`\n  ${bold("Uninstalling...")}\n`);
    killDaemon();
    try { execSync("pm2 unstartup", { stdio: "pipe" }); } catch { /* not set up */ }
    if (existsSync(BP_DIR)) rmSync(BP_DIR, { recursive: true });
    console.log(`  Removed ${BP_DIR}\n`);

    if (IS_WIN) {
      console.log(`  Also remove from PATH: System Properties → Environment Variables → User PATH\n`);
    } else {
      console.log(`  Also remove ${BP_BIN} from your PATH (in ${shellRc() || "shell config"}).\n`);
    }
    process.exit(0);
  }

  // ── Read version info ──
  const repoPkg = readJson(PKG_CORE);
  let existingVersion = null;
  if (existsSync(resolve(BP_CORE, "package.json"))) {
    existingVersion = readJson(resolve(BP_CORE, "package.json")).version;
  }

  const isUpdate = existingVersion !== null;
  const versionChanged = existingVersion && existingVersion !== repoPkg.version;

  if (isUpdate && !versionChanged && !isForce) {
    console.log(`\n  BrowserPowers ${repoPkg.version} already installed at ${BP_DIR}`);
    console.log(`  Run with ${cyan("--force")} to re-copy and restart.\n`);
    process.exit(0);
  }

  if (isUpdate && versionChanged) {
    console.log(`\n  Updating: ${yellow(existingVersion)} → ${green(repoPkg.version)}\n`);
  } else if (!isUpdate) {
    console.log(`\n  Installing ${green(repoPkg.version)} to ${BP_DIR}\n`);
  }

  // ── Kill existing daemon before touching files ──
  killDaemon();

  // ── Step 1: Create directories ──
  step(1, "Creating directories");
  mkdirSync(BP_DIR, { recursive: true });
  mkdirSync(BP_BIN, { recursive: true });
  log(`  ${BP_DIR}`);
  log(`  ${BP_BIN}`);

  // ── Step 2: Copy core ──
  step(2, "Copying core");
  if (existsSync(BP_CORE)) rmSync(BP_CORE, { recursive: true });
  cpSync(resolve(REPO_DIR, "core"), BP_CORE, {
    recursive: true,
    filter: copyFilter,
  });
  log(`  core/ → ${BP_CORE}`);

  // ── Step 3: Install core deps ──
  step(3, "Installing core dependencies");
  mustRun("pnpm install --no-frozen-lockfile --ignore-scripts", { cwd: BP_CORE });
  log("  Done.");

  // ── Step 4: Copy & build extension ──
  step(4, "Building extension for Chrome and Firefox");

  const EXT_TMP = resolve(BP_DIR, ".ext-tmp");
  const EXT_CHROME = BP_EXT;
  const EXT_FIREFOX = resolve(BP_DIR, "extension-firefox");

  if (existsSync(EXT_TMP)) rmSync(EXT_TMP, { recursive: true });
  if (existsSync(EXT_CHROME)) rmSync(EXT_CHROME, { recursive: true });

  cpSync(resolve(REPO_DIR, "extension"), EXT_TMP, {
    recursive: true,
    filter: copyFilter,
  });

  log("  Installing extension dependencies...");
  mustRun("pnpm install --no-frozen-lockfile --ignore-scripts", { cwd: EXT_TMP });

  // Build Chrome MV3
  log("  Building Chrome MV3...");
  mustRun("pnpm build:chrome", { cwd: EXT_TMP });
  const chromeBuilt = resolve(EXT_TMP, ".output", "chrome-mv3");
  if (existsSync(chromeBuilt)) {
    cpSync(chromeBuilt, EXT_CHROME, { recursive: true });
    log(`  → ${EXT_CHROME} (manifest.json at root)`);
  }

  // Build Firefox MV2
  log("  Building Firefox MV2...");
  mustRun("pnpm build:firefox", { cwd: EXT_TMP });
  const ffBuilt = resolve(EXT_TMP, ".output", "firefox-mv2");
  if (existsSync(ffBuilt)) {
    mkdirSync(EXT_FIREFOX, { recursive: true });
    cpSync(ffBuilt, EXT_FIREFOX, { recursive: true });
    log(`  → ${EXT_FIREFOX} (manifest.json at root)`);
  }

  // Clean up temp
  rmSync(EXT_TMP, { recursive: true });
  log("  Done.");

  // ── Step 5: Create CLI wrappers ──
  step(5, "Creating CLI wrapper");

  const tsxCli = resolve(BP_CORE, "node_modules", "tsx", "dist", "cli.mjs");
  const coreEntry = resolve(BP_CORE, "src", "index.ts");
  writeCliWrappers(tsxCli, coreEntry);

  // PATH hint
  console.log(`\n  ${bold("📌 Add to PATH")}`);
  console.log();
  if (IS_WIN) {
    console.log(`    ${binName("browserpowers")} wrappers installed to:\n`);
    console.log(`      ${BP_BIN}\n`);
    console.log(`    ${bold("PowerShell:")}`);
    console.log(`      [Environment]::SetEnvironmentVariable("Path",`);
    console.log(`        "$env:USERPROFILE\\.browserpowers\\bin;$env:Path",`);
    console.log(`        "User")`);
    console.log();
    console.log(`    ${bold("Or manually:")}`);
    console.log(`      System Properties → Advanced → Environment Variables → User PATH`);
  } else {
    const rc = shellRc();
    console.log(`    ${binName("browserpowers")} wrapper installed to:\n`);
    console.log(`      ${BP_BIN}\n`);
    console.log(`    Add to your ${bold(rc || "shell config")}:`);
    console.log(`      export PATH="\$PATH:${BP_BIN}"\n`);
    console.log(`    Then reload:`);
    console.log(`      source ${rc || "~/.profile"}`);
  }

  // ── Step 6: Set up PM2 daemon ──
  step(6, "Setting up PM2 daemon");

  const ecosystemPath = writeEcosystemConfig();

  const daemonOk = setupDaemon(ecosystemPath);
  if (!daemonOk) {
    log(`  ${yellow("⚠ Daemon setup incomplete. Fix and run:")}`);
    log(`  ${yellow("  pm2 start")} "${ecosystemPath}"`);
  }

  // ── Step 7: Done ──
  step(7, "Installation complete");
  printDone(repoPkg.version, EXT_CHROME, EXT_FIREFOX);
}

main();
