---
node_type: adr
title: "ADR-002 — page.cdp / page.net power tools + YOLO mode"
status: active
updated: 2026-09-30
tags: [adr, api-design, page-interaction, cdp, network, permissions]
links:
  depends_on: [../../overview/product.md, ../../spec/spec.md]
  part_of: [../INDEX.md]
---

# ADR-002 — page.cdp / page.net power tools + YOLO mode

## Status

Accepted (shipped in 1.7.0).

## Date

2026-09-29 – 2026-09-30

## Context

A real session automating a cloud-provider serial console (xterm-style terminal
over its own WebSocket) exposed five gaps: `press` silently degrading to
untrusted synthetic events widgets ignore, no way to issue a trusted keydown,
no visibility into page WebSockets/HTTP, stale-extension "Unknown tool"
confusion, and MCP help lagging the CLI. A dedicated automation browser also
needed a single "allow everything" switch that persists nothing.

## Decision

1. **`page.cdp`** — raw CDP passthrough (any method, no allowlist), gated via
   the existing `page.execute` group like `page_js`. Verdict `cdp.<method>`.
   Frame targeting rejected (same scope as `page.js`).
2. **`page.net`** — WS hooks (`ws_list`/`ws_send`/`ws_tail`) + HTTP
   observe/block (`http_observe`/`http_block`/`http_rules`/`http_unblock`)
   via a MAIN-world wrapper installed CSP-exempt with
   `chrome.scripting.executeScript ({ world: "MAIN" })`. Blocking is
   wrapper-level (fetch 403 short-circuit), never network-stack. Same
   `page.execute` gate — no new permission group.
3. **YOLO mode** — one extension-side boolean. While on, every
   `request_approval` auto-approves instantly and *nothing is persisted*
   (no site patterns, no session overrides, no permission writes), so
   turning it off restores the exact prior posture.
4. **Soft version-skew contract** — `extVersion` in register, `coreVersion`
   in the `registered` reply; unknown tool/action errors carry a "stale
   build — reload the extension" hint. The core never refuses old builds.

## Consequences

- New files: `extension/src/page-network.ts` (SW bookkeeping),
  `extension/src/net-hook-main.ts` (serializable MAIN-world hook).
- Live-verified on cloud.ru: strict-CSP `<script>` injection fails
  (`hooked:false`), `executeScript WORLD_MAIN` succeeds (`hooked:true`).
- `press` fallback now warns loudly (`isolated/fallbackKeyEvent` verdict +
  `isTrusted=false` message) instead of silent success.
- Spec tool count 11 → 15; page families three → five.
