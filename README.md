# HiveTerm

**A terminal with a side panel for managing many AI coding agents at once.**

If you have 5+ Claude Code / Codex / opencode / aider sessions running in
different tabs, you've probably done this dance: Cmd-Tab through them all,
squinting at the title bar, trying to figure out which one is done and ready
for the next task.

HiveTerm fixes that. It puts every tab in a side panel with a live status dot
— green when the AI is working, blue when it's done and waiting for you.
Click a row → jump straight to that tab.

```
┌────────────────┬──────────────────────────────────┐
│  AI TABS    3  │                                  │
│                │   you@host ~/work/api $   │
│ ● ai-backend   │   > what does this function do?  │
│   working      │                                  │
│   CLAUDE  3s   │   ⏺ Reading src/handler.ts…      │
│ ○ ai-frontend  │                                  │
│   idle         │                                  │
│   CLAUDE  2m   │                                  │
│ ○ ai-tests     │                                  │
│   idle         │                                  │
│   AIDER   12s  │                                  │
└────────────────┴──────────────────────────────────┘
```

## Status of this repo

**v0.1 — works, dogfooding.** Built on top of [Tabby](https://github.com/Eugeny/tabby)
with a minimal `SidebarProvider` extension point added to the core. The actual
AI detection lives in a separate plugin.

Architecture:

```
ai-terminal/
├── tabby-fork/                 forked Tabby with the SidebarProvider extension
│   └── tabby-core/src/
│       ├── api/sidebarProvider.ts        ← new extension point
│       ├── services/sidebar.service.ts   ← visibility + width state
│       └── components/appRoot.component.* ← renders the slot
│
└── tabby-plugin-ai-sidebar/    the actual sidebar
    └── src/
        ├── tab-monitor.ts      detects AI processes & their state
        ├── sidebar.component.ts the rendered UI
        └── index.ts            NgModule + SidebarProvider impl
```

## How it works (zero config)

1. Once per second, the plugin lists every Tabby tab and asks Tabby's
   `session.getChildProcesses()` for its shell descendants.
2. If a descendant matches a known AI CLI (`claude`, `codex`, `opencode`,
   `aider`), the tab is "AI-active".
3. For Claude: look at `~/.claude/projects/<encoded-cwd>/*.jsonl` mtime —
   freshly touched = working, otherwise idle.
4. For others: take two CPU-time samples 1 second apart. >2% CPU = working.
5. Click a row → `AppService.selectTab()`.

No global config changes. No `~/.claude/settings.json` edits. No hooks. The
plugin just observes.

## Dev / Build

Prereqs: macOS, Node 22, [yarn](https://yarnpkg.com), [Homebrew](https://brew.sh).

```bash
# 1. fork — install + build (heavy first time)
cd tabby-fork
yarn
npm run build

# 2. plugin
cd ../tabby-plugin-ai-sidebar
npm install
npm run build

# 3. launch
cd ..
./dev-fork.sh
```

`dev-fork.sh` rebuilds the plugin, then launches the fork with
`TABBY_PLUGINS=` pointed at it and remote debugging on port 9222 (handy for
CDP-based UI testing — see `/tmp/cdp/` after first run).

## Known limitations (v0.1)

- macOS only, tested on Sequoia. Linux/Windows likely works since Tabby does
  but I haven't validated.
- "AI is working" detection for non-Claude tools uses CPU-time delta — a
  reasonable proxy but not perfect for AIs that idle on the network.
- No persistence yet for sidebar width or visibility — defaults restore on
  relaunch. Coming soon.
- No `.dmg` distribution yet — has to be built from source.

## Roadmap

- v0.2: persist sidebar state, settings panel, codex/opencode activity polish
- v0.3: per-tool icons, notification on "AI needs your input"
- v0.4: signed `.dmg` releases, optional sign-in, opt-in telemetry
- v1.0: pricing decision

## Credits

Built on [Tabby](https://github.com/Eugeny/tabby) by Eugene Pankov. The
`SidebarProvider` extension point in the fork is intended to upstream — if
you'd find it useful in your own Tabby plugin, the PR is on the way.

MIT license, like Tabby.
