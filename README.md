<p align="center">
  <img src="app/assets/logo.svg" alt="GlanceTerm logo" width="120" height="120">
</p>

<h1 align="center">GlanceTerm</h1>

<p align="center">
  <strong>See every AI agent at a glance. Never miss the one that needs you.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow.svg"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey">
  <img alt="Status" src="https://img.shields.io/badge/status-v0.2%20pre--release-orange">
  <img alt="Built on Tabby" src="https://img.shields.io/badge/built%20on-Tabby-blue">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
</p>

<p align="center">
  English&nbsp;·&nbsp;<a href="README.zh-CN.md">简体中文</a>
</p>

---

If you have 5+ Claude Code / Codex / Gemini / opencode sessions running in
different tabs, you've probably done this dance: Cmd-Tab through them all,
squinting at the title bar, trying to figure out which one is done and ready
for the next task.

GlanceTerm fixes that. It puts every tab in a side panel with a live status
dot — green when the AI is working, blue when it's done and waiting for you,
amber when it's asking permission. Click a row → jump straight to that tab.

**What you get**

- 🟢 **Live status per tab** — working / done / needs-permission, driven by the
  agent's own hook events (zero polling, zero screen-scraping, zero false positives).
- 🎯 **Click to jump** — one click takes you straight to the tab that needs you.
- 🔄 **Restart-safe** — close & reopen GlanceTerm and your agent tabs come back,
  each resumed into its *exact* prior session (`claude --resume`, `codex resume`,
  `opencode --session`), not a fresh one.
- 🤖 **Multi-agent** — Claude Code is first-class and tested; Codex / Gemini /
  opencode adapters ship too ([support matrix](docs/feature-matrix.md)).
- 🧩 **No habit change** — keep typing `claude`; the hook wires itself up on first launch.
- 🛡️ **Opt-in auto-approve** — stop alt-tabbing to click "Allow"; every action is
  audit-logged. Off by default (read the ⚠️ warning before enabling).
- 📸 **Screenshot → paste & split shell** — capture straight into the focused
  agent, or open a shell in its working directory.

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

## Agent & platform support

How much of GlanceTerm works depends on the agent. **Claude Code is
first-class and validated in daily use; Codex's status detection is verified;
Gemini and opencode ship adapters that aren't tested end-to-end yet.**

| Capability | Claude Code | Codex | Gemini CLI | opencode |
|---|:---:|:---:|:---:|:---:|
| Live status — working / done / needs-you | ✅ | ✅ \* | 🧪 | 🧪 |
| Auto-approve permission prompts | ✅ | 🧪 | ❌ † | ❌ |
| Resume exact session on restart | ✅ | 🧪 | ❌ ‡ | 🧪 |
| Subagent + background-job badges | ✅ | ❌ | ❌ | ❌ |
| Model + token-usage display | 🧪 | 🧪 | 🧪 § | 🧪 |

**✅ tested** on a real install · **🧪 implemented, not yet tested** with this
agent · **❌ not available** (not built, or the agent's hooks can't express it)

<sub>\* Codex working→done is verified; the *needs-you* permission state is
implemented but untested live. † Gemini's hook can only *deny*, never
auto-allow — auto-approve is impossible, not just unwritten. ‡ Gemini CLI has
no launch-time resume-by-id flag, so a restored tab starts fresh. § Gemini
shows token usage but not the model name.</sub>

Screenshot-to-paste, split-shell, and pin-to-top are agent-agnostic and behave
the same across all four. The full per-event breakdown (and what's
architecturally blocked) lives in
[docs/feature-matrix.md](docs/feature-matrix.md).

