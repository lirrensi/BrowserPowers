# BrowserPowers

<p align="center">
  <img src="https://img.shields.io/badge/version-1.8.0-blueviolet?style=flat-square" alt="Version 1.8.0" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/chrome-supported-success?style=flat-square" alt="Chrome Supported" />
  <img src="https://img.shields.io/badge/firefox-experimental-orange?style=flat-square" alt="Firefox Experimental" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square" alt="Node >= 18" />
</p>
<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">中文版</a>
</p>
<p align="center">
  <img src="assets/browserpowers_cat.jpeg" alt="BrowserPowers Cat" />
</p>

<p align="center">
  <strong>Multi-browser AI agent control</strong> — a central command server that lets AI agents<br />
  control your <em>real browsers</em> via MCP, REST, or CLI.
</p>

<p align="center">
  <em>Not a headless simulacrum. Your actual Chrome, your actual Firefox,<br />
  with your actual logged-in sessions, extensions, and cookies.</em>
  
</p>

<p align="center">
  <b>One browser, two, or a thousand (I dare you)</b>
</p>

<p align="center">
  Alternative to proprietary extensions from closedAI and Misanthropic.
</p>

---

## What is BrowserPowers?

BrowserPowers is a **client-server system** that bridges AI agents with your real, persistent browsers.

Instead of ephemeral headless browser automation (Playwright, Puppeteer, Selenium), each of your real browsers runs a **lightweight extension** that connects to a central **core server** over WebSocket. Agents interact with the core via MCP, REST, or CLI — and every command executes inside a real browser you can see, touch, and trust.

```
┌──────────────────────────────────────────────────┐
│                   Core Server                     │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │  MCP    │  │  REST    │  │  CLI (Commander) │  │
│  │  Server │  │  (Hono)  │  │                  │  │
│  └────┬────┘  └────┬─────┘  └────────┬────────┘  │
│       │            │                 │           │
│       └──────┬─────┴─────────────────┘           │
│              │                                    │
│       ┌──────▼──────┐                             │
│       │  Command    │                             │
│       │  Service    │                             │
│       └──────┬──────┘                             │
│              │                                    │
│       ┌──────▼──────┐  ┌──────────────────┐      │
│       │  Registry   │  │  Gates/Perms     │      │
│       └──────┬──────┘  └──────────────────┘      │
│              │                                    │
│       ┌──────▼──────┐                             │
│       │  WebSocket  │                             │
│       │  Server     │                             │
│       └──────┬──────┘                             │
└──────────────┼────────────────────────────────────┘
               │  WebSocket (JSON)
     ┌─────────┼──────────┐
     │         │          │
┌────▼───┐ ┌──▼────┐ ┌──▼────┐
│ Chrome │ │Firefox│ │  ...  │
│ Ext.   │ │ Ext.  │ │ Ext.  │
└────────┘ └───────┘ └───────┘
  Real browser   Real browser
```

---

## What it can do

Everything below runs against your **real, logged-in browsers** — tabs, sessions, cookies, extensions included. Agents drive it through MCP; humans and shell scripts use the CLI against the same core; scripts use one vendored SDK import.

### 📑 Tabs — many browsers, many tabs

List, open, navigate, go back/forward, close. Every command takes a browser name or ID, and names persist across restarts (`quick-fox-a3b2`). One core fans out to any number of browsers — run the same check on all of them at once (`exec-all`), or batch different jobs across browsers in parallel (`execute_batch`).

### 👀 Read the page — inspect, text, articles, markup

`inspect` returns the interactable tree with anchor IDs (`a1`, `a2`…) — the fast path for everything else. Then `content` (visible text), `readable` (article text, nav/ads stripped), `meta` (title, OG tags), `forms` (fields + state), `attr`/`html`/`text` (scoped reads), `full_html` (whole document), `select` (current selection), `summary`/`count`/`frames`, plus `console` and `runtime_status` for diagnostics. Anchors go stale on navigation — re-inspect, retry once.

### 🖱️ Drive the page — click to canvas, forms to uploads

Click, fill, check, select, press keys, type, hover, scroll (element or page), native wheel, focus/blur, submit, wait-for conditions, whole-form fill, file upload, drag, double-click — by visible text (survives reloads), anchor ID (fastest), CSS/role/label/placeholder, even inside shadow DOM. Canvas-rendered UI (maps, games, xterm): screenshot with overlay, read coords off the image, `click_at` literal viewport pixels.

### 📸 See the page — screenshots that survive WSL

