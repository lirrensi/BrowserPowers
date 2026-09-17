---
name: browserpowers
description: |
  Use when the user asks to automate their real Chromium/Firefox browser: visit
  and read pages, fill forms, scrape data, click through flows, regression-test
  a PR's UI, validate a deployed page, or control tabs. Requires the
  BrowserPowers core server and browser extension.
---

# browserpowers

Use MCP tools (`browsers`, `tabs`, `screenshot`, `page_read`, `page_act`, `page_js`,
`cookies`, `windows`, `execute_all`, `execute_batch`, `help`) to work in the user's
**real, persistent browsers** — with their logins, cookies, extensions. This skill does
not install the extension. Never extract credentials, cookies, tokens, or other secrets.

Dedicated automation browser model: the user does NOT use the browser being automated.
Treat it as viewpoint-and-walk-away — no borrowing user tabs, no stealing focus unless needed.

## Before starting

1. `browsers` — find a connected browser. Prefer NAME, fall back to ID. Empty = extension not connected.
2. If daemon down (`status` fails, `/health` unreachable), tell user to run `browserpowers serve` / `npm run dev:core`, then load extension.
3. Check `help` once per session if unsure; every tool accepts `{ help: true }` for full params.

## CLI equivalents (humans, scripts, WSL)

Agents should prefer MCP tools (structured results, image blocks). Humans and
shell scripts should use the CLI — same core, same gates. Every row below does
the same thing. `bp` is shorthand for `browserpowers` (`bp status` = `browserpowers status`):

| MCP tool | CLI | Script (`BrowserPowersClient`) |
| --- | --- | --- |
| `browsers` | `browserpowers list` | `bp.listBrowsers()` |
| `tabs({ action: "list" })` | `browserpowers tabs <browser>` | `bp.tabsList(browser)` |
| `tabs({ action: "navigate", url })` | `browserpowers navigate <browser> <url>` | `bp.navigate(browser, url)` |
| `screenshot` | `browserpowers screenshot <browser> [filepath] [--overlay both] [--full-page] [--json]` | `bp.screenshot(browser)` / `bp.saveScreenshot(browser, path)` |
| `page_read({ action })` | `browserpowers page read <browser> <action> [key=value ...] [--json]` | `bp.pageRead(browser, action, params)` |
| `page_act({ action })` | `browserpowers page act <browser> <action> [key=value ...] [--json]` | `bp.pageAct(browser, action, params)` |
| `page_js({ code })` | `browserpowers exec <browser> page.js '{"code":"..."}'` | `bp.pageJs(browser, code)` |
| `cookies` / `windows` | `browserpowers exec <browser> cookies.list '{"url":"https://example.com"}'` (any tool works via `exec`) | `bp.execute(browser, tool, params)` (any tool) |
| `execute_all` | `browserpowers exec-all <tool> [json-params]` | `bp.executeAll(tool, params)` |
| `execute_batch` | REST `POST /api/execute-batch` (no CLI shorthand — use `exec` in a loop) | `bp.executeBatch([{ browser, tool, params }])` |
| `request_help` | `browserpowers request-help <browser> --prompt "..." [--url-contains ...]` | `bp.execute(browser, "human.requestHelp", { prompt, ... })` |
| `record` | `browserpowers record <browser> start\|stop\|status [--purpose ...] [--out trace.json]` | `bp.execute(browser, "record.start" \| "record.stop" \| "record.status", { ... })` |
| `help` | `browserpowers help [topic]` / `browserpowers help page.act click` | n/a (docs only) |
| approvals | `browserpowers approvals list` (approve/deny in extension popup) | n/a (human in popup) |
| health | `browserpowers status [--json]` / `browserpowers doctor [--json]` / `GET /api/health` | `bp.health()` / `bp.waitForBrowser(name)` |
| audit | `browserpowers audit list\|show <file>\|rm <file>` / `GET /api/audit` | n/a (use CLI/REST) |
| daemon | `browserpowers serve` (foreground) / `browserpowers stop` / `browserpowers init` / `browserpowers mcp-config --client claude\|cursor` | n/a (process lifecycle, not script calls) |

## Scripting — one import string, copy it every time

Resolve once (`bp sdk path` → `file:///.../sdk/client.js`), paste everywhere —
inline `-e` or any `.mjs` file, any folder. Triple slash on Windows,
`--input-type=module` for `-e`:
```bash
node --input-type=module -e "import { BrowserPowersClient } from 'file:///C:/Users/rx/.browserpowers/sdk/client.js'; const bp = new BrowserPowersClient(); console.log('health:', (await bp.health()).status);"
```
```js
import { BrowserPowersClient } from "file:///C:/Users/rx/.browserpowers/sdk/client.js";

const bp = new BrowserPowersClient(); // base + key from env
const browser = await bp.waitForBrowser("my-browser"); // ID or name
await bp.navigate(browser.id, "https://example.com");
const tree = await bp.pageRead(browser.id, "inspect", { limit: 30 });
if (!tree.success) throw new Error(`inspect failed: ${tree.error}`);
if (!tree.data?.success) throw new Error(`inspect not performed: ${tree.data?.message}`);
const anchors = tree.data?.data?.anchors ?? []; // ActionResult: check tree.success AND tree.data.success
const buttons = anchors.filter((a) => a.tag === "button");
const [content, meta] = await Promise.all([
  bp.pageRead(browser.id, "content"),
  bp.pageRead(browser.id, "meta"),
]);
await bp.saveScreenshot(browser.id, "./shot.png");
```

