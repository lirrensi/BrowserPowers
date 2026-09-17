# BrowserPowers

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blueviolet?style=flat-square" alt="Version 1.6.0" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/chrome-supported-success?style=flat-square" alt="Chrome Supported" />
  <img src="https://img.shields.io/badge/firefox-experimental-orange?style=flat-square" alt="Firefox Experimental" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square" alt="Node >= 18" />
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

## Key Features

| | |
|---|---|
| **Multi-Browser** | Connect any number of real browsers (Chrome, Firefox, etc.) to one core. Each is an independent identity with its own permissions and configuration. |
| **Permission Gates** | Per-browser permissions with simple global controls for browser powers and site-pattern controls for page powers. Allow, ask, or deny — you stay in control. |
| **MCP-First** | Full Model Context Protocol server — agents in Claude Desktop, Cursor, and any MCP client can command your browsers directly. |
| **REST API** | HTTP endpoints for browser management and tool execution — integrate from any language. |
| **CLI** | `browserpowers list`, `browserpowers navigate`, `browserpowers screenshot`, `browserpowers page read` — scriptable from your terminal. |
| **Real Browsers** | Not a headless simulacrum. Your actual logged-in sessions, cookies, extensions, and bookmarks — available to your agents. |
| **Observability** | Every command, every result, every error is logged. You can always see what happened and when. |

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
### Page Interaction Syntax

The CLI supports smart target detection for page operations:

```bash
# Read a page
browserpowers page read "my-chrome" inspect              # Inspect interactable elements
browserpowers page read "my-chrome" content              # Get full page text
browserpowers page read "my-chrome" meta                 # Page metadata (OG, title, etc.)

# Interact with a page
browserpowers page act "my-chrome" click target=#submit-btn      # Click by CSS selector
browserpowers page act "my-chrome" click "text:Save"             # Click by text
browserpowers page act "my-chrome" fill target=#email value=hi@example.com  # Fill form field

# Shorthand selectors — auto-detected:
#   "#id"       → CSS selector
#   ".class"    → CSS selector
#   "[attr]"    → CSS selector
#   "text:..."  → text content match
#   bare text   → text content match
```

### Scripting — one import string, copy it every time

Step 1 — resolve the string once (stash it in your notes):
```bash
bp sdk path
# C:\Users\rx\.browserpowers\sdk  →  your import string is:
# file:///C:/Users/rx/.browserpowers/sdk/client.js
```
Same path on every script, every folder, every drive session — the installer
owns it, the repo is deletable, nothing to `npm install`.

Step 2 — paste it into any script, inline or file:
```bash
node --input-type=module -e "import { BrowserPowersClient } from 'file:///C:/Users/rx/.browserpowers/sdk/client.js'; const bp = new BrowserPowersClient(); console.log('health:', (await bp.health()).status);"
```
```js
// any .mjs file, any folder — same string
import { BrowserPowersClient } from "file:///C:/Users/rx/.browserpowers/sdk/client.js";
const bp = new BrowserPowersClient();
const browser = await bp.waitForBrowser("my-browser"); // ID or name
await bp.navigate(browser.id, "https://example.com");
```
Windows tax: triple slash (`file:///C:/...`), and `-e` needs
`--input-type=module` for `import` to parse.

### Scripting from Node (longer scripts)

Same import string, grown up:

```js
import { BrowserPowersClient } from "file:///C:/Users/rx/.browserpowers/sdk/client.js";

const bp = new BrowserPowersClient(); // base + key from env, see below
const browser = await bp.waitForBrowser("my-browser"); // ID or name
await bp.navigate(browser.id, "https://example.com");

// Read, then filter in-process — one round trip, not one per element.
// data is the ActionResult: anchors at result.data.data.anchors, check both success flags.
const tree = await bp.pageRead(browser.id, "inspect", { limit: 30 });
if (!tree.success) throw new Error(`inspect failed: ${tree.error}`);
if (!tree.data?.success) throw new Error(`inspect not performed: ${tree.data?.message}`);
const anchors = tree.data?.data?.anchors ?? [];
const buttons = anchors.filter((a) => a.tag === "button");
console.log(`inspect: ${anchors.length} anchors (${buttons.length} buttons)`);

// Parallel fan-out: both reads in flight under one await.
const [content, meta] = await Promise.all([
  bp.pageRead(browser.id, "content"),
  bp.pageRead(browser.id, "meta"),
]);

// Batch across browsers, order preserved. Screenshot straight to disk.
const results = await bp.executeBatch([
  { browser: "alpha", tool: "page.read", params: { action: "content" } },
  { browser: "beta", tool: "page.read", params: { action: "content" } },
]);
await bp.saveScreenshot(browser.id, "./shot.png", { overlay: "none" });
```

<!-- What it prints (real run shape):
core: http://127.0.0.1:4199/api
browser: quick-fox-a3b2 (b-1)
inspect: 14 anchors (3 buttons)
  a1 <button> Save
content: 1823 chars of JSON
meta: {"title":"Example Domain",...}
screenshot: ./shot.png
-->

Starter script: `node core/examples/quickstart.mjs [browser] [url]`.

Env (same names the harnesses already use): `BROWSERPOWERS_BASE` (or
`BP_BASE`, or core-origin `BP_CORE`), `BROWSERPOWERS_API_KEY` (or `BP_API_KEY`).
`execute()` returns the `{ success, data, error }` envelope — check
`.success`, don't catch. `executeBatch()` takes ID-or-name browsers and
preserves order. Full API: `core/src/client.ts`.

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
| `screenshot` | Capture a screenshot of the active tab |
| `tabs` | List and navigate browser tabs |
| `page_read` | Read page content (inspect, text, html, meta, forms, etc.) |
| `page_act` | Interact with page elements (click, fill, check, etc.) |
| `page_js` | Execute arbitrary JavaScript (gated escape hatch) |
| `cookies` | Get, set, remove, and list cookies |
| `windows` | List, create, focus, and close browser windows |
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
| `page.execute` | Execute arbitrary JavaScript on the page | deny |
| `screenshots` | Capture visible tab screenshots | allow |
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