Viewport PNG, full-page via CDP, or anchor overlays (`labels`/`coords`/`both` — IDs and x,y painted on). Returns both a core-side `filePath` and inline `base64`, so WSL/VM/container callers that can't read the core's disk still get the image.

### 🌐 Escape hatches — JS, CDP, network

`page_js` runs arbitrary JS (gated, last resort, must return JSON). `page_cdp` passes any CDP method straight through (trusted key events into xterm/canvas that ignore synthetic input). `page_net` hooks page WebSockets (list/tail/send keystrokes into a serial console) and observes/blocks HTTP by pattern. These live behind `page.execute` (default deny) — the core never grants itself more than you allow.

### 🍪 Browser state — cookies, windows, history, bookmarks, storage

Cookies (get/set/remove/list per URL), windows (list/create/focus/close, incognito included), history search + delete, bookmarks list/create/delete, downloads list/open, localStorage get/set, network-request ring buffer. Your sessions stay yours — agents borrow the view, never the keys (credentials and secrets are never extracted).

### 🙋 Human in the loop — help, approvals, annotations

Stuck on login/CAPTCHA/OTP? The agent asks *you* (`request_help` → OS notification → Continue/Cancel), then re-inspects. Sensitive tools pause on `ask` gates — approve once/session/forever in the popup, auto-deny in 60s, or flip YOLO mode on a throwaway automation browser. And **annotations** (v1.8): you click `Annotate element` or drag `Region screenshot` in the page, type a note, and it piles up on the core per browser+tab until the agent reads and clears it — human-first bug reports with cropped screenshots.

### 📼 Record, audit, health

`record` turns a session into a trace.json textbook (ops + page states, banking/SSO excluded). The audit log keeps redacted history (origin-only URLs, values stripped, 30d). `status`/`doctor` tell you daemon health, browser heartbeats, and what's misconfigured.

### 🛠️ Three ways to drive it

MCP (Claude Desktop, Cursor, any MCP client at `/mcp`), REST (`/api` from any language), CLI (`browserpowers …`, `bp` shorthand) — all hitting the same gates, same browsers. For example:

```bash
browserpowers list                                  # browsers online
browserpowers navigate "my-chrome" https://example.com
browserpowers page read "my-chrome" inspect        # interactable tree
browserpowers page act "my-chrome" click "text:Save"
browserpowers screenshot "my-chrome" ./shot.png
```