Starter: `node core/examples/quickstart.mjs [browser] [url]`. Env:
`BROWSERPOWERS_BASE` (or `BP_BASE`, or core-origin `BP_CORE`),
`BROWSERPOWERS_API_KEY` (or `BP_API_KEY`). `execute()` returns the
`{ success, data, error }` envelope — check `.success`, don't catch.
`executeBatch()` takes ID-or-name browsers, preserves order.

## Task workflow

1. Define success from user request. List browsers, then navigate:
   ```
   tabs({ action: "navigate", browser_name: "<name>", url: "https://example.com", snapshot: true })
   ```
2. Read before acting — always:
   ```
   page_read({ action: "inspect", browser_name: "<name>" })
   page_read({ action: "content", browser_name: "<name>" })
   page_read({ action: "meta", browser_name: "<name>" })
   ```
3. Act with fresh anchors from that inspection. Re-inspect after navigation or big DOM changes.
4. Stop when success visible — don't refresh/loop. `wait_for` once if needed, not polling.

Replace placeholders with real values. For unfamiliar flags, call tool with `{ help: true }` instead of guessing.

## Read and interact

Prefer `inspect` for controls + anchors (`a1`, `a2`...). Navigation invalidates anchors; large DOM changes stale them too.

| Need | Call |
| --- | --- |
| Click | `page_act({ action: "click", anchor: "a3" })` or `target: { text: "Save" }` |
| Fill | `page_act({ action: "fill", anchor: "a3", value: "text" })` — mismatch returns `FILL_VALUE_MISMATCH`, read field, correct diff only |
| Check | `page_act({ action: "check", anchor: "a3", checked: true })` |
| Select | `page_act({ action: "select_option", anchor: "a3", value: "option-value" })` |
| Press | `page_act({ action: "press", anchor: "a3", key: "Enter" })` / `keys: ["Control","a"]` |
| Type | `page_act({ action: "type", anchor: "a3", text: "hello", delay: 30 })` |
| Hover | `page_act({ action: "hover", anchor: "a3" })` — reveals menus, then re-inspect |
| Scroll to element | `page_act({ action: "scroll_to", anchor: "a3" })` — returns visible bounds (partial ok, not occlusion-tested) |
| Scroll page | `page_act({ action: "scroll", direction: "down", amount: 600 })` |
| Wheel (native) | `page_act({ action: "wheel", delta_y: 600 })` — at least one nonzero delta, echoed input not guaranteed distance |
| Focus / blur | `page_act({ action: "focus", anchor: "a3" })` / `page_act({ action: "blur" })` with CDP verification |
| Wait | `page_act({ action: "wait_for", anchor: "a3", condition: "visible", timeout_ms: 10000 })` |
| Fill form | `page_act({ action: "fill_form", fields: [{ anchor: "a1", value: "x" }] })` |
| Canvas click | `screenshot({ ref: "a3" })` → `capture_id`, then `page_act({ action: "visual_click", capture_id, image_x, image_y })` ORIGINAL PNG coords |

Targeting priority:
1. `target: { text: "Submit" }` — most stable, survives reloads
2. `anchor: "a7"` — fastest, single-use, invalidated on navigation
3. `target: { css: "#id" }` / `role`+`name` / `label` / `placeholder` / `testId`

- `select_option` uses option `value`, not visible label (pass `label` too if needed).
- `press` without target = global (e.g. `key: "Escape"`).
- `scroll` returns visible bounds; partial visibility suffices.
- Ambiguous target → refine, don't guess. Stale anchor → re-inspect once.

Use `readable` for article text (strips nav/ads), `full_html` (5MB cap) for exact markup, `html`/`attr`/`forms`/`count` for scoped reads. Don't start with HTML/images just to find ordinary controls.

### Large observations

`inspect` returns `generation` (bumps every inspect — whole ref map replaced), `totalCount`, `cursor`/`next_cursor`/`has_more`.
Use `limit` + `compact: true` (~60% smaller) + `max_tokens` budget for big pages:
```
page_read({ action: "inspect", limit: 20, compact: true })
page_read({ action: "inspect", cursor: "20" })  # @more continuation, same capture
page_read({ action: "snapshot", limit: 30 })   # static cheap tree alias
```
Rules: use refs from current page only (gen N), never older pages. Continuation reads same capture. New inspect/snapshot or navigation invalidates.

## Screenshots and visual grounding (WSL/host-safe)

