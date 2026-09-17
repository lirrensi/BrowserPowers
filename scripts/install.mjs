#!/usr/bin/env node

// FILE: scripts/install.mjs
// PURPOSE: One-shot BrowserPowers install / update / uninstall with hidden OS auto-start.
// OWNS: Repo-to-home artifact install, CLI wrapper creation, and daemon startup.
// EXPORTS: none (side-effect CLI script)
// DOCS: docs/spec/installer-hard-spec.md
//
// ═══════════════════════════════════════════════════════════════
// HARD SPEC — THE WINDOW RULE  (§0.0 of installer-hard-spec.md)
// ═══════════════════════════════════════════════════════════════
//   The daemon MUST NEVER open a visible console window — ever.
//   Not during install, not during start, not during restart,
//   not on auto-start at logon.  serve is the ONLY foreground mode.
//
//   Installer:  starts daemon via `browserpowers start` which
//               spawns with windowsHide:true (CREATE_NO_WINDOW).
//   Logon task: calls .daemon-launcher.ps1 which uses .NET
//               ProcessStartInfo.CreateNoWindow = $true.
//   BANNED:     VBS, cmd /c start /b, ShowWindow(SW_HIDE), or
//               any mechanism that creates a window then hides it.
// ═══════════════════════════════════════════════════════════════

/**
 * BrowserPowers — One-shot install / update / uninstall.
 *
 * Kills any old daemon on port 4199, installs dependencies,
 * builds the extension, copies it to ~/.browserpowers/, puts CLI on PATH,
 * and starts the daemon in background.
 *
 * Registers hidden OS-level auto-start so BrowserPowers starts on user
 * logon (Windows: user-scoped Task Scheduler task; macOS: LaunchAgent;
 * Linux: XDG autostart).
 *
 * Background process strategy (no console window, survives parent exit):
 *   Windows — user-scoped Task Scheduler task with Hidden = true
 *   Unix    — `spawn` with `detached: true`
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

import {
    existsSync,
    mkdirSync,
    cpSync,
    readFileSync,
    writeFileSync,
    rmSync,
    chmodSync,
    unlinkSync,
    renameSync,
} from "node:fs";
import { execSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve, relative } from "node:path";

// ── Paths ───────────────────────────────────────────────

const REPO_DIR = process.cwd();
const BP_DIR = resolve(homedir(), ".browserpowers");
const BP_CORE = resolve(BP_DIR, "core");
const BP_CORE_REPO = resolve(REPO_DIR, "core"); // core runs from the repo (npm workspaces)
const BP_SDK = resolve(BP_DIR, "sdk");
const BP_DAEMON_LAUNCHER = resolve(BP_DIR, ".daemon-launcher.ps1");
const BP_EXT = resolve(BP_DIR, "extension");
const BP_BIN = resolve(BP_DIR, "bin");
const BP_BIN_BROWSERPOWERS = resolve(BP_BIN, IS_WIN ? "browserpowers.cmd" : "browserpowers");
const PKG_CORE = resolve(REPO_DIR, "core", "package.json");

// ── ANSI styling (minimal, safe) ────────────────────────

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function bold(s) {
    return `${BOLD}${s}${RESET}`;
}
function red(s) {
    return `${RED}${s}${RESET}`;
}
function green(s) {
    return `${GREEN}${s}${RESET}`;
}
function yellow(s) {
    return `${YELLOW}${s}${RESET}`;
}
function cyan(s) {
    return `${CYAN}${s}${RESET}`;
}

// ── Cleanup & signal handling ────────────────────────────
// The script must always exit — never get stuck in an incomplete state.
// Any uncaught error, signal, or rejected promise triggers cleanup of
// the partial install temp dir and an explicit non-zero exit. There are
// no retry loops and no unbounded polls; the user re-runs after fixing
// whatever went wrong.

const BP_EXT_TMP = resolve(BP_DIR, ".ext-tmp");
const BP_STAGING_CHROME = resolve(BP_DIR, ".extension-staging-chrome");
const BP_STAGING_FIREFOX = resolve(BP_DIR, ".extension-staging-firefox");
const BP_STAGING_SDK = resolve(BP_DIR, ".sdk-staging");

function cleanupPartial() {
    for (const p of [BP_EXT_TMP, BP_STAGING_CHROME, BP_STAGING_FIREFOX, BP_STAGING_SDK]) {
        if (existsSync(p)) {
            try {
                rmSync(p, { recursive: true, maxRetries: 5, retryDelay: 300, force: true });
            } catch {}
        }
    }
}

/**
 * Atomically replace `targetPath` with `stagingPath`. The browser keeps a
 * valid reference at `targetPath` throughout — the old version is moved
 * aside (`.old`) only after the new one is fully staged, and restored on
 * any failure. The extension path is therefore never missing.
 */