**Platforms — macOS only for now.** GlanceTerm is validated on **macOS**; the
Linux (`/proc` + POSIX `sh`) and Windows (PowerShell) code paths are written
but have **never been run**. So **only the macOS `.dmg` is shipped — there are
no prebuilt Linux/Windows installers yet**. Build from source on those
platforms ([Dev / Build](#dev--build)) and please report what breaks.

## Status of this repo

**v0.2 — hook-based architecture, dogfooding.** Built on top of
[Tabby](https://github.com/Eugeny/tabby) with a minimal `SidebarProvider`
extension point added to the core. The sidebar lives in a plugin.

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

## How it works

Every Tabby tab gets a unique `GLANCETERM_TAB_ID` env var injected at PTY
spawn time. Any process spawned from that shell — including `claude`,
`codex`, `gemini` — inherits it.

For supported agents (currently **Claude Code**), GlanceTerm installs a hook
in the agent's settings file on first launch. The hook fires on lifecycle
events (`UserPromptSubmit`, `Stop`, `PermissionRequest`, `SessionEnd`) and
writes a tiny JSON status file under `~/.glanceterm/hooks/<tab-id>.json`.

The sidebar watches that directory and updates each tab's status in
real-time. Multiple Claude sessions in the same project? Each has its own
`GLANCETERM_TAB_ID`, so they show independent status. Zero polling, zero
screen-scraping, zero false positives.

**Per-agent support** is tracked in [docs/feature-matrix.md](docs/feature-matrix.md)
— full table of which features work with Claude / Codex / Gemini CLI /
opencode, what's tested vs implemented-but-untested, and
what's architecturally blocked. Roadmap in one line: Claude is
first-class, Codex's adapter has status detection verified (auto-approve
untested), Gemini and opencode ship adapters that are untested end-to-end.

## ⚠️ Auto-approve permissions (opt-in, dangerous)

GlanceTerm can auto-approve Claude Code permission prompts on your behalf —
useful if you're babysitting many agents and don't want to alt-tab to click
"Allow" every 30 seconds. **It's off by default.**

When enabled (click the shield icon in the sidebar's bottom toolbar, then
confirm the warning dialog), GlanceTerm responds `allow` to every Claude
`PermissionRequest`. Claude can then run any command — including destructive
ones like `rm -rf` or `curl … | sh` — without asking.

- **Audit log**: every auto-approved action is appended to
  `~/.glanceterm/auto-approve.log` (tab-separated: timestamp, tab id, tool
  name, working directory).
- **Flag file**: `~/.glanceterm/auto-approve.flag` holds `1` (on) or `0`
  (off). Delete it or set to `0` and Claude falls back to interactive prompts
  on the next request — useful if you ever want to kill-switch the feature
  without opening the app.
- **Disable**: click the shield again. The button is grey when off, amber
  when on.

**Don't enable this** in your main repo, in directories with credentials or
production access, or in any shell where `sudo` works without a password.
Use it in a container, scratch directory, or disposable VM. If something
goes wrong, you own it — the confirm dialog exists for exactly this reason.

## Compared to other multi-agent terminals

| | GlanceTerm | hiveterm.com | Agent Deck |
|--|--|--|--|
| Form factor | GUI terminal w/ sidebar | GUI terminal w/ split panes | tmux + TUI |
| Setup | Open app, allow hook install | Install app + write `hive.yml` | Install binary + `agent-deck add` per session |
| Habit change | None — keep typing `claude` | New layout to learn | Must launch every session via `agent-deck` |
| AI config files modified | Only the agent's hook entry | None | Yes — each tool's hook entry |
| Cost | Free, MIT | $99/yr Pro | Free (binary) |

## Install

**macOS (recommended)** — grab the latest `.dmg` from the
[releases page](../../releases), open it, and drag GlanceTerm.app into
`/Applications`.

The build is **signed with an Apple Developer ID and notarized**, so it opens
with a normal double-click — no Gatekeeper warning, no right-click dance.

**Linux / Windows** — **no prebuilt installers are provided yet.** There's no
CI at the moment, so only the macOS `.dmg` is built (locally) and uploaded by
hand. The cross-platform code paths exist — the hook handler ships a PowerShell
variant for Windows and POSIX `sh` for Linux, and everything compiles — but
nothing has been smoke-tested. To try GlanceTerm on Linux/Windows, build from
source (see [Dev / Build](#dev--build)). PRs reporting "works on my distro" /
"breaks here, fix attached" — or contributing a build workflow — are very
welcome.

## Dev / Build

Prereqs: macOS, Node 22, [yarn](https://yarnpkg.com), [Homebrew](https://brew.sh).

```bash
# 1. fork — install + build (heavy first time)
cd glanceterm
yarn
npm run build

# 2. plugin
cd tabby-plugin-ai-sidebar
npm install
npm run build

# 3. launch
cd ..
./dev.sh
```

`dev.sh` rebuilds the plugin, then launches the fork with
`TABBY_PLUGINS=` pointed at it and remote debugging on port 9222 — handy
for CDP-driven UI testing.

## Known limitations (v0.2)

- **Only Claude Code is fully hooked and tested.** Codex's adapter has
  status detection verified on a real install; its auto-approve path is
  source-confirmed but untested. Gemini and opencode ship adapters that
  are not yet validated end-to-end. See
  [docs/feature-matrix.md](docs/feature-matrix.md) for the
  precise per-feature breakdown and
  [HACKING-glanceterm.md](HACKING-glanceterm.md#adding-a-new-agent-adapter)
  for how to contribute an adapter.
- **Validated on macOS only.** Code paths for Linux and Windows exist —
  the hook handler ships in both POSIX `sh` and PowerShell forms — but no
  one has driven them end-to-end yet. Help wanted.
- **Windows builds are unsigned.** macOS builds are Developer ID-signed and
  notarized (double-click to open). Windows builds carry no Authenticode
  signature yet, so SmartScreen will warn on first run.
- **Auto-update only on macOS / Windows.** Tabby's built-in updater is
  inherited as-is, now pointed at this repo's releases. Linux's
  electron-updater is disabled by upstream Tabby — you'll need to update
  manually. (Windows updates carry the same SmartScreen warning as the first
  install, until the Windows build is signed.)

## Credits

Built on [Tabby](https://github.com/Eugeny/tabby) v1.0.234 by Eugene Pankov.
The `SidebarProvider` extension point added in the fork is intended to
upstream — if you'd find it useful in your own Tabby plugin, the PR is on
the way.

GlanceTerm is MIT-licensed, same as Tabby. See [LICENSE](LICENSE) for the
license text and [NOTICE](NOTICE) for the full list of modifications on top
of upstream Tabby.
