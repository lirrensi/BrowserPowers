#!/usr/bin/env node

/**
 * BrowserPowers — One-shot install / update / uninstall.
 *
 * Copies everything to ~/.browserpowers/, installs dependencies,
 * builds the extension, puts CLI on PATH, starts daemon via PM2.
 *
 * Prerequisites:
 *   - Node.js >= 18
 *   - pnpm (globally)
 *   - PM2 (globally: pnpm add -g pm2)
 *   - tsx (globally: pnpm add -g tsx)
 *
 * Run from repo root:
 *   node scripts/install.mjs           # fresh install or update
 *   node scripts/install.mjs --force   # reinstall same version
 *   node scripts/install.mjs --uninstall  # remove everything
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Paths ──

const REPO_DIR = process.cwd();
const BP_DIR = resolve(homedir(), ".browserpowers");
const BP_CORE = resolve(BP_DIR, "core");
const BP_EXT = resolve(BP_DIR, "extension");
const BP_BIN = resolve(BP_DIR, "bin");

// ── Helpers ──

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function log(...args) {
  console.log(`  ${args.join(" ")}`);
}

function step(num, msg) {
  console.log(`\n  [${num}/7] ${msg}`);
  console.log(`  ${"-".repeat(msg.length + 6)}`);
}

function run(cmd, opts = {}) {
  const cwd = opts.cwd || BP_DIR;
  log(`  $ ${cmd}`);
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 120000, ...opts });
  } catch (err) {
    const stderr = err.stderr?.toString().trim();
    const stdout = err.stdout?.toString().trim();
    if (stderr) console.error(`  ${stderr}`);
    if (stdout) console.log(`  ${stdout}`);
    process.exit(1);
  }
}

// ── Check prerequisites ──

if (!existsSync(resolve(REPO_DIR, "core", "package.json"))) {
  console.error("\n❌ Run this script from the repo root (BrowserExtC/)\n");
  process.exit(1);
}

try {
  execSync("pm2 --version", { stdio: "pipe" });
} catch {
  console.error("\n❌ PM2 not found. Install globally: pnpm add -g pm2\n");
  process.exit(1);
}

try {
  execSync("tsx --version", { stdio: "pipe" });
} catch {
  console.error("\n❌ tsx not found. Install globally: pnpm add -g tsx\n");
  process.exit(1);
}

try {
  execSync("pm2 --version", { stdio: "pipe" });
} catch {
  console.error("\n❌ PM2 is not installed.\n   Install it globally first:  pnpm add -g pm2\n");
  process.exit(1);
}

// ── Handle --uninstall ──

if (process.argv.includes("--uninstall")) {
  console.log("\n  Uninstalling...\n");
  try { execSync("pm2 delete browserpowers", { stdio: "pipe" }); } catch { /* not running */ }
  try { execSync("pm2 unstartup", { stdio: "pipe" }); } catch { /* not set up */ }
  if (existsSync(BP_DIR)) rmSync(BP_DIR, { recursive: true });
  console.log(`  Removed ${BP_DIR}\n`);
  console.log("  Also remove from PATH: System Properties → Environment Variables → User PATH\n");
  process.exit(0);
}

// ── Read versions ──

const repoPkg = readJson(resolve(REPO_DIR, "core", "package.json"));
let existingVersion = null;
if (existsSync(resolve(BP_CORE, "package.json"))) {
  existingVersion = readJson(resolve(BP_CORE, "package.json")).version;
}

const isUpdate = existingVersion !== null;
const versionChanged = existingVersion && existingVersion !== repoPkg.version;

if (isUpdate && !versionChanged) {
  console.log(`\n  BrowserPowers ${repoPkg.version} already installed at ${BP_DIR}`);
  if (!process.argv.includes("--force")) {
    console.log(`  Run with --force to re-copy and restart.\n`);
    process.exit(0);
  }
}

if (isUpdate && versionChanged) {
  console.log(`\n  Updating BrowserPowers: ${existingVersion} → ${repoPkg.version}\n`);
} else if (!isUpdate) {
  console.log(`\n  Installing BrowserPowers ${repoPkg.version} to ${BP_DIR}\n`);
}

