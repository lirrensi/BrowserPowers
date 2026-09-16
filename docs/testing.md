# Testing — what to run, what it touches

## TL;DR

```bash
pnpm test:safe   # no browser, no network, nothing deleted — run anytime
pnpm test:live   # launches Edge in a temp profile + temp daemon home, tears it all down
```

## Layers

| Command | Needs browser? | Damaging? | What it proves |
| --- | --- | --- | --- |
| `pnpm test:safe` | No | No | vitest core+ext (mocked fs/chrome), eval manifests valid, skill documents CLI, eval cases contain no deletes |
| `pnpm test:core` / `pnpm test:ext` | No | No | Unit + integration with mocked `node:fs` / `chrome.*` |
| `pnpm eval` | No | No | Case manifests well-formed |
| `pnpm test:live` | Yes (Edge, auto-launched, temp profile) | No | Real daemon + real extension: navigate/inspect/snapshot/content/readable/tabs/screenshots/wheel/scroll_to/focus/blur/fill/visual_click/record/audit/request_help(timeout). Aborts if port 4199 busy — never touches your real daemon |
| `pnpm eval:smoke` | Yes (your own browser) | No | Same pages, manual setup |
| `pnpm test:manual` / `pnpm smoke` | Yes | No | Manual harnesses, same read-only pages |

Nothing in the automated suit calls `history.delete`, `bookmarks.delete`,
`downloads.open`, or `delete_all` — `test:safe` step 4/4 statically scans
`evals/browser/cases/` for those strings and fails if one appears.

Note: vitest path filters are workspace-root-relative — always run from the
repo root (`pnpm vitest run --project core tests/...`), never from `core/`.

## The steals and where they're tested

- Human/record gates always-allow + audit redaction + `BROWSERPOWERS_HOME` + help catalog → `core/tests/unit/steals.test.ts`
- Anchor generations (inspect replaces map, per-tab) → `extension/tests/unit/anchor-generations.test.ts`
- MCP tool surface incl. `request_help` + `record` → `core/tests/integration/mcp-server.test.ts`
- Skill ↔ CLI parity → `test:safe` step 3/4 greps `skill/browserpowers/SKILL.md` for the CLI table

## Live browser checks (opt-in)

```bash
pnpm dev            # core + extension dev servers
BP_BASE=http://127.0.0.1:4199/api pnpm eval:smoke
browserpowers doctor  # home/config/daemon/extension/skill/version
```
