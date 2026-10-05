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
  <strong>多浏览器 AI 智能体控制</strong>——中央命令服务器，让 AI 智能体<br />
  通过 MCP、REST 或 CLI 控制你<em>真实的浏览器</em>。
</p>

<p align="center">
  <em>不是无头仿真。是你真正的 Chrome、真正的 Firefox，<br />
  带着你真实的登录态、扩展和 Cookie。</em>
</p>

<p align="center">
  <b>一个浏览器、两个，或一千个（你敢吗）</b>
</p>

---

## BrowserPowers 是什么？

BrowserPowers 是一个**客户端-服务器系统**，把 AI 智能体和你真实、持久的浏览器连起来。

每个浏览器运行一个**轻量扩展**，通过 WebSocket 连到中央**核心服务器**。智能体经由 MCP、REST 或 CLI 与核心交互——每条命令都在你看得见、摸得着、信得过的真实浏览器里执行。而不是一次性的无头自动化（Playwright、Puppeteer、Selenium）。

```
┌──────────────────────────────────────────────────┐
│                   Core Server（核心服务器）         │
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
  真实浏览器   真实浏览器
```

---

## 它能做什么

下面所有能力都跑在你**真实、已登录的浏览器**上——标签页、会话、Cookie、扩展都在。智能体走 MCP 驱动；人和 shell 脚本走 CLI（同一个核心）；脚本用一个内置 SDK import。

### 📑 标签页——多浏览器、多标签页

列出、打开、导航、前进/后退、关闭。每条命令接受浏览器名或 ID，名称重启后保留（`quick-fox-a3b2`）。一个核心扇出到任意数量的浏览器——对所有浏览器同时执行同一检查（`exec-all`），或跨浏览器并行跑不同任务（`execute_batch`）。

### 👀 读页面——检查、文本、文章、源码

`inspect` 返回带锚点 ID（`a1`、`a2`……）的可交互树——其他一切的快速通道。然后是 `content`（可见文本）、`readable`（正文抽取，去导航/广告）、`meta`（标题、OG 标签）、`forms`（字段+状态）、`attr`/`html`/`text`（局部读取）、`full_html`（整个文档）、`select`（当前选中）、`summary`/`count`/`frames`，还有 `console` 和 `runtime_status` 做诊断。导航后锚点失效——重新 inspect，重试一次。

### 🖱️ 操作页面——从点击到画布，从表单到上传

点击、填充、勾选、下拉、按键、输入、悬停、滚动（元素或整页）、原生滚轮、聚焦/失焦、提交、等待条件、整表单填充、文件上传、拖拽、双击——按可见文本定位（重启后依然有效）、锚点 ID（最快）、CSS/role/label/placeholder，甚至 shadow DOM 内部。Canvas 渲染的 UI（地图、游戏、xterm）：带标注截图、从图上读坐标、`click_at` 按视口像素点。

### 📸 看页面——WSL 下也能用的截图

视口 PNG、CDP 整页截图，或锚点标注（`labels`/`coords`/`both`——把 ID 和 x,y 画在图上）。同时返回核心侧 `filePath` 和内联 `base64`，WSL/虚拟机/容器里读不到核心磁盘时也能拿到图。

### 🌐 逃生舱——JS、CDP、网络

`page_js` 跑任意 JS（需授权、最后手段、必须返回 JSON）。`page_cdp` 直通任意 CDP 方法（给无视合成事件的 xterm/canvas 发可信按键）。`page_net` 挂钩页面 WebSocket（查看/发送，比如往串口终端敲键）和按模式观察/拦截 HTTP。这些都在 `page.execute` 门后（默认拒绝）——核心拿不到你没给过的权限。

### 🍪 浏览器状态——Cookie、窗口、历史、书签、存储

Cookie（按 URL 读/写/删/列）、窗口（列出/创建/聚焦/关闭，含无痕）、历史搜索+删除、书签列出/创建/删除、下载列出/打开、localStorage 读写、网络请求环形缓冲。会话永远是你的——智能体只借视图，不碰钥匙（口令与密钥从不提取）。

### 🙋 人在回路——求助、审批、标注