function atomicSwapDir(stagingPath, targetPath) {
    const oldBackup = targetPath + ".old";
    if (existsSync(oldBackup)) {
        try {
            rmSync(oldBackup, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch {}
    }
    if (existsSync(targetPath)) {
        try {
            renameSync(targetPath, oldBackup);
        } catch {
            // If rename is blocked (Chrome holding the dir), fall back to rm —
            // there's a microsecond window where the path is missing, but
            // Chrome reloads the extension the moment it reappears.
            rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        }
    }
    try {
        renameSync(stagingPath, targetPath);
    } catch (err) {
        // Restore from backup so the browser's reference stays valid.
        if (existsSync(oldBackup)) {
            try {
                renameSync(oldBackup, targetPath);
            } catch {}
        }
        throw err;
    }
    if (existsSync(oldBackup)) {
        try {
            rmSync(oldBackup, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch {}
    }
}

let exiting = false;
function exitWithCleanup(code, reason) {
    if (exiting) process.exit(code);
    exiting = true;
    if (reason) console.error(`\n  ${red("✖")} ${reason}\n`);
    cleanupPartial();
    process.exit(code);
}

process.on("SIGINT", () => exitWithCleanup(130, "Interrupted (SIGINT)"));
process.on("SIGTERM", () => exitWithCleanup(143, "Terminated (SIGTERM)"));
process.on("uncaughtException", err =>
    exitWithCleanup(1, `Uncaught exception: ${err && err.message ? err.message : String(err)}`),
);
process.on("unhandledRejection", reason => exitWithCleanup(1, `Unhandled rejection: ${reason}`));

// ── Helpers ─────────────────────────────────────────────

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf-8"));
}

function log(...args) {
    console.log(`  ${args.join(" ")}`);
}

function step(num, msg) {
    console.log(`\n  ${bold(`[${num}/6] ${msg}`)}`);
    console.log(`  ${"-".repeat(msg.length + 6)}`);
}

function fatal(message) {
    if (!exiting) {
        console.error(`\n  ${red("✖")} ${message}\n`);
        cleanupPartial();
    }
    process.exit(1);
}

/**
 * Run a shell command. Fails with a clear message on error — does NOT exit
 * the process; caller decides. Supports `inheritStdio: true` so the user
 * sees live output for long-running commands (builds, installs) instead of
 * the script appearing hung. Default timeout is 10 min — long enough for
 * WXT's first-run build, short enough that a genuine hang still surfaces.
 */
const DEFAULT_RUN_TIMEOUT_MS = 60_000;

function tryRun(cmd, opts = {}) {
    const { inheritStdio, timeoutMs, ...execOpts } = opts;
    const cwd = execOpts.cwd || BP_DIR;
    log(`  $ ${cyan(cmd)}`);
    try {
        return execSync(cmd, {
            cwd,
            stdio: inheritStdio ? "inherit" : "pipe",
            timeout: timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
            encoding: "utf-8",
            ...execOpts,
        });
    } catch (err) {
        const e = err;
        const stderr = (e.stderr || "").toString().trim();
        const stdout = (e.stdout || "").toString().trim();
        const signal = e.signal ? ` (signal: ${e.signal})` : "";
        const message = e.killed
            ? `Process killed${signal} after ${timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms — likely timeout`
            : stderr || stdout || e.message || String(err);
        return { error: true, message, stderr, stdout };
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
        if (shell.includes("zsh")) return "~/.zshrc";
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

// ── Stop / remove ───────────────────────────────────────

function isPortBusy(port = 4199) {
    try {
        const r = execSync(
            `powershell -NoProfile -Command "[bool](Get-NetTCPConnection -LocalPort ${port} -EA SilentlyContinue)"`,
            { stdio: "pipe", encoding: "utf-8", timeout: 5000 },
        );
        return r.trim().toLowerCase() === "true";
    } catch {
        return false;
    }
}

/** Kill whatever process is on the BrowserPowers port. Never throws. */
function killServerOnPort(port = 4199) {
    if (IS_WIN) {
        try {
            execSync(
                `powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort ${port} -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1; if ($p) { Stop-Process -Id $p -Force }"`,
                { stdio: "pipe", timeout: 8000 },
            );
        } catch {
            /* no listener */
        }

        // Wait for the port to actually be free. Bounded: 10 tries × 500ms = 5s max.
        for (let tries = 0; tries < 10; tries++) {
            try {
                const r = execSync(
                    `powershell -NoProfile -Command "[bool](Get-NetTCPConnection -LocalPort ${port} -EA SilentlyContinue)"`,
                    { stdio: "pipe", encoding: "utf-8", timeout: 5000 },
                );
                if (r.trim().toLowerCase() !== "true") break;
            } catch {
                break;
            }
            try {
                execSync(`powershell -NoProfile -Command Start-Sleep -Milliseconds 500`, { stdio: "pipe" });
            } catch {}
        }
    } else {
        try {
            execSync(`fuser -k ${port}/tcp 2>/dev/null || lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
                stdio: "pipe",
                timeout: 5000,
            });
        } catch {}
    }
}

/** Stop the running service. Used before reinstall and before uninstall. */
function stopService() {
    killServerOnPort();
}

// ── Auto-start: the OS runs the daemon at user logon ──
// The daemon must start automatically, with no visible window on Windows.

/** Remove the OS-level auto-start entry. Used during uninstall. */
function removeAutoStart() {
    if (IS_WIN) {
        tryRun(
            `powershell -NoProfile -Command "Unregister-ScheduledTask -TaskName 'BrowserPowers' -Confirm:$false -EA SilentlyContinue"`,
        );
        // Clean up the daemon launcher script (logon auto-start only, not used for manual start).
        if (existsSync(BP_DAEMON_LAUNCHER)) {
            try {
                unlinkSync(BP_DAEMON_LAUNCHER);
            } catch {}
        }
    } else if (IS_LINUX) {
        const desktopPath = resolve(homedir(), ".config", "autostart", "browserpowers.desktop");
        try {
            unlinkSync(desktopPath);
        } catch {
            /* not found */
        }
    } else if (IS_MAC) {
        try {
            const uid = execSync("id -u", { encoding: "utf-8", timeout: 5000 }).trim();
            execSync(`launchctl bootout gui/${uid}/com.browserpowers`, { stdio: "pipe", timeout: 8000 });
        } catch {
            /* not running */
        }
        const plistPath = resolve(homedir(), "Library", "LaunchAgents", "com.browserpowers.plist");
        try {
            unlinkSync(plistPath);
        } catch {
            /* not found */
        }
    }
}

/**
 * Windows: user-scoped Task Scheduler task that runs `browserpowers start`
 * at logon — the exact same code path as manual start.
 *
 * The task calls `browserpowers.cmd start` via PowerShell with
 * -WindowStyle Hidden.  startDetached() then spawns launcher.exe
 * (GUI binary, CREATE_NO_WINDOW) to start the daemon.
 */
function createWindowsAutoStart() {
    // Clean up legacy auto-start artifacts.
    tryRun(`reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "BrowserPowers" /f`);
    const legacyVbs = resolve(BP_BIN, "browserpowers.vbs");
    if (existsSync(legacyVbs)) {
        try {
            unlinkSync(legacyVbs);
        } catch {}
    }
    // Legacy .daemon-launcher.ps1 from before the Go launcher era.
    if (existsSync(BP_DAEMON_LAUNCHER)) {
        try {
            unlinkSync(BP_DAEMON_LAUNCHER);
        } catch {}
    }

    // Task action: PowerShell runs browserpowers start.
    // browserpowers start → startDetached() → launcher.exe → daemon.
    const psSingleQuote = s => `'${s.replace(/'/g, "''")}'`;
    const psContent = [
        `$wrapper = ${psSingleQuote(BP_BIN_BROWSERPOWERS)}`,
        `$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command & $wrapper start"`,
        `$trigger = New-ScheduledTaskTrigger -AtLogon -User "$env:USERNAME"`,
        `$settings = New-ScheduledTaskSettingsSet -Hidden`,
        `Register-ScheduledTask -TaskName "BrowserPowers" -Action $action -Trigger $trigger -Settings $settings -Force`,
    ].join("\n");

    const tmpPs1 = resolve(BP_DIR, ".register-task.ps1");
    writeFileSync(tmpPs1, psContent, "utf-8");
    try {
        mustRun(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`, { cwd: BP_DIR });
        log(`  Scheduled task: BrowserPowers (will run browserpowers start at logon)`);
        return true;
    } finally {
        try {
            unlinkSync(tmpPs1);
        } catch {}
    }
}

/**
 * Linux: XDG autostart .desktop file fires the daemon at desktop logon.
 */
function createLinuxAutoStart() {
    const autostartDir = resolve(homedir(), ".config", "autostart");
    mkdirSync(autostartDir, { recursive: true });
    const desktopPath = resolve(autostartDir, "browserpowers.desktop");
    const desktop = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=BrowserPowers",
        `Exec=${BP_BIN_BROWSERPOWERS} start`,
        "X-GNOME-Autostart-enabled=true",
        "NoDisplay=false",
        "Terminal=false",
    ].join("\n");
    writeFileSync(desktopPath, desktop, "utf-8");
    chmodSync(desktopPath, 0o644);
    log(`  ${desktopPath}`);
    return true;
}

/**
 * macOS: LaunchAgent plist fires the daemon at logon.
 */
function createMacAutoStart() {
    const plistDir = resolve(homedir(), "Library", "LaunchAgents");
    mkdirSync(plistDir, { recursive: true });
    const plistPath = resolve(plistDir, "com.browserpowers.plist");
    const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "    <key>Label</key>",
        "    <string>com.browserpowers</string>",
        "    <key>ProgramArguments</key>",
        "    <array>",
        `        <string>${BP_BIN_BROWSERPOWERS}</string>`,
        "        <string>start</string>",
        "    </array>",
        "    <key>RunAtLoad</key>",
        "    <true/>",
        "</dict>",
        "</plist>",
    ].join("\n");
    writeFileSync(plistPath, plist, "utf-8");
    log(`  ${plistPath}`);

    try {
        const uid = execSync("id -u", { encoding: "utf-8", timeout: 5000 }).trim();
        tryRun(`launchctl bootstrap gui/${uid} "${plistPath}"`, { timeout: 10000 });
    } catch {
        const load = tryRun(`launchctl load "${plistPath}"`, { timeout: 10000 });
        if (load && load.error) {
            log(`  ${yellow("⚠ Could not load launchd agent.")}`);
            log(`  ${yellow("  Run manually: launchctl load")} "${plistPath}"`);
            return false;
        }
    }
    return true;
}

function createAutoStart() {
    if (IS_WIN) return createWindowsAutoStart();
    if (IS_MAC) return createMacAutoStart();
    return createLinuxAutoStart();
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

    // ── 2. npm >= 10 (ships with Node 20+ — no separate install) ──
    const npmResult = tryRun("npm --version", { cwd: REPO_DIR });
    if (npmResult && npmResult.error) {
        failures.push({
            name: "npm >= 10",
            detail: "Not found",
            install: "  npm ships with Node.js — reinstall Node from https://nodejs.org/ (LTS recommended)",
        });
    } else {
        const npmVer = (npmResult || "").toString().trim();
        if (!satisfiesVersion(npmVer, "10")) {
            failures.push({
                name: "npm >= 10",
                detail: `Found: ${npmVer}`,
                install: "    npm install -g npm@latest",
            });
        }
    }

    // ── 3. tsx (local to the repo — no global install needed) ──
    const tsxResult = tryRun("npm ls tsx", { cwd: REPO_DIR });
    if (tsxResult && tsxResult.error) {
        failures.push({
            name: "tsx (local)",
            detail: "Not installed — needed to run the CLI wrapper",
            install: "    npm install",
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
    if (rel.includes(".output")) return false;
    if (rel.includes("dist")) return false;
    if (rel.endsWith("package-lock.json")) return false;
    return true;
}

// ── SDK file filter ─────────────────────────────────────
// Only the files a foreign project needs to `npm install file:<sdk>`:
// the zero-dep client bundle (.js + .d.ts) plus the identity files npm
// requires (package.json + LICENSE). Everything else (src, tests,
// tsconfig, launcher, server code) stays in the repo.
const SDK_FILES = ["package.json", "LICENSE", "client.js", "client.d.ts"];

// ── Create CLI wrappers ─────────────────────────────────
// Platform-appropriate wrappers so `browserpowers` works from any terminal.

function writeCliWrappers(tsxCli, coreEntry) {
    // ── Windows: .cmd batch file ──
    if (IS_WIN) {
        const cmdPath = resolve(BP_BIN, "browserpowers.cmd");
        const cmdContent = [`@echo off`, `node "${tsxCli}" "${coreEntry}" %*`].join("\r\n");
        writeFileSync(cmdPath, cmdContent, "utf-8");
        log(`  ${cmdPath}`);
        // `bp` shorthand — forwards so there is only one real wrapper to maintain.
        const bpCmdPath = resolve(BP_BIN, "bp.cmd");
        const bpCmdContent = [`@echo off`, `call "%~dp0browserpowers.cmd" %*`].join("\r\n");
        writeFileSync(bpCmdPath, bpCmdContent, "utf-8");
        log(`  ${bpCmdPath}`);
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
        const bpPsPath = resolve(BP_BIN, "bp.ps1");
        const bpPsContent = [
            `#!/usr/bin/env pwsh`,
            `& "$PSScriptRoot\\browserpowers.ps1" @args`,
        ].join("\n");
        writeFileSync(bpPsPath, bpPsContent, "utf-8");
        log(`  ${bpPsPath}`);
    }

    // ── Unix: shell script ──
    if (!IS_WIN) {
        const shPath = resolve(BP_BIN, "browserpowers");
        const shContent = [`#!/bin/sh`, `exec node "${tsxCli}" "${coreEntry}" "$@"`].join("\n");
        writeFileSync(shPath, shContent, "utf-8");
        chmodSync(shPath, 0o755);
        log(`  ${shPath}`);
        const bpShPath = resolve(BP_BIN, "bp");
        const bpShContent = [`#!/bin/sh`, `exec "$(dirname "$0")/browserpowers" "$@"`].join("\n");
        writeFileSync(bpShPath, bpShContent, "utf-8");
        chmodSync(bpShPath, 0o755);
        log(`  ${bpShPath}`);
    }
    // ── All platforms: Node.js .mjs wrapper ──
    // (used by the .cmd / .sh wrappers above, also runnable directly)
    // npm hoists tsx to the repo root — probe core/node_modules first
    // (pnpm layout), fall back to the root (npm layout).
    const mjsPath = resolve(BP_BIN, "browserpowers.mjs");
    const mjsContent = [
        `#!/usr/bin/env node`,
        `import { spawn } from "node:child_process";`,
        `import { existsSync } from "node:fs";`,
        `import { resolve, dirname } from "node:path";`,
        `import { fileURLToPath } from "node:url";`,
        `const __dirname = dirname(fileURLToPath(import.meta.url));`,
        `const coreDir = resolve(__dirname, "../core");`,
        `const repoDir = resolve(__dirname, "../..");`,
        `const localTsx = resolve(coreDir, "node_modules/tsx/dist/cli.mjs");`,
        `const hoistedTsx = resolve(repoDir, "node_modules/tsx/dist/cli.mjs");`,
        `const tsxPath = existsSync(localTsx) ? localTsx : hoistedTsx;`,
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
    // `bp` for the .mjs entry too (direct node invocation, scripts).
    const bpMjsPath = resolve(BP_BIN, "bp.mjs");
    const bpMjsContent = [
        `#!/usr/bin/env node`,
        `// Shorthand — forwards to browserpowers.mjs so PATH only needs one dir.`,
        `import { spawn } from "node:child_process";`,
        `import { resolve, dirname } from "node:path";`,
        `import { fileURLToPath } from "node:url";`,
        `const target = resolve(dirname(fileURLToPath(import.meta.url)), "browserpowers.mjs");`,
        `const child = spawn(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" });`,
        `child.on("exit", (code) => process.exit(code ?? 0));`,
    ].join("\n");
    writeFileSync(bpMjsPath, bpMjsContent, "utf-8");
    if (!IS_WIN) chmodSync(bpMjsPath, 0o755);
    log(`  ${bpMjsPath}`);
}

// ── Print done banner ───────────────────────────────────

function printDone(version, extChrome, extFirefox) {
    const pathHint = pathInstructions();

    console.log(`
  ${bold(green("✅ BrowserPowers " + version + " installed"))}

     ${BP_DIR}

  ${bold("📋 CLI:")}  (bp = shorthand — bp status works everywhere browserpowers status does)

     ${binName("browserpowers")} start          Start daemon in background (no visible window)
     ${binName("browserpowers")} restart        Stop & restart the daemon
     ${binName("browserpowers")} stop           Stop the daemon
     ${binName("browserpowers")} serve          Run server in foreground (for debugging)
     ${binName("browserpowers")} page read      Read page content
     ${binName("browserpowers")} page act       Interact with pages
     ${binName("browserpowers")} sdk path       Print the vendored SDK dir (npm install "file:$(bp sdk path)")

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

  ${bold("🔄 Auto-start:")}

     BrowserPowers starts automatically on logon.
     To disable, run: node scripts/install.mjs --uninstall
  `);
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);
    const isUninstall = args.includes("--uninstall");
    const isForce = args.includes("--force");

    // ── Greeting ──
    console.log(`\n  ${bold("BrowserPowers Installer")}  ${cyan("v2.0.0")}`);
    console.log(`  ${"─".repeat(35)}`);

    // ── Gate 1: Check ALL prerequisites before doing anything ──
    checkPrerequisites();

    // ── Gate 2: Handle --uninstall ──
    if (isUninstall) {
        console.log(`\n  ${bold("Uninstalling...")}\n`);
        stopService();
        removeAutoStart();
        if (existsSync(BP_DIR)) rmSync(BP_DIR, { recursive: true, maxRetries: 5, retryDelay: 500 });
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

    if (isUpdate && versionChanged) {
        console.log(`\n  Updating: ${yellow(existingVersion)} → ${green(repoPkg.version)}\n`);
    } else if (!isUpdate) {
        console.log(`\n  Installing ${green(repoPkg.version)} to ${BP_DIR}\n`);
    }

    // ── Stop existing service before touching files ──
    stopService();

    // ── Step 1: Create directories ──
    step(1, "Creating directories");
    mkdirSync(BP_DIR, { recursive: true });
    mkdirSync(BP_BIN, { recursive: true });
    log(`  ${BP_DIR}`);
    log(`  ${BP_BIN}`);

    // ── Global hard exit cap ──
    // No matter what happens, the installer is killed and exits after 60s.
    // This timer fires on the event loop; a synchronous execSync cannot be
    // interrupted mid-flight, but every execSync below is capped at 60s as
    // well, so the worst-case total runtime is bounded.
    setTimeout(() => {
        console.error(`\n  ${red("✖")} Install timed out after 60 seconds — exiting hard.\n`);
        cleanupPartial();
        process.exit(124);
    }, 60_000).unref();

    // ── Step 2: Install deps in the repo (npm workspaces: root package.json) ──
    // The core stays in the repo and runs from there. The CLI wrapper and the
    // daemon spawn both point at the repo's core paths.
    step(2, "Installing dependencies (npm workspaces)");
    mustRun("npm install --no-audit --no-fund", { cwd: REPO_DIR, inheritStdio: true });
    log("  Done.");

    // ── Step 2b: Build the core (tsc → dist/) so the SDK has a bundle to vendor.
    // The daemon CLI wrappers need dist/index.js too — today it only exists
    // if the developer happened to run `npm run build` beforehand. Building
    // here makes install self-contained: repo deletable right after.
    log("  Building core...");
    mustRun("npm run build -w browserpowers", { cwd: REPO_DIR, inheritStdio: true });
    const coreDist = resolve(BP_CORE_REPO, "dist");
    if (!existsSync(resolve(coreDist, "client.js")) || !existsSync(resolve(coreDist, "index.js"))) {
        fatal(`Core build did not produce expected output at ${coreDist} (client.js + index.js)`);
    }
    log("  Done.");

    // ── Step 3: Build extension in-place, then atomically swap into place ──
    // Building inside the repo keeps npm in its native workspace context. The
    // built `.output/chrome-mv3` and `.output/firefox-mv2` are staged under
    // `~/.browserpowers/`, then atomically swapped onto the canonical extension
    // paths. The browser's reference to those paths stays valid throughout —
    // the old extension is moved aside only after the new one is fully staged,
    // and restored on any failure. There is a single canonical path per
    // browser; uninstall + reinstall always replaces it cleanly.
    step(3, "Building extension for Chrome and Firefox");

    const EXT_REPO = resolve(REPO_DIR, "extension");
    const EXT_CHROME = BP_EXT;
    const EXT_FIREFOX = resolve(BP_DIR, "extension-firefox");

    log("  Building Chrome MV3...");
    mustRun("npm run build:chrome -w browserpowers-extension", { cwd: REPO_DIR, inheritStdio: true });
    const chromeBuilt = resolve(EXT_REPO, ".output", "chrome-mv3");
    if (!existsSync(chromeBuilt)) {
        fatal(`Chrome build did not produce expected output at ${chromeBuilt}`);
    }
    if (existsSync(BP_STAGING_CHROME)) {
        rmSync(BP_STAGING_CHROME, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
    try {
        cpSync(chromeBuilt, BP_STAGING_CHROME, { recursive: true });
    } catch (err) {
        cleanupPartial();
        fatal(`Failed to stage Chrome extension: ${err && err.message ? err.message : String(err)}`);
    }
    atomicSwapDir(BP_STAGING_CHROME, EXT_CHROME);
    log(`  → ${EXT_CHROME} (manifest.json at root)`);

    // ── Firefox MV2 ──
    log("  Building Firefox MV2...");
    mustRun("npm run build:firefox -w browserpowers-extension", { cwd: REPO_DIR, inheritStdio: true });
    const ffBuilt = resolve(EXT_REPO, ".output", "firefox-mv2");
    if (!existsSync(ffBuilt)) {
        fatal(`Firefox build did not produce expected output at ${ffBuilt}`);
    }
    if (existsSync(BP_STAGING_FIREFOX)) {
        rmSync(BP_STAGING_FIREFOX, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
    try {
        cpSync(ffBuilt, BP_STAGING_FIREFOX, { recursive: true });
    } catch (err) {
        cleanupPartial();
        fatal(`Failed to stage Firefox extension: ${err && err.message ? err.message : String(err)}`);
    }
    atomicSwapDir(BP_STAGING_FIREFOX, EXT_FIREFOX);
    log(`  → ${EXT_FIREFOX} (manifest.json at root)`);

    // ── Step 3b: Vendor the zero-dep SDK (client.js + .d.ts) into ~/.browserpowers/sdk.
    // This is the whole point of the exercise: after install, the repo is
    // deletable and `bp sdk path` still prints a stable directory any project
    // can `npm install file:<sdk>` from. Staged + atomically swapped like the
    // extensions, so concurrent `bp`/daemon readers never see a half-written SDK.
    log("  Vendoring SDK...");
    const sdkPkg = readJson(resolve(BP_CORE_REPO, "package.json"));
    if (existsSync(BP_STAGING_SDK)) {
        rmSync(BP_STAGING_SDK, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
    mkdirSync(BP_STAGING_SDK, { recursive: true });
    try {
        for (const f of ["client.js", "client.d.ts"]) {
            const src = resolve(coreDist, f);
            if (!existsSync(src)) {
                cleanupPartial();
                fatal(`Core build missing SDK file: ${src}`);
            }
            cpSync(src, resolve(BP_STAGING_SDK, f));
        }
        cpSync(resolve(REPO_DIR, "LICENSE"), resolve(BP_STAGING_SDK, "LICENSE"));
        const sdkManifest = {
            name: "browserpowers",
            version: sdkPkg.version,
            description: "BrowserPowers script client — zero-dep Node SDK (vendored by install.mjs)",
            type: "module",
            main: "./client.js",
            types: "./client.d.ts",
            exports: {
                ".": { types: "./client.d.ts", import: "./client.js" },
                "./client": { types: "./client.d.ts", import: "./client.js" },
                "./package.json": "./package.json",
            },
            license: "MIT",
        };
        writeFileSync(resolve(BP_STAGING_SDK, "package.json"), JSON.stringify(sdkManifest, null, 2) + "\n", "utf-8");
    } catch (err) {
        cleanupPartial();
        fatal(`Failed to stage SDK: ${err && err.message ? err.message : String(err)}`);
    }
    atomicSwapDir(BP_STAGING_SDK, BP_SDK);
    log(`  → ${BP_SDK} (client.js + package.json)`);

    log("  Done.");

    // ── Step 4: Create CLI wrappers ──
    step(4, "Creating CLI wrapper");

    // Core runs from the repo (where npm's workspace context works).
    const tsxCli = resolve(REPO_DIR, "node_modules", "tsx", "dist", "cli.mjs");
    const coreEntry = resolve(BP_CORE_REPO, "src", "index.ts");
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

    // ── Step 5: Register hidden auto-start ──
    step(5, "Registering auto-start");
    const autoStartOk = createAutoStart();
    if (!autoStartOk) {
        log(`  ${yellow("⚠ Auto-start registration incomplete. See instructions above.")}`);
    }

    // ── Step 6: Start the server in background via the installed CLI wrapper ──
    // Reuse `browserpowers start` so the same cross-platform detached start
    // logic runs. The CLI polls the port for up to 5 s and then exits, so the
    // installer does not need an additional fixed wait (and avoids double-
    // waiting). On Windows the wrapper runs in the installer's console context,
    // so no new window is created.
    step(6, "Starting daemon");
    mustRun(`"${BP_BIN_BROWSERPOWERS}" start`, { cwd: BP_DIR, windowsHide: true });
    log(`  ${green("Install complete — daemon started.")}`);

    // ── Done ──
    printDone(repoPkg.version, EXT_CHROME, EXT_FIREFOX);

    // Explicit exit. The script must never rely on implicit process shutdown.
    process.exit(0);
}

main();