// ── Kill existing daemon before touching files ──

try { execSync("pm2 delete browserpowers", { stdio: "pipe" }); } catch { /* not running */ }

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
  filter: (src) => {
    const rel = src.replace(REPO_DIR + "\\", "").replace(/\\/g, "/");
    if (rel.includes("node_modules")
        || rel.includes(".output")
        || rel.includes("dist")
        || rel.endsWith("pnpm-lock.yaml")) return false;
    return true;
  },
});
log(`  core/ → ${BP_CORE}`);

// ── Step 3: Install core deps ──

step(3, "Installing core dependencies");

run("pnpm install --no-frozen-lockfile --ignore-scripts", { cwd: BP_CORE });
log("  Done.");

// ── Step 4: Copy & build extension ──

step(4, "Building extension for Chrome and Firefox");

const EXT_TMP = resolve(BP_DIR, ".ext-tmp");
const EXT_CHROME = BP_EXT;  // ~/.browserpowers/extension/
const EXT_FIREFOX = resolve(BP_DIR, "extension-firefox");  // ~/.browserpowers/extension-firefox/

// Copy source to temp for building
if (existsSync(EXT_TMP)) rmSync(EXT_TMP, { recursive: true });
if (existsSync(EXT_CHROME)) rmSync(EXT_CHROME, { recursive: true });
cpSync(resolve(REPO_DIR, "extension"), EXT_TMP, {
  recursive: true,
  filter: (src) => {
    const rel = src.replace(REPO_DIR + "\\", "").replace(/\\/g, "/");
    if (rel.includes("node_modules")
        || rel.includes(".output")
        || rel.includes("dist")
        || rel.endsWith("pnpm-lock.yaml")) return false;
    return true;
  },
});

log("  Installing extension dependencies...");
run("pnpm install --no-frozen-lockfile --ignore-scripts", { cwd: EXT_TMP });

// Build Chrome MV3
log("  Building Chrome MV3...");
run("pnpm build:chrome", { cwd: EXT_TMP });
const chromeBuilt = resolve(EXT_TMP, ".output", "chrome-mv3");
if (existsSync(chromeBuilt)) {
  cpSync(chromeBuilt, EXT_CHROME, { recursive: true });
  log(`  → ${EXT_CHROME} (manifest.json at root)`);
}

// Build Firefox MV2
log("  Building Firefox MV2...");
run("pnpm build:firefox", { cwd: EXT_TMP });
const ffBuilt = resolve(EXT_TMP, ".output", "firefox-mv2");
if (existsSync(ffBuilt)) {
  mkdirSync(EXT_FIREFOX, { recursive: true });
  cpSync(ffBuilt, EXT_FIREFOX, { recursive: true });
  log(`  → ${EXT_FIREFOX} (manifest.json at root)`);
}

// Clean up temp
rmSync(EXT_TMP, { recursive: true });
log("  Done.");

// ── Step 5: Create CLI wrapper ──

step(5, "Creating CLI wrapper");

const tsxCli = resolve(BP_CORE, "node_modules", "tsx", "dist", "cli.mjs");
const coreEntry = resolve(BP_CORE, "src", "index.ts");

const cmdContent = `@echo off
node "${tsxCli}" "${coreEntry}" %*
`;
writeFileSync(resolve(BP_BIN, "browserpowers.cmd"), cmdContent, "utf-8");
log(`  ${resolve(BP_BIN, "browserpowers.cmd")}`);

