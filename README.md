# BrowserPowers

![version](https://img.shields.io/badge/version-0.1.0--alpha-blue)

**Multi-browser LLM agent control** — a server + browser extension that gives AI agents direct, native control over browser tabs and pages.

> ⚠️ **Alpha** — 0.1.0. Working but evolving rapidly. APIs and configs may change without notice.

---

## Prerequisites

- **Node.js** >= 18
- **pnpm** >= 9

## Quick start

```bash
pnpm install
pnpm build
pnpm dev
```

> The build step (`pnpm build`) is required before `pnpm dev` to ensure extension output exists.

This starts both the core server (Hono REST + WebSocket + MCP) and the browser extension dev server in parallel.

> **Dev mode**: Use `pnpm run cli -- <command>` instead of `browserpowers <command>`.
> For full setup, follow the install script in `scripts/install.ts`.

## Project structure

```
├── core/          # Server — Hono, WebSocket, MCP, CLI
├── extension/     # WXT browser extension (Chrome & Firefox)
├── e2e/           # Playwright end-to-end tests
├── docs/          # Architecture docs, spec, ADRs
├── tasks/         # Project task tracking
├── playwright.config.ts
├── pnpm-workspace.yaml
└── vitest.workspace.ts
```

## Development commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run core + extension in parallel |
| `pnpm dev:core` | Run core server only |
| `pnpm dev:ext` | Run extension dev server |
| `pnpm build` | Build both packages |
| `pnpm test` | Run all tests |
| `pnpm test:core` | Run core unit tests |
| `pnpm test:ext` | Run extension unit tests |
| `pnpm test:e2e` | Run Playwright E2E tests |
| `pnpm clean` | Clean build output |

## Browser Extension Setup

### Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select the `extension/.output/chrome-mv3-dev/` directory

### Firefox

Firefox support is experimental via WXT. Build the extension and load it as a temporary add-on in `about:debugging`.

---

## Extension Permissions

The browser extension requires the following permissions for its operation:

| Permission | Reason |
|---|---|
| `tabs` | List, create, navigate, close tabs |
| `cookies` | Get, set, remove cookies |
| `history` | Search and delete browsing history |
| `bookmarks` | List, create, delete bookmarks |
| `downloads` | List and open downloads |
| `webRequest` | Observe network requests |
| `<all_urls>` | Execute page operations (inspect, click, fill) on any site |
| `storage` | Page localStorage access |

## Browser Identity

Browser names are auto-generated using an adjective-animal-hex pattern (e.g. "quick-fox-a3b2"). Names persist across restarts.

## Daemon Mode

The core runs as a background daemon. Use the `serve` command to start it:

```bash
browserpowers serve
```

A PID file can be written for process management:

```bash
browserpowers serve --pid-file ~/.browserpowers/daemon.pid
```

## License

MIT — see [LICENSE](LICENSE).
