# Changelog

All notable changes to BrowserPowers are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.6.0] — 2026-09-18

Scripting, shorthand, locales, and npm — plus a small batch fix.

### Added
- **Node scripting client** (`core/src/client.ts`, zero deps): `import {
  BrowserPowersClient } from "./core/dist/client.js"` then sequence, filter
  in-process, and fan out with `Promise.all` — one import, many calls, no
  per-call subprocess churn. Starter: `node core/examples/quickstart.mjs
  [browser] [url]`. Anchors live at `result.data.data.anchors` (ActionResult
  inside the transport envelope — check both success flags). CLI/Script
  mapping tables in skill + README.
- **CLI shorthand `bp`** (`bp.cmd` / `bp.ps1` / `bp` / `bp.mjs` forward to the
  `browserpowers` wrappers — same commands, less typing). Installer writes
  them; banner, skill, README, `--help`, and spec mention it.
- **Extension UI i18n (en/de/es/fr/ru/zh/ar)**: popup + options render from
  `src/ui/i18n.ts` + `src/ui/locales.ts` (76 keys × 7 locales, full parity)
  with a Language picker (first settings card, persists to `bp:locale`,
  navigator fallback to `en`). Arabic flips `<html dir=rtl>`.
  Zero deps, no storage-schema or manifest changes.

### Fixed
- **REST `POST /api/execute-batch` now resolves browser names** like every
  other endpoint (previously only UUIDs worked — names silently became
  "Browser not found"). Accepts ID or name in `browserId | browser_id |
  browser | browser_name | browserName`.

### Changed
- **Package manager: pnpm → npm.** Plain `npm install` / `npm run build` /
  `npm test` from the repo root — no global pnpm, no global tsx (both were
  hard prerequisites that bit on fresh machines). npm workspaces
  (`core` + `extension`) replace `pnpm-workspace.yaml`; `install.mjs` checks
  `npm >= 10` and resolves local tsx from `node_modules`. All scripts, docs,
  skill, and templates updated. Installer + daemon probe `core/node_modules`
  first, fall back to hoisted root `node_modules` (npm layout). Verified:
  `npm run build` (tsc + WXT), `npm run test:safe` green (74 core + 32 ext +
  5 eval cases).

## [1.5.0] — 2026-09-17

Agent skill, human-loop, observation/interaction depth, and a two-layer test
story — all verified live against a real Edge (`pnpm test:live` 17/17).

### Added
- **Agent skill** (`skill/browserpowers/SKILL.md`): workflow, text-first
  targeting, WSL-safe screenshot rules, approvals, human steps, error recovery —
  plus a full **CLI equivalents table** (every MCP tool mapped to its
  `browserpowers` command).
- **Human-loop, no borrow** (`request_help`, `human.helpStatus`): OS
  notification with Continue/Cancel, `completion_criteria` URL auto-complete,
  `continued/completed/cancelled/timed_out` envelopes. Termination-proof by
  design — the extension answers pending immediately and the core polls on its
  own clock, so service-worker restarts mid-wait can't strand the agent.
  CLI: `browserpowers request-help`.
- **Observation hardening**: per-tab ref generations (every inspect replaces the
  map), `cursor`/`next_cursor` continuation, `max_tokens` budget, `snapshot`
  cheap-tree alias.
- **Interaction hardening**: native `wheel`, element-only `scroll_to` with
  visible bounds, verified `focus`/`blur`, honest `FILL_VALUE_MISMATCH`
  (read-and-correct-diff, never blind refill).
- **Canvas clicks** (`visual_click` + `capture_id`): single-use screenshot-bound
  clicks in ORIGINAL PNG coords with generation guards.
- **Screenshots**: MCP returns filePath AND inline image (WSL/host-split safe),
  `overlay`/`full_page`/`ref` passthrough, CDP renderer fallback for readback
  failures.
- **Record lite** (`record start|stop|status`, CLI + MCP): redacted op buffer +
  VOM states → `trace.json`; refuses banking/SSO/password-manager pages.
- **Audit read API** (redacted by construction): `GET/DELETE /api/audit`,
  `browserpowers audit list|show|rm`, origin-only URLs, 30-day retention.
- **Test story**: `pnpm test:safe` (mocked, no browser, plus a static
  non-destructive scan) and `pnpm test:live` (isolated daemon + temp Edge
  profile + localhost fixtures, 17 cases, auto-teardown).
  `BROWSERPOWERS_HOME` shared-home override, `browserpowers doctor`,
  `docs/testing.md`, `docs/sandboxed-agents.md`.
- Shipped `icon-128.png` notification/extension icon (`pnpm icon` regenerates it).

### Changed
- `page.read` actions: `snapshot`; `page.act` actions: `scroll_to`, `wheel`,
  `focus`, `blur`, `visual_click`; `screenshot`: `ref`, `full_page`.
- `status` shows heartbeat staleness, pending approvals, uptime, `--json`.
- Extension capabilities: `human.*`, `record.*`; new `human`/`record` gate groups.

### Fixed
- **Route errors swallowed**: `routeExecute` now surfaces ActionResult
  `message` + `[errorCode]` instead of "success:false with no error message".
- **Inspect zeroed every anchor map**: a value-level `|` (bitwise OR) where a
  type-level `| undefined` belonged coerced the anchor array to `0` — found by
  live test, not mocks.
- **Anchor selectors that match nothing**: placeholder/text-targeted anchors
  got synthetic `[data-bp-anchor=...]` selectors no page ever sets. Content now
  returns a working `cssPath` per anchor (`#id` wins, else nth-of-type chain).
- **Approval/human notifications never appeared**: referenced icon file never
  shipped and data-URL icons are rejected by Chromium — now a real PNG.
- Housekeeping from COMPLAINTS.md (not committed): dropped the deprecated
  `pnpm.onlyBuiltDependencies` (already covered by `allowBuilds`; warning gone),
  documented workspace-root-relative vitest filters; `get-port` already declared.

## [1.4.0] — 2026-08-24

### Fixed
- **MCP multi-session crash.** The MCP endpoint built a single shared `McpServer` and
  called `connect()` for every new client. SDK v1 threw `"Already connected"` on the
  second session, so all sessions after the first returned HTTP 500 until a process
  restart. Affected every MCP client that connected more than once or reconnected after
  dropping a session.
- **Version drift.** The MCP server and CLI reported `1.0.0` regardless of the
  published version. Both now read the version from `package.json`.

### Changed
- **MCP SDK v2.** Migrated from `@modelcontextprotocol/sdk` (v1) to the v2 packages
  (`@modelcontextprotocol/server` / `@modelcontextprotocol/client`, 2.0.0).
- **Stateless per-request serving.** The MCP endpoint now uses
  `createMcpHandler(buildMcpServer)`, which constructs a fresh server instance per HTTP
  request. There are no sessions or transport state between requests, so concurrent and
  sequential clients can never collide on a shared connection.
- **Legacy client compatibility.** 2025-era protocol clients (e.g. Claude Desktop,
  Cursor) are still served via the SDK's default `legacy: 'stateless'` posture. Their
  `initialize` handshake completes normally; legacy `GET` (SSE stream) and `DELETE`
  (session teardown) answer `405`, which is spec-sanctioned — BrowserPowers never
  emitted server-initiated notifications anyway.
- **Node engine.** Minimum Node.js raised to `>=20` (v2 requirement).

### Added
- Regression tests in `core/tests/integration/mcp-server.test.ts`: two sequential full
  client sessions both complete (handshake + `listTools` + `callTool`), and a
  `2025-06-18` initialize handshake is verified to negotiate successfully.

## [1.3.0]
- See git history for prior releases.
