# BrowserPowers Installer — Hard Specification

**Scope:** `scripts/install.mjs`, `core/src/index.ts` (start/stop/restart/serve commands)  
**Platforms:** Windows, macOS, Linux  
**Goal:** One script installs BrowserPowers end-to-end. After it exits, the user only opens the browser and loads the unpacked extension.

---

## 0. Non-Negotiable Constraints

These are permanent, never-violate rules.  If a mechanism breaks a rule, the mechanism is wrong — reformulate.

---

### 0.0 THE WINDOW RULE — DO NOT TOUCH

**`serve` is the ONLY command allowed to open a window.**

| Command     | Window allowed? | Behavior |
|-------------|-----------------|----------|
| `serve`     | YES — foreground | Console opens, shows banner, Ctrl+C to close |
| `start`     | **NEVER**        | Spawns hidden daemon, exits immediately |
| `restart`   | **NEVER**        | Stop + start, no window at any point |
| `stop`      | **NEVER**        | Kills daemon, exits immediately |
| Auto-start  | **NEVER**        | Logon trigger, scheduled task — no window, ever |

**"Never" means:** At no point during execution does a visible console window appear, flash, or persist.  Not for 1ms.  Not behind other windows.  Not minimized.  **Zero visible windows.**

**Mechanisms that satisfy this rule:**
- Direct Node.js `spawn()` with `windowsHide: true` and `detached: true` — this translates to the Win32 `CREATE_NO_WINDOW` flag at process creation time.
- .NET `ProcessStartInfo.CreateNoWindow = $true` — same Win32 flag, used by the logon launcher script.
- `LaunchAgent` / XDG autostart — inherently windowless on POSIX.

**Mechanisms that are BANNED:**
- VBS `WshShell.Run` with window-style 0 — post-hoc hiding, not creation-time.
- `cmd.exe /c start /b` — unreliable, often flashes.
- `FindWindow` / `ShowWindow(SW_HIDE)` — post-hoc, always flashes.
- Any technique that creates a window and *then* hides it.

**How to verify (before accepting any PR):**
1. `browserpowers start` — no new window appears, port 4199 is listening.
2. `browserpowers restart` — no window at any point, daemon is back.
3. `browserpowers stop` — no window, port released.
4. Log-off, log-on — daemon starts with no window.
5. If ANY window appears for start/restart/stop or auto-start: **reject immediately.**

---

### 0.1 Userland only

The installer **must never require administrator rights**, never trigger UAC, and never write to protected system locations.

Allowed locations:
- `%USERPROFILE%\.browserpowers` on Windows
- `~/.browserpowers` on macOS/Linux
- Current-user registry keys on Windows
- User-scoped auto-start mechanisms

Prohibited locations:
- `C:\Program Files`, `C:\ProgramData`, `/usr/local`, `/Library/LaunchDaemons`, system-wide systemd services, or any path that requires elevation.

### 0.2 Distribution is the repo

The install procedure is:

```bash
git clone <repo>
cd BrowserExtC
node scripts/install.mjs
```

There is no requirement to publish to npm or ship a separate installer executable. The repository is the distribution mechanism.

### 0.3 One dedicated folder

All BrowserPowers runtime state lives under a single folder:

- Windows: `%USERPROFILE%\.browserpowers`
- macOS/Linux: `~/.browserpowers`

Core may run from the repository, but all install artifacts, CLI wrappers, logs, config, and platform state live inside the dedicated folder. No files are scattered in system directories.

### 0.4 Extension path is immutable

The unpacked extension is served from a single, fixed path that never changes:

```
~/.browserpowers/extension/
```

The browser is pointed at this path once during setup. The installer may swap the *contents* of this directory atomically, but the directory path itself must remain stable for the lifetime of the browser profile.

### 0.5 No visible daemon window

The daemon must run without any visible command-line window or terminal on any platform. The user must never see a window, flash, or taskbar button from the daemon or its auto-start mechanism.

This is a behavioral requirement. The implementation may use a native launcher, Task Scheduler, launchd, XDG autostart, or any other userland mechanism, provided the result is invisible.

### 0.6 VBS and console-subsystem wrappers are banned

