<p align="center">
  <img src="app/assets/logo.svg" alt="GlanceTerm logo" width="120" height="120">
</p>

<h1 align="center">GlanceTerm</h1>

<p align="center">
  <strong>一眼看尽每个 AI agent，绝不错过那个在等你的。</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow.svg"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey">
  <img alt="Status" src="https://img.shields.io/badge/status-v0.2%20pre--release-orange">
  <img alt="Built on Tabby" src="https://img.shields.io/badge/built%20on-Tabby-blue">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
</p>

<p align="center">
  <a href="README.md">English</a>&nbsp;·&nbsp;简体中文
</p>

---

如果你同时开着 5 个以上的 Claude Code / Codex / Gemini / opencode 会话，分散
在不同标签页里，你大概干过这种事：Cmd-Tab 一个个切过去，盯着标题栏眯眼辨认，
想搞清楚哪个已经做完、可以接下一个任务了。

GlanceTerm 解决的就是这个。它把每个标签页放进一个侧边栏，配一个实时状态点 ——
AI 在干活时是绿色，做完等你时是蓝色，在请求权限时是琥珀色。点一行 → 直接跳到
那个标签页。

**你能得到什么**

- 🟢 **每个标签页的实时状态** —— working / done / needs-permission，由 agent
  自己的 hook 事件驱动（零轮询、零抓屏、零误报）。
- 🎯 **点击即跳转** —— 一键直达那个在等你的标签页。
- 🔄 **重启无忧** —— 关掉再打开 GlanceTerm，agent 标签页会自动回来，而且每个都
  恢复到它*上一次的精确会话*（`claude --resume`、`codex resume`、`opencode
  --session`），不是新开一个空对话。
- 🤖 **多 agent** —— Claude Code 一等公民且已测试；Codex / Gemini / opencode
  适配器也都提供（[支持矩阵](docs/feature-matrix.md)）。
- 🧩 **无需改习惯** —— 照常敲 `claude`，hook 首次启动自动接好。
- 🛡️ **可选的自动批准** —— 不必再切窗口点 "Allow"；每次操作都有审计日志。
  默认关闭（开启前请先读 ⚠️ 警告）。
- 📸 **截图 → 粘贴 & 分屏** —— 直接截进当前 agent，或在它的工作目录开个 shell。

```
┌────────────────┬──────────────────────────────────┐
│  AI TABS       │                                  │
│                │   you@host ~/work/api $          │
│ ● ai-backend   │   > what does this function do?  │
│   working      │                                  │
│   CLAUDE  3s   │   ⏺ Reading src/handler.ts…      │
│ ○ ai-frontend  │                                  │
│   ready  •     │                                  │
│   CLAUDE  2m   │                                  │
│ ◐ ai-tests     │                                  │
│   needs you    │                                  │
│   CLAUDE  4s   │                                  │
└────────────────┴──────────────────────────────────┘
```

## Agent 与平台支持

GlanceTerm 能用到什么程度,取决于 agent。**Claude Code 是一等公民、日常使用中
已验证;Codex 的状态检测已验证;Gemini 和 opencode 提供了适配器,但还没端到端
测试过。**

| 能力 | Claude Code | Codex | Gemini CLI | opencode |
|---|:---:|:---:|:---:|:---:|
| 实时状态 —— working / done / 等你 | ✅ | ✅ \* | 🧪 | 🧪 |
| 自动批准权限弹窗 | ✅ | 🧪 | ❌ † | ❌ |
| 重启后恢复精确会话 | ✅ | 🧪 | ❌ ‡ | 🧪 |
| 子 agent + 后台任务徽标 | ✅ | ❌ | ❌ | ❌ |
| 模型 + token 用量展示 | 🧪 | 🧪 | 🧪 § | 🧪 |

**✅ 在真实安装上已测试** · **🧪 已实现、但尚未在该 agent 上测试** ·
**❌ 不可用**(未实现,或该 agent 的 hook 无法表达此能力)

<sub>\* Codex 的 working→done 已验证;"等你"(权限)状态已实现但未实测。
† Gemini 的 hook 只能 *拒绝*、不能自动放行 —— 所以自动批准是不可能,而非没写。
‡ Gemini CLI 没有启动时按 id 恢复会话的参数,所以恢复的标签页只能开新会话。
§ Gemini 只显示 token 用量,不显示模型名。</sub>

