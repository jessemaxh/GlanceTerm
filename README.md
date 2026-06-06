# GlanceTerm

**See every AI agent at a glance. Never miss the one that needs you.**

If you have 5+ Claude Code / Codex / opencode / aider sessions running in
different tabs, you've probably done this dance: Cmd-Tab through them all,
squinting at the title bar, trying to figure out which one is done and ready
for the next task.

GlanceTerm fixes that. It puts every tab in a side panel with a live status
dot — green when the AI is working, blue when it's done and waiting for you,
amber when it's asking permission. Click a row → jump straight to that tab.

```
┌────────────────┬──────────────────────────────────┐
│  AI TABS       │                                  │
│                │   you@host ~/work/api $   │
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
        │   └── claude.ts       Claude Code adapter (v0.2)
        ├── hook-watcher.ts     fs.watch on ~/.glanceterm/hooks/
        ├── tab-monitor.ts      ties tabs ↔ hook events ↔ status
        ├── sidebar.component.ts the rendered UI
        └── index.ts            NgModule + SidebarProvider impl
```

## How it works

Every Tabby tab gets a unique `GLANCETERM_TAB_ID` env var injected at PTY
spawn time. Any process spawned from that shell — including `claude`,
`codex`, `aider` — inherits it.

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
opencode / aider / goose, what's tested vs implemented-but-untested, and
what's architecturally blocked. Roadmap in one line: Claude is
first-class, Codex has a docs-written adapter (untested), Gemini /
opencode / aider / goose are partial via process detection only.

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
[releases page](../../releases). Drag GlanceTerm.app into `/Applications`.

The binary is **ad-hoc signed, not notarized** (no paid Apple Developer
account yet), so macOS Gatekeeper will refuse to launch it on first run.
To bypass:

1. After dragging into Applications, right-click GlanceTerm → **Open** →
   confirm the warning dialog. (Double-clicking won't show the Open
   option — you need the right-click menu.)
2. macOS remembers this choice; subsequent launches work normally.

Alternatively, from a terminal:
```bash
xattr -d com.apple.quarantine /Applications/GlanceTerm.app
```

**Linux / Windows** — `.AppImage`, `.deb`, `.rpm`, and Windows `.exe`
installers are also produced by CI and attached to each release, but
**none have been validated end-to-end**. The hook handler ships a
PowerShell variant for Windows and POSIX `sh` for Linux; everything
compiles, nothing has been smoke-tested. PRs reporting "works on my
distro" / "breaks here, fix attached" are very welcome.

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

- **Only Claude Code is fully hooked and tested.** Codex has an
  adapter written from docs but not yet validated on a real install.
  Gemini / opencode / aider / goose are recognised from their process
  tree and show as `working` while alive, but lack fine-grained
  states. See [docs/feature-matrix.md](docs/feature-matrix.md) for the
  precise per-feature breakdown and
  [HACKING-glanceterm.md](HACKING-glanceterm.md#adding-a-new-agent-adapter)
  for how to contribute an adapter.
- **Validated on macOS only.** Code paths for Linux and Windows exist —
  the hook handler ships in both POSIX `sh` and PowerShell forms — but no
  one has driven them end-to-end yet. Help wanted.
- **No code signing.** macOS builds are ad-hoc signed (Gatekeeper
  bypass instructions in [Install](#install) above). No Windows
  Authenticode signature either.
- **Auto-update only on macOS / Windows.** Tabby's built-in updater is
  inherited as-is, now pointed at this repo's releases. Linux's
  electron-updater is disabled by upstream Tabby — you'll need to update
  manually. (When you do update macOS or Windows, the same Gatekeeper /
  SmartScreen warnings apply to the new build as to the first install.)

## Credits

Built on [Tabby](https://github.com/Eugeny/tabby) v1.0.234 by Eugene Pankov.
The `SidebarProvider` extension point added in the fork is intended to
upstream — if you'd find it useful in your own Tabby plugin, the PR is on
the way.

GlanceTerm is MIT-licensed, same as Tabby. See [LICENSE](LICENSE) for the
license text and [NOTICE](NOTICE) for the full list of modifications on top
of upstream Tabby.