On Windows, no VBScript, JScript, `WshShell.Run`, `cmd.exe /c start /b`, or any wrapper that tries to hide a console after it has been created.

If a Windows executable is used as part of the solution, it must itself be a Windows-subsystem executable, or it must be invoked through a mechanism that suppresses console creation from the start.

---

## 1. The Promise

Running `node scripts/install.mjs` (from the repo root) installs BrowserPowers end-to-end and registers it to start automatically on user logon.

When the script finishes, the user has only one manual step left:

> Open Chrome → `chrome://extensions/` → Developer mode ON → Load unpacked → select `~/.browserpowers/extension`

No manual daemon start. No restart. No babysitting. No checking whether it started.

---

## 2. Behavioral Install Flow

The script performs the following steps. The exact commands and file names are implementation details.

### 2.1 Stop any running old daemon

Before changing anything, the installer stops any process already listening on port `4199`. The wait for the port to become free is bounded.

### 2.2 Build artifacts

The script builds everything required to run:

- BrowserPowers core.
- Chrome MV3 unpacked extension.
- Firefox MV2 unpacked extension (if supported).

Dependency resolution is allowed but must be bounded.

### 2.3 Install artifacts to `~/.browserpowers/`

At minimum, the following must exist after install:

- `~/.browserpowers/extension/manifest.json`
- `~/.browserpowers/bin/browserpowers*` CLI entry points
- Any platform-specific files needed for auto-start

The Chrome extension is atomically swapped into place via a staging directory. The path `~/.browserpowers/extension/` is always valid: either the old version or the new version, never partial or missing.

### 2.4 Install the CLI tool

The script creates platform-appropriate wrappers so the following commands work from a shell:

```bash
browserpowers start
browserpowers stop
browserpowers restart
browserpowers serve
browserpowers list
browserpowers page read
browserpowers page act
```

### 2.5 Register hidden auto-start

The script registers the daemon to start automatically at user logon, on every supported platform, without requiring admin rights and without showing a window.

### 2.6 Start the daemon immediately

The script starts the daemon in the background before exiting, so the user does not need to run `browserpowers start` after install.

The daemon spawn must:
- Run detached from the installer.
- Have no stdio connection to the installer's terminal.
- Not block installer exit.

### 2.7 Exit cleanly

The installer is not a service. It must always return to the shell prompt.

---

## 3. Hard Requirements

### 3.1 Single script

Only one script is required to install BrowserPowers:

```bash
node scripts/install.mjs
```

No pre-steps. No post-steps (besides loading the unpacked extension in the browser).

### 3.2 Always exit

The installer **must always return to the shell prompt**. It never hangs, loops forever, or waits for the user to press Ctrl+C.

- No infinite loops.
- No unbounded polls.
- No waiting for user input.
- No retry loops.

#### 3.2.1 Hard 60-second cap

Total runtime is capped at **60 seconds**.

- A global timer starts at the beginning of execution.
- If 60 seconds elapse, the script prints a timeout error, cleans up partial state, and exits with code `124`.
- Every blocking external call uses a timeout no greater than 60 seconds.

### 3.3 Hidden daemon, hidden auto-start

Neither the daemon nor the auto-start mechanism may show a visible command-line window on any platform.

- No console window, taskbar button, or terminal flash.
- No persistence supervisor that the user can see or has to manage.

### 3.4 No manual start/restart

After the installer exits, the daemon is either already running or will start automatically on the next logon. The user must not need to run `browserpowers start` manually.

### 3.5 Idempotent CLI

The CLI commands have the following semantics:

- `browserpowers start` — idempotent. If the daemon is already running, it does nothing and succeeds.
- `browserpowers stop` — idempotent. If the daemon is already stopped, it does nothing and succeeds.
- `browserpowers restart` — force-kill the daemon if running, then start it fresh.
- `browserpowers serve` — run the daemon in the foreground in the current terminal.

---

## 4. Build-Time vs Exit-Time Guarantees

Acceptable build-time delays:
- Dependency resolution.
- WXT build for Chrome and Firefox.
- Core build/bundling.
- File copying.
- Waiting for port `4199` to be free after killing the old daemon (bounded).