Full command surface, flags, and scripting (one SDK import, parallel fan-out) live in [CLI Reference](#cli-reference) and [Scripting](#scripting) below. `browserpowers help <topic>` (or any MCP tool with `{ help: true }`) is the in-terminal manual.

---

## Quick Start (Development)

Get the core server and extension running in development mode:

```bash
# Prerequisites: Node.js >= 20 (npm ships with it, >= 10)
npm install
npm run build     # builds both core and extension
npm run dev       # runs core server + extension dev server in parallel
```

The core server starts on `http://127.0.0.1:4199` with:
- **REST API** at `/api`
- **MCP endpoint** at `/mcp`
- **WebSocket** at `/ws`

Use `npm run cli -- <command>` instead of `browserpowers <command>` during development.

> For **production installation** (daemon mode, auto-start, PATH setup), see the [Production Installation](#production-installation) section below.

---

## Production Installation

A permanent installation — daemon mode, auto-start on boot, CLI on PATH.

### 0. Clone

```bash
git clone https://github.com/lirrensi/BrowserPowers.git
cd BrowserPowers
```

### 1. Prerequisites

The install script checks these for you. If anything is missing, it tells you exactly what to install.

- **Node.js** >= 20 (npm >= 10 ships with it — no separate install)
- **tsx** (local to the repo — `npm install` provides it, no global install)

### 2. Install

```bash
node scripts/install.mjs
```

This copies everything to `~/.browserpowers/`, installs dependencies, builds the extension for Chrome and Firefox, puts `browserpowers` on your PATH, **and registers `browserpowers start` to run at every logon** (HKCU Run key on Windows, LaunchAgent on macOS, XDG autostart on Linux).

> **That's it.** The core server is already running on `http://127.0.0.1:4199`. You can go straight to loading the extension and connecting your MCP clients.

### 3. Add to PATH (if needed)

The installer prints the path. If `browserpowers` isn't found in your terminal, add `~/.browserpowers/bin` to your PATH:

<details>
<summary><b>Windows</b></summary>

```powershell
[Environment]::SetEnvironmentVariable("Path",
  "$env:USERPROFILE\.browserpowers\bin;$env:Path",
  "User")
```

Or: System Properties → Advanced → Environment Variables → User PATH.
</details>

<details>
<summary><b>macOS / Linux</b></summary>

Add to your shell config (`~/.zshrc`, `~/.bashrc`, or `~/.profile`):

```bash
export PATH="$PATH:$HOME/.browserpowers/bin"
```

Then reload: `source ~/.zshrc` (or restart your terminal).
</details>

### 4. Load the Extension

Open your browser and load the built extension:

**Chrome:** `chrome://extensions` → Developer mode → Load unpacked → select `~/.browserpowers/extension/`

**Firefox (experimental):** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `~/.browserpowers/extension-firefox/manifest.json`

### 5. Verify Connection

Click the extension icon in your browser toolbar. The popup shows:
- **Browser name** — auto-generated (e.g. `quick-fox-a3b2`), editable
- **Status** — should say **Connected** to `ws://127.0.0.1:4199/ws`

If it shows "Disconnected", check the server is running:

- **Any platform:** `browserpowers status` — if the API responds, the daemon is up. If not, run `browserpowers start`.
- **Windows:** the installer writes an HKCU Run key. Inspect with `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v BrowserPowers`
- **macOS:** `launchctl list | grep browserpowers`
- **Linux:** `cat ~/.config/autostart/browserpowers.desktop`


From the terminal, confirm the browser registered:

```bash
browserpowers list
```

You should see your browser listed with its capabilities.

### 6. Connect MCP

Configure your AI agent client to talk to the core:

```bash
browserpowers mcp-config --client claude
# or
browserpowers mcp-config --client cursor
```

Paste the output into your client's MCP config file. See the [MCP Integration](#mcp-integration) section for details.

> If you enabled API key authentication (below), add the `Authorization` header to the MCP snippet:
> ```json
> "headers": { "Authorization": "Bearer <your-api-key>" }
> ```

### 7. Enable API Key Authentication (Optional)

By default the server is open to anything on `127.0.0.1`. To lock it down with an API key:

Set `auth.apiKey` in `~/.config/browserpowers/config.yaml`:

```yaml
auth:
  apiKey: "your-secret-key"
```

Then restart the daemon:

```bash
browserpowers restart
```

That's it — same on every platform. It kills whatever is on port 4199, then runs `browserpowers start` again.

Once enabled, all REST, MCP, and WebSocket connections require the key:

- **REST / MCP** — pass via `Authorization: Bearer <key>` header or `X-API-Key` header
- **CLI** — reads the key from config automatically, no extra setup
- **Extension** — the popup has an API Key field; set it to match or the extension won't connect
- **MCP clients** — add `"headers": { "Authorization": "Bearer <key>" }` to the client config

To disable, set `apiKey` to an empty string (`""`) and restart.

### Update

```bash
cd BrowserPowers
git pull
node scripts/install.mjs
```

### Uninstall

```bash
node scripts/install.mjs --uninstall
```

---

## Browser Extension Setup

### Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select the output folder:
   - **Development**: `extension/.output/chrome-mv3-dev/`
   - **Production** (after `install.mjs`): `~/.browserpowers/extension/`

### Firefox (Experimental)

1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the built manifest:
   - **Development**: `extension/.output/firefox-mv2/manifest.json`
   - **Production**: `~/.browserpowers/extension-firefox/manifest.json`

> Firefox support via WXT is experimental.

### Extension Configuration

Once loaded, click the extension icon to open the popup. You can:
- Set a friendly browser name (auto-generated initially)
- Configure the core WebSocket URL (default: `ws://127.0.0.1:4199/ws`)
- Set permission levels per capability group (Allow / Ask / Deny)
- Configure site-specific rules for page tools
- Toggle approval notifications

---

## CLI Reference

`bp` is shorthand for `browserpowers` — every command below works with either.

```bash
browserpowers serve                        # Start the core server (foreground, default)
browserpowers start                        # Start the daemon detached, then exit
                                            #   (same command the OS runs at logon)
browserpowers restart                      # Stop the running daemon, then start a fresh one
browserpowers status                       # Check daemon status and connected browsers
browserpowers list                         # List all connected browsers
browserpowers init                         # Interactive first-time setup wizard

# Browser Control
browserpowers navigate <browser> <url>     # Navigate a browser to a URL
browserpowers screenshot <browser> [file]  # Take a screenshot (optionally save to file)
browserpowers content <browser> [css]      # Get page text content
browserpowers select <browser>             # Get selected text
browserpowers tabs <browser>               # List all tabs
browserpowers disconnect <browser>         # Disconnect a browser

# Page Interaction (v2 API)
browserpowers page read <browser> <action> [params...]   # Read page content
browserpowers page act <browser> <action> [params...]    # Interact with the page

# Read Actions: inspect, content, text, html, attr, meta, forms, count, select, summary
# Act Actions:  click, fill, check, select_option, press, scroll, submit, wait_for, type

# Advanced
browserpowers exec <browser> <tool> [params]             # Execute any tool
browserpowers exec-all <tool> [params]                   # Execute on ALL browsers
browserpowers capabilities <browser>                     # List browser capabilities
browserpowers approvals list                             # List pending approval requests
browserpowers mcp-config --client <name>                 # Generate MCP config snippet
browserpowers config show                                # Print current configuration
browserpowers config path                                # Show config file location
```

Same surface as a script — one import, many calls, parallel fan-out:

| CLI | Script (`BrowserPowersClient`) |
| --- | --- |
| `browserpowers list` | `bp.listBrowsers()` |
| `browserpowers tabs <browser>` | `bp.tabsList(browser)` |
| `browserpowers navigate <browser> <url>` | `bp.navigate(browser, url)` |
| `browserpowers screenshot <browser> [file]` | `bp.screenshot(browser)` / `bp.saveScreenshot(browser, path)` |
| `browserpowers page read <browser> <action>` | `bp.pageRead(browser, action, params)` |
| `browserpowers page act <browser> <action>` | `bp.pageAct(browser, action, params)` |
| `browserpowers exec <browser> <tool>` | `bp.execute(browser, tool, params)` (any tool) |
| `browserpowers exec-all <tool>` | `bp.executeAll(tool, params)` |
| `POST /api/execute-batch` | `bp.executeBatch([{ browser, tool, params }])` |
| `browserpowers request-help <browser>` | `bp.execute(browser, "human.requestHelp", { prompt })` |
| `browserpowers status` | `bp.health()` / `bp.waitForBrowser(name)` |

> **Dev mode**: Use `npm run cli -- <command>` instead of `browserpowers <command>`.

## How you control a browser

One mental model, three scopes. Everything below is the same over MCP, CLI, and REST — pick the surface, keep the verbs.

**1. Browser scope — which browser, which tab.** Commands take a browser name or ID (`quick-fox-a3b2` survives restarts). `list` shows who's online; `tabs` lists tabs; `navigate` opens or steers; `exec-all` runs one tool everywhere; `execute_batch` runs different jobs in parallel.

**2. Page scope — see, then touch.** Always read before acting: `page read … inspect` returns the anchor tree, then `page act` clicks/fills/types against it. Targeting, most-stable first: visible text (`"text:Save"`, survives reloads) → anchor ID (`a7`, fastest, single-use) → CSS/role/label/placeholder → shadow-DOM path. Re-inspect after navigation or big DOM changes; what the inspector misses, you ground visually (screenshot with overlay → `click_at` pixels).

```bash
browserpowers page read "my-chrome" inspect              # interactable tree
browserpowers page read "my-chrome" readable              # article text
browserpowers page act "my-chrome" click "text:Save"       # click by text
browserpowers page act "my-chrome" fill target=#email value=hi@example.com
# Shorthand: "#id"/".class"/"[attr]" → CSS, "text:…" or bare text → text match
```

**3. Trust scope — gates decide what runs.** Every tool sits in a group (`tabs`, `page.read`, `page.act`, `page.execute`, `screenshots`, `cookies`, `windows`, …). Each browser profile says `allow` (runs), `ask` (popup approval: once/session/forever, auto-deny 60s), or `deny` (blocked). Page tools add site-pattern overrides (`*`, `example.com`, `*.example.com`). Defaults: reading is allowed, acting asks, JS/CDP/network are denied. [Permission System](#permission-system) has the full table.

The human side of trust: `request_help` pings you for login/CAPTCHA/OTP (Continue/Cancel, then the agent re-inspects); **annotations** flip it around — you annotate elements or drag region screenshots in the page, notes pile up per browser+tab, the agent reads and clears when told.

## Scripting

One import string, copy it everywhere (`bp sdk path` prints your real path — paste what it prints):

```js
import { BrowserPowersClient } from "file:///C:/Users/<you>/.browserpowers/sdk/client.js";
const bp = new BrowserPowersClient(); // base + key from env
const browser = await bp.waitForBrowser("my-browser"); // ID or name
await bp.navigate(browser.id, "https://example.com");
const tree = await bp.pageRead(browser.id, "inspect", { limit: 30 });
await bp.saveScreenshot(browser.id, "./shot.png");
```

Windows tax: triple slash (`file:///C:/...`), and `-e` needs `--input-type=module`. Starter: `node core/examples/quickstart.mjs [browser] [url]`. Env: `BROWSERPOWERS_BASE` (or `BP_BASE`), `BROWSERPOWERS_API_KEY` (or `BP_API_KEY`). `execute()` returns `{ success, data, error }` — check `.success`, don't catch. Full API: `core/src/client.ts`.

---

## MCP Integration

> **Important:** The core server must be **running** before your MCP client can connect.
> If you ran the install script, the native service is already running it.
> If you're in development mode, start it with `npm run dev` (or `npm run dev:core`).

```
http://127.0.0.1:4199/mcp
```

### Claude Desktop

```bash
browserpowers mcp-config --client claude
```

Paste the output into your Claude Desktop MCP config file.

### Cursor

```bash
browserpowers mcp-config --client cursor
```

### Generic MCP Client

```json
{
  "mcpServers": {
    "browserpowers": {
      "url": "http://127.0.0.1:4199/mcp"
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `browsers` | List all connected browsers with capabilities and status |
| `screenshot` | Capture a screenshot of the active tab (overlay, full-page) |
| `tabs` | List, navigate, go back/forward, close tabs |
| `page_read` | Read page content (inspect, content, readable, meta, forms, …) |
| `page_act` | Interact with page elements (click, fill, type, scroll, …) |
| `page_js` | Execute arbitrary JavaScript (gated escape hatch) |
| `page_cdp` | Raw CDP passthrough (any method, gated like `page_js`) |
| `page_net` | Observe/drive page network (WS hooks, HTTP observe/block) |
| `cookies` | Get, set, remove, and list cookies |
| `windows` | List, create, focus, and close browser windows |
| `request_help` | Ask the human to complete an in-page step |
| `record` | Record ops into a trace.json textbook |
| `annotations` | Read/clear human page annotations (element notes + screenshots) |
| `execute_all` | Execute a tool on ALL connected browsers simultaneously |
| `execute_batch` | Execute multiple tools across browsers in parallel |
| `help` | Get the full system reference |

---

## Permission System

Every tool belongs to a **permission group**. Each browser has a permission profile that controls which groups are allowed, denied, or require approval.

### Permission Levels

| Level | Behavior |
|-------|----------|
| `allow` | Tool execution proceeds immediately |
| `deny` | Tool execution is blocked with an error |
| `ask` | Tool execution pauses; the extension shows a badge. You approve or deny via the popup. |

### Tool Groups

| Group | What it controls | Default |
|-------|-----------------|---------|
| `tabs` | List, create, navigate, close tabs | allow |
| `page.read` | Read page content (inspect, text, html, meta) | allow |
| `page.act` | Interact with page elements (click, fill, etc.) | ask |
| `page.execute` | Arbitrary JS, raw CDP, page network hooks | deny |
| `screenshots` | Capture visible tab screenshots | allow |
| `human` | Human-in-the-loop prompts (never gated — it *is* the human step) | allow |
| `history.read` | Search browsing history | allow |
| `history.delete` | Delete browsing history | ask |
| `bookmarks.read` | List bookmarks | allow |
| `bookmarks.modify` | Create bookmarks | ask |
| `bookmarks.delete` | Delete bookmarks | ask |
| `downloads` | List and open downloads | ask |
| `cookies` | Get, set, remove, list cookies | ask |
| `network` | Observe network requests | ask |
| `storage` | Read/write page localStorage | ask |
| `windows` | List, create, focus, close windows | ask |

> `record` and `annotations` aren't browser-gated — the core stores them locally without touching the browser, so no permission applies.

You can configure permissions:
- **In the extension popup** — per browser, per group
- **Site-level rules** — for page tools, set domain-specific overrides (`*`, `example.com`, `*.example.com`)
- **In `~/.config/browserpowers/config.yaml`** — default and per-browser permissions

### The Approval Flow

When a tool hits an `ask` gate:

1. The core sends a `request_approval` message to the extension
2. The extension sets a yellow badge (•) on its icon
3. You open the popup, see the pending request, and choose:
   - **Approve Once** — just this one time
   - **Approve Session** — allow for this browser session
   - **Approve Forever** — save as permanent permission
   - **Reject** — deny this request
4. If you don't respond within 60 seconds, the request auto-denies

---

## Configuration

The core server reads configuration from `~/.config/browserpowers/config.yaml`. It is created automatically on first run with sensible defaults.

**Key configuration options:**

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `4199` | Server port |
| `host` | `127.0.0.1` | Bind address |
| `mcp.enabled` | `true` | Enable MCP endpoint |
| `rest.enabled` | `true` | Enable REST API |
| `gates.defaultPermission` | `"ask"` | Default permission for unconfigured tools |
| `gates.approvalTimeoutMs` | `60000` | How long to wait for user approval |
| `queue.maxDepth` | `50` | Max queued requests per browser |
| `queue.defaultTimeoutMs` | `120000` | Per-request timeout |
| `browsers` | `{}` | Pre-registered browser configs with names and permissions |
| `auth.apiKey` | `""` (empty) | API key for server authentication. Empty = no auth. Set to any string to require it on all REST, MCP, and WebSocket connections. |

---

## Project Structure

```
BrowserPowers/
├── core/                  # Node.js server
│   ├── src/
│   │   ├── adapters/      # MCP, REST, CLI adapters
│   │   ├── command-service/ # Command execution pipeline
│   │   ├── gates/         # Permission gate middleware
│   │   ├── client.ts      # Zero-dep Node REST client (scripts: import + sequence)
│   │   ├── config.ts      # YAML config loader
│   │   ├── registry.ts    # Connected browser registry
│   │   ├── server.ts      # Hono HTTP server
│   │   ├── ws-server.ts   # WebSocket server
│   │   └── index.ts       # Entry point
│   ├── examples/
│   │   └── quickstart.mjs # Starter script (node core/examples/quickstart.mjs [browser] [url])
│   └── tests/             # Unit tests
├── extension/             # WXT browser extension
│   ├── entrypoints/       # Background, popup, options, content
│   ├── src/
│   │   ├── v2/            # Page interaction modules (read, act, js)
│   │   ├── ws-client.ts   # WebSocket client
│   │   ├── capability-router.ts # chrome.* API routing
│   │   └── ui/            # Shared popup/options UI
│   └── tests/
├── docs/                  # Architecture docs, spec, ADRs
├── e2e/                   # Playwright end-to-end tests
├── scripts/
│   ├── install.mjs        # One-shot production install script
│   └── bp.py              # Python CLI helper
└── playwright.config.ts
```

---

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Run core + extension in parallel |
| `npm run dev:core` | Run core server only |
| `npm run dev:ext` | Run extension dev server |
| `npm run dev:ext:chrome` | Run extension dev server (Chrome) |
| `npm run dev:ext:firefox` | Run extension dev server (Firefox) |
| `npm run build` | Build both packages |
| `npm test` | Run all tests |
| `npm run test:core` | Run core unit tests |
| `npm run test:ext` | Run extension unit tests |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run clean` | Clean build output |

---

## Design Principles

1. **Real browsers, always.** No headless proxies, no HTML-to-text pipelines. The browser extension is the browser API bridge.
2. **Identities, not sessions.** Each browser is a first-class participant with its own configuration, permissions, and history.
3. **Permission gates at the browser.** The core never bypasses a browser's permission profile — the extension enforces locally what it exposes.
4. **Observability by default.** Every command, every result, every error is logged at the core. You can always see what happened and when.
5. **One protocol to rule them.** MCP is the primary interface for agents. REST and CLI exist for scripting and debugging.

---

## Why Not Just Playwright / Puppeteer?

| | Playwright / Puppeteer | BrowserPowers |
|---|---|---|
| **Browser** | Ephemeral, headless | Your real browser |
| **Sessions** | None — fresh every time | Your logged-in sessions persist |
| **Extensions** | Limited support | Full extension support |
| **Cookies** | None by default | Your actual cookies |
| **Multi-browser** | Possible but complex | Built-in, first-class |
| **Permissions** | None | Per-browser, per-group gates |
| **Agent Interface** | Scripting API only | MCP, REST, CLI |

BrowserPowers is **not** a replacement for Playwright/Puppeteer in CI/CD. If you need ephemeral browser automation for testing, use the tools built for that. BrowserPowers is for persistent, real-user browsers that your AI agents can command.

---

## Browser Identity

Each connected browser receives a unique auto-generated name using an **adjective-animal-hex** pattern (e.g. `quick-fox-a3b2`). Names persist across restarts and can be customized in the extension popup.

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  Made with 🐱 by <a href="https://github.com/lirrensi">lirrensi</a>
</p>