const mjsContent = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(__dirname, "../core");
const tsxPath = path.resolve(coreDir, "node_modules/tsx/dist/cli.mjs");
const entryPath = path.resolve(coreDir, "src/index.ts");
const child = spawn(process.execPath, [tsxPath, entryPath, ...process.argv.slice(2)], { stdio: "inherit", cwd: coreDir });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
`;

writeFileSync(resolve(BP_BIN, "browserpowers.mjs"), mjsContent, "utf-8");
log(`  ${resolve(BP_BIN, "browserpowers.mjs")}`);

// Gentle PATH hint — never modify registry
log("");
log(`  ├─ To use "browserpowers" from any terminal, add to your user PATH:`);
log(`  │  ${BP_BIN}`);
log(`  │`);
log(`  │  PowerShell:  [Environment]::SetEnvironmentVariable("Path",`);
log(`  │                  "$env:USERPROFILE\\.browserpowers\\bin;$env:Path",`);
log(`  │                  "User")`);
log(`  │`);
log(`  │  or: System Properties → Advanced → Environment Variables → User PATH`);
log(`  └─ Restart terminal after adding, then try:  browserpowers --help`);

// ── Step 6: Set up PM2 daemon ──

step(6, "Setting up PM2 daemon");

// Create PM2 ecosystem config with windowsHide=true (no console window)
const ecosystemPath = resolve(BP_DIR, "ecosystem.config.js");
writeFileSync(ecosystemPath, [
  "module.exports = {",
  "  apps: [{",
  `    name: 'browserpowers',`,
  `    script: 'src/index.ts',`,
  `    cwd: '${BP_CORE.replace(/\\/g, "\\\\")}',`,
  `    interpreter: 'node',`,
  `    node_args: ['--import=tsx/esm'],`,
  `    windowsHide: true,`,
  "  }]",
  "};",
  "",
].join("\n"), "utf-8");

log(`  ${ecosystemPath}`);
log(`  windowsHide: true (no console window)`);

// Stop & delete old process if exists
try { execSync("pm2 delete browserpowers", { stdio: "pipe" }); } catch { /* not running */ }

// Start via PM2 ecosystem config
try {
  execSync(`pm2 start "${ecosystemPath}"`, { stdio: "pipe", timeout: 15000 });
  log("  PM2 started.");

  // Save process list
  execSync("pm2 save", { stdio: "pipe" });
  log("  PM2 process list saved.");

  // Set up startup
  try {
    execSync("pm2 startup", { stdio: "pipe", timeout: 10000 });
    log("  PM2 startup configured (auto-restarts on boot).");
  } catch (err) {
    const msg = (err.stderr?.toString() || err.stdout?.toString() || "").trim();
    if (msg.includes("already") || msg.includes("not modified")) {
      log("  PM2 startup already configured.");
    } else {
      log(`  PM2 startup: ${msg.slice(0, 80)}`);
    }
  }
} catch (err) {
  const msg = (err.stderr?.toString() || err.stdout?.toString() || "").trim();
  log(`  ⚠ PM2 failed: ${msg.slice(0, 120)}`);
  log(`  Start manually: pm2 start "${ecosystemPath}"`);
}

// ── Step 7: Done ──

step(7, "Installation complete");

console.log(`
  ✅ BrowserPowers ${repoPkg.version} installed at:

     ${BP_DIR}

  📋 CLI:

     browserpowers status        Check daemon + connected browsers
     browserpowers serve         Run server in foreground
     browserpowers list          List connected browsers
     browserpowers page read     Read page content
     browserpowers page act      Interact with pages

  🌐 Chrome Extension:

     Load this folder in chrome://extensions:
     ${EXT_CHROME}

     (Check "Developer mode" → "Load unpacked" → pick that folder)

  🦊 Firefox Extension:

     Load this folder in about:debugging:
     ${EXT_FIREFOX}

     (Check "Enable add-on debugging" → "Load Temporary Add-on" → pick manifest.json)

  🔌 MCP:

     Connect your MCP client to:
     http://localhost:4199/mcp

     Or run: browserpowers mcp-config --client claude

  🔄 To update:

     Pull the repo, then run the same command:
     node scripts/install.mjs

  🗑 To uninstall:

     node scripts/install.mjs --uninstall

  📊 PM2 commands:

     pm2 status                  Show all PM2 processes
     pm2 logs browserpowers      Show daemon logs
     pm2 stop browserpowers      Stop daemon
     pm2 restart browserpowers   Restart daemon
`);
