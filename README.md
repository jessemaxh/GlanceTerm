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

**Roadmap:**
- v0.2 — Claude Code (this release)
- v0.3 — Codex, Gemini CLI (same HookAdapter pattern, ~1 day each)
- v0.4 — opencode, aider (no native hooks; fall back to process-state)

## Compared to other multi-agent terminals

| | GlanceTerm | hiveterm.com | Agent Deck |
|--|--|--|--|
| Form factor | GUI terminal w/ sidebar | GUI terminal w/ split panes | tmux + TUI |
| Setup | Open app, allow hook install | Install app + write `hive.yml` | Install binary + `agent-deck add` per session |
| Habit change | None — keep typing `claude` | New layout to learn | Must launch every session via `agent-deck` |
| AI config files modified | Only the agent's hook entry | None | Yes — each tool's hook entry |
| Cost | Free, MIT | $99/yr Pro | Free (binary) |

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

- macOS only, tested on Sequoia. Linux/Windows likely works since Tabby does
  but I haven't validated. Hook script ships as POSIX sh; Windows .cmd to come.
- Only Claude Code is hooked in v0.2. Other tools show as "running" if a
  process is alive but lack working/idle granularity until their adapters land.
- No `.dmg` distribution yet — must be built from source.

## Credits

Built on [Tabby](https://github.com/Eugeny/tabby) by Eugene Pankov. The
`SidebarProvider` extension point in the fork is intended to upstream — if
you'd find it useful in your own Tabby plugin, the PR is on the way.

MIT license, like Tabby.
