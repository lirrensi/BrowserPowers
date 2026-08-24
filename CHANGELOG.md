# Changelog

All notable changes to BrowserPowers are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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