Not acceptable:
- Any loop without a bounded iteration count.
- Any wait without a fixed duration or explicit timeout.
- Any operation that can hang indefinitely.
- Any state where the script has finished but does not call `process.exit()`.

### 4.1 Allowed bounded waits

| Wait | Bound | Purpose |
|---|---|---|
| Kill old daemon + free port | 10 × 500 ms = 5 s max | Ensure port `4199` is free. |
| External command timeouts | 60 s max | Bound any external command. |
| Daemon startup wait | 5 s fixed | Give the daemon time to start before the installer exits. |
| Global hard timeout | 60 s | Absolute cap on the entire installer. |

All waits are fixed-duration `setTimeout` calls or bounded `for` loops. No `while` loops.

---

## 5. Success Criteria

After running:

```bash
node scripts/install.mjs
```

The following must be true within 60 seconds and without manual intervention:

1. The script prints the "✅ BrowserPowers X.Y.Z installed" banner.
2. The script exits with code `0`.
3. The shell prompt returns.
4. `~/.browserpowers/extension/manifest.json` exists.
5. `~/.browserpowers/bin/browserpowers*` exist.
6. Port `4199` is listening (daemon is running).
7. No visible command-line window from the daemon or auto-start remains open.
8. The daemon is registered to start automatically on user logon for the current platform.
9. On macOS, `~/Library/LaunchAgents/com.browserpowers.plist` exists.
10. On Linux, `~/.config/autostart/browserpowers.desktop` exists.
11. On Windows, the daemon is registered in the current-user auto-start mechanism.

### 5.1 Stress criterion

Running the installer five times in a row must produce five successful exits, each within 60 seconds.

---

## 6. Failure Modes

| Scenario | Behavior |
|---|---|
| Build command hangs | 60 s per-call timeout fires; script prints error, cleans up, exits non-zero. |
| Global 60 s cap reached | Script prints timeout error, cleans up, exits `124`. |
| User presses Ctrl+C | SIGINT handler cleans up and exits `130`. |
| Daemon fails to start within 5 s | Script still exits after the fixed 5 s wait. Auto-start will retry on next logon; user can also run `browserpowers start`. |
| Old daemon refuses to die | Bounded kill wait completes; new daemon may fail to bind, but script still exits. |

In every failure mode the script **must exit**. The user must never need to manually terminate it.

---

## 7. User Manual Step

After the installer exits, the user does only this:

### Chrome

1. Navigate to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `~/.browserpowers/extension`.

### Firefox

1. Navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `~/.browserpowers/extension-firefox/manifest.json`.

That is the entire user interaction.

---

## 8. Implementation Notes

- The core runs from the repository (`core/`). `pnpm` 11 in a workspace context fails when copied outside the workspace, so the core is not copied to `~/.browserpowers/core/`.
- The extension is built in the repository and atomically swapped into `~/.browserpowers/extension/` via a staging directory.
- On Windows, the current implementation uses a user-scoped Task Scheduler task with the **Hidden** flag to suppress the daemon window. This is an implementation detail; the spec only requires the result (no visible window, userland auto-start).
- On macOS, the current implementation uses `~/Library/LaunchAgents/com.browserpowers.plist`.
- On Linux, the current implementation uses `~/.config/autostart/browserpowers.desktop`.
- `process.exit(0)` is called explicitly at the end of the install path.
- The global 60-second timer uses `.unref()` so it is only a kill switch, not a process keeper.

---

## 9. Prohibited Patterns

The installer must never contain:

- Unbounded `while` loops.
- Recursive calls without a base case.
- Unbounded polling.
- Network waits without a timeout.
- PM2, systemd system service, or any visible persistence supervisor.
- VBS, WScript, `WshShell.Run`, or any post-hoc window-hiding trick.
- `cmd.exe /c start /b` or any wrapper that leaves a visible/non-closable console attached to the daemon.
- Any prompt that requires the user to press a key or click a button.

---

## 10. Change Control

Any change to `scripts/install.mjs` must be validated against the behavioral requirements in this spec. A change that breaks single-script install, hidden auto-start, userland-only operation, or guaranteed exit is rejected.