`screenshot` returns BOTH a `filePath` (core temp dir) AND inline `base64` + `mimeType`.
When caller FS differs from core FS (Windows host ↔ WSL, VM, container), `filePath` may be unreadable — **use `base64`**.

```
screenshot({ browser_name: "<name>" })  # raw viewport PNG
screenshot({ browser_name: "<name>", overlay: "both", overlay_limit: 50 })
```

Overlay modes: `none` (raw) | `labels` (a1+tag) | `coords` (x,y) | `both` | `anchors_only` (boxes only).
Colors: button=blue, input=green, link=orange, select=purple.

To click what you see:
```
# 1. screenshot with overlay, read coords off image
# 2. click literal viewport coords (no resolution, no shadow walk)
page_act({ action: "click_at", x: 420, y: 160 })
page_act({ action: "dblclick_at", x: 420, y: 160 })
page_act({ action: "hover_at", x: 420, y: 160 })
# 3. canvas/element: screenshot ref → single-use capture_id (2m TTL, invalidated by re-inspect)
#    screenshot({ ref: "a3" }) → { capture_id, mapping, generation }
#    then ORIGINAL PNG coords:
page_act({ action: "visual_click", capture_id: "cap_...", image_x: 840, image_y: 320 })
```

`inspect` anchors also carry `boundingRect {x,y,width,height}` + `center {x,y}` — use these to compute coords without overlay.
Canvas-rendered UI (maps, games): screenshot first, never infer controls from nearby labels.

Full-page: `screenshot({ full_page: true })` attempts CDP `captureBeyondViewport`. Virtualized lists / nested scrollers unsupported — use `readable` + chunked `scroll` instead. No partial image on failure.

## Files, dialogs, JS

```
page_act({ action: "upload", anchor: "a3", file_data: "<base64>", file_name: "r.pdf", file_type: "application/pdf" })
# effect_state: committed|none|unknown — unknown means maybe-happened, don't blind retry
page_act({ action: "dialog_override" })  # then act, then
page_act({ action: "dialog_respond", response: { confirm: true } })
```

- Upload discloses file to site. `file_data` must be base64, ≤20MB lite. `file_data` must be base64.
- `page_js({ code: "..." })` is last resort, gated (`page.execute` default deny). Must return JSON-serializable. Never evaluate secrets.
- `cookies({ action: "list", url: "https://example.com" })`, `windows({ action: "list" })` for state.
- `console` / `runtime_status` for diagnostics; `network` via `network.requests` tool (200/tab ring).
- Record lite: `record({ action: "start", purpose: "checkout flow" })` → act → `record({ action: "stop" })` → trace.json (ops + last 10 states). Never banking/SSO/password-manager.
- Audit (redacted): `browserpowers audit list|show|rm` or `GET /api/audit`. Origin-only URLs, values redacted, 30d retention.
- Health: `browserpowers status --json`, `browserpowers doctor`, `GET /api/health`. See `docs/sandboxed-agents.md` for `BROWSERPOWERS_HOME` + WSL split.
- Evals: `npm run eval` (validate), `npm run eval:smoke` (needs browser). 5 core cases in `evals/browser/cases/core/`.

## Approvals and human steps

Default gates: `tabs/page.read/screenshots/human` allow, `page.act/cookies/windows` ask, `page.execute` deny. Site rules can override.

When `ask` hits:
1. Core queues approval, extension badges + popup shows Approve Once / Session / Forever / Reject.
2. CLI: `browserpowers approvals list`, approve in popup. Auto-denies in 60s. `status` shows pending count + stale heartbeat warning.
3. MCP async rejects `ask`-gated tools — use sync and let user approve.

When you hit login/CAPTCHA/OTP/payment/consent, or after 2 failed attempts — ask the human (no borrow, walk-away browser):
```
request_help({ prompt: "Please complete sign-in" })
request_help({ prompt: "Please solve CAPTCHA", completion_criteria: { url_contains: "/dashboard" } })
```
```bash
browserpowers request-help <browser> --prompt "Please complete sign-in" --url-contains /dashboard
```
Outcomes: `continued` (human clicked Continue) / `completed` (url criteria met) → re-inspect (refs stale). `cancelled`/`timed_out` → respect, don't repeat. Navigation alone ≠ completion.

## Errors and recovery

| Result | Next |
| --- | --- |
| Stale anchor (`ANCHOR_STALE`) | Re-inspect, retry once with fresh anchor |
| Ambiguous (`AMBIGUOUS_TARGET`) | Refine target, don't guess |
| Blocked (`OVERLAY_BLOCKED`) | Close modals/spinners, re-inspect |
| `CONTENT_SCRIPT_NOT_READY` | Wait for load, retry |
| `CDP_ATTACH_FAILED` | Close DevTools on tab, retry (auto-fallback to synthetic already tried) |
| Timeout / unknown effect | Inspect current state — action may have happened, don't blind retry |
| Unsupported | Use available caps; suggest update only if needed |

On unrecoverable failure, report blocker + evidence and stop. Continue independent work where possible.