截图粘贴、分屏 shell、置顶都与 agent 无关,四个 agent 表现一致。完整的逐事件
拆解(以及哪些在架构上就不可行)见
[docs/feature-matrix.md](docs/feature-matrix.md)。

**平台 —— 目前仅 macOS。** GlanceTerm 只在 **macOS** 上验证过;Linux(`/proc`
+ POSIX `sh`)和 Windows(PowerShell)的代码路径都写了,但**从未运行过**。所以
**只提供 macOS 的 `.dmg`,暂不提供预构建的 Linux/Windows 安装包**。在这两个平台
上请从源码构建(见[开发 / 构建](#开发--构建)),并欢迎反馈哪里坏了。

## 仓库状态

**v0.2 —— 基于 hook 的架构，自用打磨中。** 构建于
[Tabby](https://github.com/Eugeny/tabby) 之上，在其内核中加入了一个极简的
`SidebarProvider` 扩展点。侧边栏本身是一个插件。

```
ai-terminal/
├── glanceterm/                 forked Tabby with the SidebarProvider extension
│   └── tabby-core/src/
│       ├── api/sidebarProvider.ts        ← new extension point
│       ├── services/sidebar.service.ts   ← visibility + width state
│       └── components/appRoot.component.* ← renders the slot
│
└── tabby-plugin-ai-sidebar/    the actual sidebar
    └── src/
        ├── hook-adapters/      pluggable per-agent hook integrations
        │   ├── adapter.ts      HookAdapter interface
        │   ├── claude.ts       Claude Code adapter (first-class)
        │   ├── codex.ts        Codex adapter
        │   ├── gemini.ts       Gemini CLI adapter
        │   └── opencode.ts     opencode adapter
        ├── hook-watcher.service.ts  fs.watch on ~/.glanceterm/hooks/
        ├── tab-monitor.ts      ties tabs ↔ hook events ↔ status
        ├── sidebar.component.ts the rendered UI
        └── index.ts            NgModule + SidebarProvider impl
```

## 工作原理

每个 Tabby 标签页在 PTY 启动时都会被注入一个唯一的 `GLANCETERM_TAB_ID`
环境变量。从该 shell 派生出的任何进程 —— 包括 `claude`、`codex`、`gemini`
—— 都会继承它。

对于受支持的 agent（目前是 **Claude Code**），GlanceTerm 会在 agent 首次启动
时往它的配置文件里安装一个 hook。该 hook 在生命周期事件（`UserPromptSubmit`、
`Stop`、`PermissionRequest`、`SessionEnd`）上触发，往 `~/.glanceterm/hooks/<tab-id>.json`
写一个极小的状态文件。

侧边栏监听那个目录，实时更新每个标签页的状态。同一个项目里开了多个 Claude
会话？每个都有自己的 `GLANCETERM_TAB_ID`，所以它们各自独立显示状态。零轮询、
零抓屏、零误报。

**各 agent 的支持情况**记录在
[docs/feature-matrix.md](docs/feature-matrix.md) —— 完整列出哪些功能在
Claude / Codex / Gemini CLI / opencode 上可用、哪些已测试 vs 已实现但未测试、
哪些在架构上就不可行。一句话路线图：Claude 一等公民，Codex 适配器状态检测已
验证（自动批准未测），Gemini 和 opencode 提供了适配器但未端到端验证。

## ⚠️ 自动批准权限（需手动开启，危险）

GlanceTerm 可以替你自动批准 Claude Code 的权限弹窗 —— 当你在照看大量 agent、
不想每 30 秒就切窗口点一次"Allow"时很有用。**默认是关闭的。**

开启后（点侧边栏底部工具栏的盾牌图标，再确认警告对话框），GlanceTerm 会对每个
Claude 的 `PermissionRequest` 回复 `allow`。此后 Claude 可以执行任何命令 ——
包括 `rm -rf` 或 `curl … | sh` 这类破坏性命令 —— 都不再询问。

- **审计日志**：每一次自动批准的操作都会追加到
  `~/.glanceterm/auto-approve.log`（制表符分隔：时间戳、标签页 id、工具名、
  工作目录）。
- **标志文件**：`~/.glanceterm/auto-approve.flag` 存的是 `1`（开）或 `0`
  （关）。删掉它或设为 `0`，Claude 在下一次请求时就回退到交互式弹窗 ——
  当你想在不打开 app 的情况下一键关停时很有用。
- **关闭**：再点一次盾牌。关闭时按钮是灰色，开启时是琥珀色。

**不要在这些地方开启**：你的主仓库、含有凭据或生产访问权限的目录、或任何
`sudo` 无需密码就能用的 shell。请在容器、临时目录或一次性虚拟机里用。出了事
后果自负 —— 那个确认对话框的存在正是为了这个。

## 与其他多 agent 终端对比

| | GlanceTerm | hiveterm.com | Agent Deck |
|--|--|--|--|
| 形态 | 带侧边栏的 GUI 终端 | 带分屏的 GUI 终端 | tmux + TUI |
| 安装 | 打开 app，允许 hook 安装 | 装 app + 写 `hive.yml` | 装二进制 + 每个会话 `agent-deck add` |
| 习惯改变 | 无 —— 照常敲 `claude` | 需学新布局 | 每个会话都得用 `agent-deck` 启动 |
| 改动 AI 配置文件 | 仅 agent 的 hook 条目 | 无 | 是 —— 每个工具的 hook 条目 |
| 价格 | 免费，MIT | $99/年 Pro | 免费（二进制） |

## 安装

**macOS（推荐）** —— 从[发布页](../../releases)下载最新的 `.dmg`，打开后把
GlanceTerm.app 拖进 `/Applications`。

该构建已用 **Apple Developer ID 签名并经过公证**，所以双击即可正常打开 ——
没有 Gatekeeper 警告，也不用右键那一套。

**Linux / Windows** —— **暂不提供预构建安装包。** 目前没有 CI，只有 macOS 的
`.dmg` 是本地构建、手动上传的。跨平台代码路径是存在的 —— hook 处理器为 Windows
提供了 PowerShell 变体、为 Linux 提供了 POSIX `sh`，全部能编译 —— 但都没做过
冒烟测试。想在 Linux/Windows 上试用，请从源码构建（见[开发 / 构建](#开发--构建)）。
欢迎提"在我的发行版上能用"/"这里有问题、附上修复"的 PR，或贡献一个构建 workflow。

## 开发 / 构建

前置：macOS、Node 22、[yarn](https://yarnpkg.com)、[Homebrew](https://brew.sh)。

```bash
# 1. fork — 安装 + 构建（首次较重）
cd glanceterm
yarn
npm run build

# 2. 插件
cd tabby-plugin-ai-sidebar
npm install
npm run build

# 3. 启动
cd ..
./dev.sh
```

`dev.sh` 会重新构建插件，然后用指向它的 `TABBY_PLUGINS=` 启动 fork，并在
9222 端口开启远程调试 —— 方便用 CDP 驱动 UI 测试。

## 已知限制（v0.2）

- **只有 Claude Code 被完整 hook 并测试过。** Codex 的适配器在真实安装上验证了
  状态检测；其自动批准路径经源码确认但未测试。Gemini 和 opencode 提供了适配器
  但尚未端到端验证。精确的逐功能拆解见
  [docs/feature-matrix.md](docs/feature-matrix.md)，如何贡献一个适配器见
  [HACKING-glanceterm.md](HACKING-glanceterm.md#adding-a-new-agent-adapter)。
- **仅在 macOS 上验证过。** Linux 和 Windows 的代码路径都存在 —— hook 处理器
  同时提供 POSIX `sh` 和 PowerShell 两种形式 —— 但还没人端到端跑过。求帮忙。
- **Windows 构建未签名。** macOS 构建已用 Developer ID 签名并公证（双击即开）。
  Windows 构建暂无 Authenticode 签名，首次运行会触发 SmartScreen 警告。
- **自动更新只在 macOS / Windows 上可用。** Tabby 内置的更新器被原样继承，
  现已指向本仓库的 releases。Linux 的 electron-updater 被上游 Tabby 禁用了 ——
  你需要手动更新。（在 Windows 签名之前，Windows 更新会和首次安装一样触发
  SmartScreen 警告。）

## 致谢

构建于 [Tabby](https://github.com/Eugeny/tabby) v1.0.234 之上，作者 Eugene
Pankov。fork 中加入的 `SidebarProvider` 扩展点意在回馈上游 —— 如果你在自己的
Tabby 插件里也用得上，PR 正在路上。

GlanceTerm 采用 MIT 许可，与 Tabby 相同。许可文本见 [LICENSE](LICENSE)，相对
上游 Tabby 的完整改动清单见 [NOTICE](NOTICE)。
