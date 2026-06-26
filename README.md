<p align="center">
  <img src="app/assets/logo.svg" alt="GlanceTerm logo" width="120" height="120">
</p>

<h1 align="center">GlanceTerm</h1>

<p align="center">
  <strong>See every AI agent at a glance. Never miss the one that needs you.</strong>
</p>

<p align="center">
  The terminal for running <strong>multiple AI coding agents in parallel</strong> —
  <strong>Claude&nbsp;Code</strong>, <strong>Codex</strong>, <strong>Gemini&nbsp;CLI</strong>, <strong>opencode</strong>.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow.svg"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%7C%20Linux%20%7C%20Windows-lightgrey">
  <a href="https://github.com/jessemaxh/GlanceTerm/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/jessemaxh/GlanceTerm"></a>
  <img alt="Built on Tabby" src="https://img.shields.io/badge/built%20on-Tabby-blue">
</p>

<p align="center">
  English&nbsp;·&nbsp;<a href="README.zh-CN.md">简体中文</a>
</p>

---

<p align="center">
  <img src="assets/screenshots/sidebar.png" alt="GlanceTerm sidebar — live status for every AI agent tab" width="820">
</p>

Running 5+ **Claude Code / Codex / Gemini / opencode** sessions across tabs? Stop
Cmd-Tabbing to figure out which one is done. GlanceTerm puts every tab in one
**live-status side panel** — 🟢 working · 🔵 done & waiting · 🟠 needs permission —
and **one click jumps you to the tab that needs you**.

## ✨ Highlights

- 🟢 **Live status per tab** — working / done / needs-you, from each agent's **own hook events** (no polling, no screen-scraping, no false positives)
- 🎯 **Click to jump** straight to the tab waiting on you
- 🔄 **Restart-safe** — reopen and every agent resumes its *exact* prior session (`claude --resume`, `codex resume`, `opencode --session`)
- 🤖 **Multi-agent** — Claude Code first-class & tested; Codex / Gemini CLI / opencode adapters too
- 🌳 **Worktree isolation (optional)** — right-click → run an agent in its own git worktree + branch, so several agents work one project without clobbering each other; auto-cleans a clean one on close, with a manager panel for the rest
- 🧩 **Zero workflow change** — keep typing `claude`; the hook self-installs on first launch
- 📊 **Token usage** — in / cache / out per agent · session · project, with CSV export
- 🛡️ **Opt-in auto-approve** (audit-logged, **off by default**) · 📸 **screenshot-to-paste** · split shell

```
┌────────────────┬──────────────────────────────────┐
│  AI TABS       │   you@host ~/work/api $          │
│ ● ai-backend   │   > what does this function do?  │
│   working      │   ⏺ Reading src/handler.ts…      │
│ ○ ai-frontend  │                                  │
│   ready  •     │                                  │
│ ◐ ai-tests     │                                  │
│   needs you    │                                  │
└────────────────┴──────────────────────────────────┘
```

## Install

**macOS** (Apple Silicon) — Homebrew:

```sh
brew install --cask jessemaxh/glanceterm/glanceterm
```

…or grab the **signed + notarized `.dmg`** from the [latest release](../../releases/latest).

**Linux** (x64) — from the [latest release](../../releases/latest): `.AppImage` · `.deb` · `.rpm` · `.pacman` · `.tar.gz`.

**Windows** (x64) — `…-setup-x64.exe` or portable `.zip` from the [latest release](../../releases/latest). ⚠️ Unsigned → SmartScreen "More info → Run anyway".

<sub>Every release builds **and** launch-smoke-tests all three platforms in CI automatically. macOS is Apple Silicon only; Linux/Windows are x64.</sub>

## Agent support

**Claude Code is first-class and validated in daily use.** Codex's status detection
is verified; Gemini CLI and opencode ship adapters not yet tested end-to-end.

| Capability | Claude&nbsp;Code | Codex | Gemini&nbsp;CLI | opencode |
|---|:---:|:---:|:---:|:---:|
| Live status (working / done / needs-you) | ✅ | ✅ | 🧪 | 🧪 |
| Auto-approve permissions | ✅ | 🧪 | ❌ | ❌ |
| Resume exact session on restart | ✅ | 🧪 | ❌ | 🧪 |
| Subagent + background-job badges | ✅ | ❌ | ❌ | ❌ |

**✅ tested · 🧪 implemented, untested with this agent · ❌ not available.** Full
per-event breakdown: [docs/feature-matrix.md](docs/feature-matrix.md).

## How it works

Each tab gets a unique `GLANCETERM_TAB_ID` at PTY spawn; `claude` (and others)
inherit it. On first launch GlanceTerm installs a tiny **hook** in the agent's
settings that writes a JSON status file to `~/.glanceterm/hooks/<tab-id>` on each
lifecycle event. The sidebar watches that directory and repaints each tab's status
in real time — **zero polling, zero screen-scraping, zero false positives.**

## ⚠️ Auto-approve (opt-in, dangerous)

GlanceTerm can auto-answer `allow` to every Claude Code permission prompt — handy
when babysitting many agents. **Off by default.** When on, Claude can run
**anything** — including `rm -rf` or `curl … | sh` — without asking.

- Every action is logged to `~/.glanceterm/auto-approve.log`; toggle via the shield
  icon, or the `~/.glanceterm/auto-approve.flag` kill-switch file.
- **Don't enable** in your main repo, near credentials, or where `sudo` is
  passwordless. Use a container / scratch dir / disposable VM.

## Build from source

Prereqs: Node 22, [yarn](https://yarnpkg.com).

```bash
cd glanceterm && yarn && npm run build
cd tabby-plugin-ai-sidebar && npm install && npm run build
cd .. && ./dev.sh        # launches the fork with remote debugging on :9222
```

## Credits

Built on [Tabby](https://github.com/Eugeny/tabby) by Eugene Pankov. MIT-licensed,
same as Tabby — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The `SidebarProvider`
extension point added in the fork is intended to upstream.