登录/CAPTCHA/OTP 卡住了？智能体找*你*（`request_help` → 系统通知 → 继续/取消），然后重新 inspect。敏感工具走 `ask` 门——在弹窗里一次/会话/永久批准，60 秒无应答自动拒绝，或在一次性自动化浏览器上开 YOLO 模式。而**标注**（v1.8）反过来：你在页面里点`🎯 Annotate element` 或拖 `📷 Region screenshot`、写一句话，备注按浏览器+标签页堆在核心上，等智能体来读、来清——带裁剪截图的人类 bug 单。

### 📼 录制、审计、健康

`record` 把一次会话变成 trace.json 教科书（操作+页面状态，银行/SSO 页面除外）。审计日志保留脱敏历史（只有域名、值已抹去，30 天）。`status`/`doctor` 告诉你守护进程健康度、浏览器心跳和配置问题。

### 🛠️ 三种驾驶方式

MCP（Claude Desktop、Cursor、任意 MCP 客户端，连 `/mcp`）、REST（任意语言调 `/api`）、CLI（`browserpowers …`，`bp` 是简写）——同一套门、同一批浏览器。例如：

```bash
browserpowers list                                  # 在线浏览器
browserpowers navigate "my-chrome" https://example.com
browserpowers page read "my-chrome" inspect        # 可交互树
browserpowers page act "my-chrome" click "text:Save"
browserpowers screenshot "my-chrome" ./shot.png
```

完整命令、参数和脚本（一个 SDK import、并行扇出）见下面的 [CLI 参考](#cli-参考)和[脚本](#脚本)。`browserpowers help <topic>`（或任意 MCP 工具传 `{ help: true }`）就是内置手册。

---

## 快速开始（开发模式）

```bash
# 前提：Node.js >= 20（npm 自带，>= 10）
npm install
npm run build     # 构建核心 + 扩展
npm run dev       # 并行跑核心服务器 + 扩展开发服务器
```

核心服务器起在 `http://127.0.0.1:4199`：
- **REST API** 在 `/api`
- **MCP 端点**在 `/mcp`
- **WebSocket** 在 `/ws`

开发时用 `npm run cli -- <command>` 代替 `browserpowers <command>`。

> **生产安装**（守护进程、开机自启、PATH）见下面的[生产安装](#生产安装)。

---

## 生产安装

一次性安装——守护进程、开机自启、CLI 进 PATH。

### 0. 克隆

```bash
git clone https://github.com/lirrensi/BrowserPowers.git
cd BrowserPowers
```

### 1. 前提

安装脚本会自动检查，缺什么会明确告诉你：

- **Node.js** >= 20（npm >= 10 自带，不用另装）
- **tsx**（仓库本地就有，`npm install` 提供，不用全局装）

### 2. 安装

```bash
node scripts/install.mjs
```

这会把一切复制到 `~/.browserpowers/`、装依赖、构建 Chrome/Firefox 扩展、把 `browserpowers` 放进 PATH，**并注册每次登录自动运行 `browserpowers start`**（Windows 是 HKCU Run 键，macOS 是 LaunchAgent，Linux 是 XDG autostart）。

> **结束。**核心服务器已经跑在 `http://127.0.0.1:4199`。直接去装扩展、连 MCP 客户端就行。

### 3. 加 PATH（如需要）

安装程序会打印路径。如果终端里找不到 `browserpowers`，把 `~/.browserpowers/bin` 加进 PATH：

<details>
<summary><b>Windows</b></summary>

```powershell
[Environment]::SetEnvironmentVariable("Path",
  "$env:USERPROFILE\.browserpowers\bin;$env:Path",
  "User")
```

或：系统属性 → 高级 → 环境变量 → 用户 PATH。
</details>

<details>
<summary><b>macOS / Linux</b></summary>

加进 shell 配置（`~/.zshrc`、`~/.bashrc` 或 `~/.profile`）：

```bash
export PATH="$PATH:$HOME/.browserpowers/bin"
```

然后重载：`source ~/.zshrc`（或重启终端）。
</details>

### 4. 加载扩展

打开浏览器加载构建好的扩展：

**Chrome：** `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `~/.browserpowers/extension/`

**Firefox（实验性）：** `about:debugging#/runtime/this-firefox` → 临时加载附加组件 → 选 `~/.browserpowers/extension-firefox/manifest.json`

### 5. 验证连接

点浏览器工具栏里的扩展图标，弹窗显示：
- **浏览器名**——自动生成（如 `quick-fox-a3b2`），可改
- **状态**——应为**已连接** `ws://127.0.0.1:4199/ws`

如果显示"未连接"，检查服务器是否在跑：

- **任意平台：** `browserpowers status`——API 有响应就是守护进程活着。不行就 `browserpowers start`。
- **Windows：** 安装程序写了 HKCU Run 键。用 `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v BrowserPowers` 查看
- **macOS：** `launchctl list | grep browserpowers`
- **Linux：** `cat ~/.config/autostart/browserpowers.desktop`

终端里确认浏览器已注册：

```bash
browserpowers list
```

应该能看到你的浏览器及其能力。

### 6. 连接 MCP

配置 AI 客户端连核心：

```bash
browserpowers mcp-config --client claude
# 或
browserpowers mcp-config --client cursor
```

把输出贴进客户端的 MCP 配置文件。细节见 [MCP 集成](#mcp-集成)。

> 如果开了 API key 鉴权（见下），MCP 配置里加 header：
> ```json
> "headers": { "Authorization": "Bearer <your-api-key>" }
> ```

### 7. 开 API Key 鉴权（可选）

默认服务器对 `127.0.0.1` 上的任何程序开放。要加 API key 锁死：

在 `~/.config/browserpowers/config.yaml` 里设 `auth.apiKey`：

```yaml
auth:
  apiKey: "your-secret-key"
```

然后重启守护进程：

```bash
browserpowers restart
```

就这些，全平台一样。先杀掉 4199 上的旧进程，再 `browserpowers start`。

开启后，REST、MCP、WebSocket 全要 key：

- **REST / MCP**——`Authorization: Bearer <key>` 或 `X-API-Key` header
- **CLI**——自动从配置读 key，不用额外设置
- **扩展**——弹窗里有 API Key 输入框，填一样否则连不上
- **MCP 客户端**——配置里加 `"headers": { "Authorization": "Bearer <key>" }`

要关掉，把 `apiKey` 设为空字符串（`""`）再重启。

### 更新

```bash
cd BrowserPowers
git pull
node scripts/install.mjs
```

### 卸载

```bash
node scripts/install.mjs --uninstall
```

---

## 浏览器扩展安装

### Chrome

1. 打开 `chrome://extensions`
2. 打开**开发者模式**（右上角开关）
3. 点**加载已解压的扩展程序**
4. 选输出目录：
   - **开发**：`extension/.output/chrome-mv3-dev/`
   - **生产**（`install.mjs` 之后）：`~/.browserpowers/extension/`

### Firefox（实验性）

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点**临时载入附加组件**
3. 选构建好的 manifest：
   - **开发**：`extension/.output/firefox-mv2/manifest.json`
   - **生产**：`~/.browserpowers/extension-firefox/manifest.json`

> WXT 的 Firefox 支持是实验性的。

### 扩展配置

装好后点扩展图标开弹窗，可以：
- 起个顺眼的浏览器名（初始自动生成）
- 配核心 WebSocket 地址（默认 `ws://127.0.0.1:4199/ws`）
- 按能力组设权限（允许 / 询问 / 拒绝）
- 给页面工具配站点规则
- 开关审批通知

---

## CLI 参考

`bp` 是 `browserpowers` 的简写——下面每条两种写法都行。

```bash
browserpowers serve                        # 前台启动核心服务器（默认）
browserpowers start                        # 后台启动守护进程后退出（开机自启跑的也是它）
browserpowers restart                      # 停掉再起一个新的
browserpowers status                       # 守护进程状态 + 已连浏览器
browserpowers list                         # 列出所有已连浏览器
browserpowers init                         # 交互式首次配置向导

# 浏览器控制
browserpowers navigate <browser> <url>     # 导航到 URL
browserpowers screenshot <browser> [file]  # 截图（可存文件）
browserpowers content <browser> [css]      # 取页面文本
browserpowers select <browser>             # 取选中文本
browserpowers tabs <browser>               # 列出所有标签页
browserpowers disconnect <browser>         # 断开浏览器

# 页面交互（v2 API）
browserpowers page read <browser> <action> [params...]   # 读页面
browserpowers page act <browser> <action> [params...]    # 操作页面

# 读操作：inspect, content, readable, meta, forms, attr, html, text, full_html, select, summary, count, frames
# 写操作：click, fill, check, select_option, press, type, scroll, hover, submit, wait_for, upload, drag, click_at

# 高级
browserpowers exec <browser> <tool> [params]             # 跑任意工具
browserpowers exec-all <tool> [params]                   # 在所有浏览器上跑
browserpowers capabilities <browser>                     # 列浏览器能力
browserpowers approvals list                             # 列出待审批请求
browserpowers mcp-config --client <name>                 # 生成 MCP 配置片段
browserpowers config show                                # 打印当前配置
browserpowers config path                                # 显示配置文件位置
```

> **开发模式**：用 `npm run cli -- <command>` 代替 `browserpowers <command>`。

## 怎么控制浏览器

一个心智模型，三个层次。MCP、CLI、REST 共用同一套动词——换界面，不换说法。

**1. 浏览器层——哪个浏览器、哪个标签页。**命令接受浏览器名或 ID（`quick-fox-a3b2` 重启后还在）。`list` 看谁在线；`tabs` 列标签页；`navigate` 打开或跳转；`exec-all` 一处下发；`execute_batch` 并行跑不同任务。

**2. 页面层——先看，再动手。**永远先读后写：`page read … inspect` 拿锚点树，再 `page act` 点/填/输。定位按稳定度排序：可见文本（`"text:Save"`，重载后有效）→ 锚点 ID（`a7`，最快，一次性）→ CSS/role/label/placeholder → shadow DOM 路径。导航或大改 DOM 后重新 inspect；检查器漏掉的东西就视觉定位（带标注截图 → `click_at` 像素点）。

```bash
browserpowers page read "my-chrome" inspect              # 可交互树
browserpowers page read "my-chrome" readable              # 正文
browserpowers page act "my-chrome" click "text:Save"       # 按文本点
browserpowers page act "my-chrome" fill target=#email value=hi@example.com
# 简写："#id"/".class"/"[attr]" → CSS，"text:…"或裸文本 → 文本匹配
```

**3. 信任层——门决定跑什么。**每个工具属于一个组（`tabs`、`page.read`、`page.act`、`page.execute`、`screenshots`、`cookies`、`windows`……）。每个浏览器档案写 `allow`（直接跑）、`ask`（弹窗审批：一次/会话/永久，60 秒无应答自动拒绝）或 `deny`（拦掉）。页面工具再加站点模式（`*`、`example.com`、`*.example.com`）。默认：读允许、动作文问、JS/CDP/网络拒绝。完整表格见[权限系统](#权限系统)。

信任的人性面：`request_help` 在登录/CAPTCHA/OTP 时 ping 你（继续/取消，然后智能体重新 inspect）；**标注**反过来——你在页面里标元素或拖区域截图、写一句话，备注按浏览器+标签页堆着，智能体被告知后来读、来清。

## 脚本

一个 import 字符串，到处复制（`bp sdk path` 打印你的真实路径——贴它打印的）：

```js
import { BrowserPowersClient } from "file:///C:/Users/<你>/.browserpowers/sdk/client.js";
const bp = new BrowserPowersClient(); // base + key 来自环境变量
const browser = await bp.waitForBrowser("my-browser"); // ID 或名
await bp.navigate(browser.id, "https://example.com");
const tree = await bp.pageRead(browser.id, "inspect", { limit: 30 });
await bp.saveScreenshot(browser.id, "./shot.png");
```

Windows 税：三斜杠（`file:///C:/...`），`-e` 需要 `--input-type=module`。入门脚本：`node core/examples/quickstart.mjs [browser] [url]`。环境变量：`BROWSERPOWERS_BASE`（或 `BP_BASE`），`BROWSERPOWERS_API_KEY`（或 `BP_API_KEY`）。`execute()` 返回 `{ success, data, error }`——查 `.success`，别 try/catch。完整 API：`core/src/client.ts`。

---

## MCP 集成

> **重要：** MCP 客户端连之前，核心服务器必须**先跑起来**。
> 跑过安装脚本的话，原生服务已经在跑了。
> 开发模式用 `npm run dev`（或 `npm run dev:core`）启动。

```
http://127.0.0.1:4199/mcp
```

### Claude Desktop

```bash
browserpowers mcp-config --client claude
```

把输出贴进 Claude Desktop 的 MCP 配置文件。

### Cursor

```bash
browserpowers mcp-config --client cursor
```

### 通用 MCP 客户端

```json
{
  "mcpServers": {
    "browserpowers": {
      "url": "http://127.0.0.1:4199/mcp"
    }
  }
}
```

### 可用 MCP 工具

| 工具 | 说明 |
|------|-------------|
| `browsers` | 列出所有已连浏览器及其能力和状态 |
| `screenshot` | 截当前标签页（可标注、可整页） |
| `tabs` | 列出、导航、前进/后退、关闭标签页 |
| `page_read` | 读页面（inspect、content、readable、meta、forms……） |
| `page_act` | 操作页面元素（点击、填充、输入、滚动……） |
| `page_js` | 执行任意 JavaScript（需授权的逃生舱） |
| `page_cdp` | CDP 直通（任意方法，门限同 `page_js`） |
| `page_net` | 观察/驱动页面网络（WS 挂钩、HTTP 观察/拦截） |
| `cookies` | Cookie 读、写、删、列 |
| `windows` | 窗口列出、创建、聚焦、关闭 |
| `request_help` | 请人来完成页内一步（登录/验证） |
| `record` | 把操作录成 trace.json 教科书 |
| `annotations` | 读/清人类页面标注（元素备注+截图） |
| `execute_all` | 在所有浏览器上同时执行一个工具 |
| `execute_batch` | 跨浏览器并行执行多个工具 |
| `help` | 完整系统参考 |

---

## 权限系统

每个工具属于一个**权限组**。每个浏览器有一份权限档案，决定各组是允许、拒绝还是要审批。

### 权限级别

| 级别 | 行为 |
|-------|----------|
| `allow` | 直接执行 |
| `deny` | 拦掉并报错 |
| `ask` | 暂停执行；扩展图标打标。你在弹窗里批准或拒绝。 |

### 工具组

| 组 | 管什么 | 默认 |
|-------|-----------------|---------|
| `tabs` | 标签页列出、创建、导航、关闭 | allow |
| `page.read` | 读页面（inspect、text、html、meta） | allow |
| `page.act` | 操作页面元素（点击、填充等） | ask |
| `page.execute` | 任意 JS、CDP 直通、页面网络挂钩 | deny |
| `screenshots` | 截可见标签页 | allow |
| `human` | 人在回路提示（永不设门——它本身就是人的那一步） | allow |
| `history.read` | 搜浏览历史 | allow |
| `history.delete` | 删浏览历史 | ask |
| `bookmarks.read` | 列书签 | allow |
| `bookmarks.modify` | 建书签 | ask |
| `bookmarks.delete` | 删书签 | ask |
| `downloads` | 列出并打开下载 | ask |
| `cookies` | Cookie 读、写、删、列 | ask |
| `network` | 看网络请求 | ask |
| `storage` | 读写页面 localStorage | ask |
| `windows` | 窗口列出、创建、聚焦、关闭 | ask |

> `record` 和 `annotations` 不经过浏览器门——核心本地存，不碰浏览器，所以不需要权限。

配置方式：
- **扩展弹窗里**——按浏览器、按组设
- **站点规则**——给页面工具设域名覆盖（`*`、`example.com`、`*.example.com`）
- **`~/.config/browserpowers/config.yaml`**——默认和按浏览器的权限

### 审批流程

工具撞上 `ask` 门时：

1. 核心给扩展发 `request_approval` 消息
2. 扩展图标打黄标（•）
3. 你打开弹窗，看到待办，选：
   - **批准一次**——仅这一次
   - **批准本次会话**——这次浏览器会话内有效
   - **始终批准**——存成永久权限
   - **拒绝**——拦掉这次
4. 60 秒不理，自动拒绝

---

## 配置

核心服务器从 `~/.config/browserpowers/config.yaml` 读配置。首次运行自动创建，默认值即合理值。

**关键配置项：**

| 键 | 默认 | 说明 |
|-----|---------|-------------|
| `port` | `4199` | 服务器端口 |
| `host` | `127.0.0.1` | 绑定地址 |
| `mcp.enabled` | `true` | 开 MCP 端点 |
| `rest.enabled` | `true` | 开 REST API |
| `gates.defaultPermission` | `"ask"` | 未配置工具的默认权限 |
| `gates.approvalTimeoutMs` | `60000` | 等人审批多久 |
| `queue.maxDepth` | `50` | 每个浏览器最多排队多少请求 |
| `queue.defaultTimeoutMs` | `120000` | 单请求超时 |
| `browsers` | `{}` | 预注册浏览器（名+权限） |
| `auth.apiKey` | `""`（空） | 服务器鉴权 key。空=不鉴权。设任意字符串则 REST、MCP、WebSocket 全要它。 |

---

## 项目结构

```
BrowserPowers/
├── core/                  # Node.js 服务器
│   ├── src/
│   │   ├── adapters/      # MCP、REST、CLI 适配器
│   │   ├── command-service/ # 命令执行管线
│   │   ├── gates/         # 权限门中间件
│   │   ├── client.ts      # 零依赖 Node REST 客户端（脚本：import + 序列调用）
│   │   ├── config.ts      # YAML 配置加载
│   │   ├── registry.ts    # 已连浏览器注册表
│   │   ├── server.ts      # Hono HTTP 服务器
│   │   ├── ws-server.ts   # WebSocket 服务器
│   │   └── index.ts       # 入口
│   ├── examples/
│   │   └── quickstart.mjs # 入门脚本（node core/examples/quickstart.mjs [browser] [url]）
│   └── tests/             # 单元测试
├── extension/             # WXT 浏览器扩展
│   ├── entrypoints/       # Background、popup、options、content
│   ├── src/
│   │   ├── v2/            # 页面交互模块（read、act、js）
│   │   ├── ws-client.ts   # WebSocket 客户端
│   │   ├── capability-router.ts # chrome.* API 路由
│   │   └── ui/            # popup/options 共用 UI
│   └── tests/
├── docs/                  # 架构文档、spec、ADR
├── e2e/                   # Playwright 端到端测试
├── scripts/
│   ├── install.mjs        # 一键生产安装脚本
│   └── bp.py              # Python CLI 小助手
└── playwright.config.ts
```

---

## 开发命令

| 命令 | 说明 |
|---------|-------------|
| `npm run dev` | 并行跑核心 + 扩展 |
| `npm run dev:core` | 只跑核心服务器 |
| `npm run dev:ext` | 跑扩展开发服务器 |
| `npm run dev:ext:chrome` | 跑扩展开发服务器（Chrome） |
| `npm run dev:ext:firefox` | 跑扩展开发服务器（Firefox） |
| `npm run build` | 构建两个包 |
| `npm test` | 跑所有测试 |
| `npm run test:core` | 跑核心单元测试 |
| `npm run test:ext` | 跑扩展单元测试 |
| `npm run test:e2e` | 跑 Playwright E2E 测试 |
| `npm run clean` | 清构建产物 |

---

## 设计原则

1. **永远是真浏览器。**不要无头替身，不要 HTML 转文本管线。浏览器扩展就是浏览器 API 桥。
2. **身份，不是会话。**每个浏览器都是一等参与者，有自己的配置、权限和历史。
3. **门设在浏览器。**核心永远绕不过浏览器的权限档案——扩展在本地执行它暴露的东西。
4. **默认可观测。**核心记录每条命令、每个结果、每个错误。发生过什么、什么时候，永远可查。
5. **一个协议走天下。**MCP 是智能体的主界面。REST 和 CLI 为脚本和调试而存在。

---

## 为什么不用 Playwright / Puppeteer？

| | Playwright / Puppeteer | BrowserPowers |
|---|---|---|
| **浏览器** | 一次性、无头 | 你真正的浏览器 |
| **会话** | 没有——每次全新 | 登录态一直都在 |
| **扩展** | 支持有限 | 完整扩展支持 |
| **Cookie** | 默认没有 | 你真正的 Cookie |
| **多浏览器** | 能做但复杂 | 内置、一等 |
| **权限** | 没有 | 按浏览器、按组设门 |
| **智能体接口** | 只有脚本 API | MCP、REST、CLI |

BrowserPowers **不是** CI/CD 里 Playwright/Puppeteer 的替代品。一次性的浏览器自动化测试就用为此而生的工具。BrowserPowers 是给持久的、真人用的浏览器，让你的 AI 智能体能指挥它们。

---

## 浏览器身份

每个连上的浏览器分到一个**形容词-动物-十六进制**自动名（如 `quick-fox-a3b2`）。重启后保留，可在扩展弹窗里改。

---

## 许可

MIT——见 [LICENSE](LICENSE)。

---

<p align="center">
  Made with 🐱 by <a href="https://github.com/lirrensi">lirrensi</a>
</p>
