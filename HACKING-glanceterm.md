# Hacking on GlanceTerm

This is the GlanceTerm-specific contributor guide — what the AI-sidebar
plugin does internally and how to extend it. For generic Tabby-fork build
mechanics (Node version, Webpack quirks, plugin loading rules) see
[HACKING.md](HACKING.md), which is inherited from upstream Tabby and still
applies verbatim.

The two most common contributions are:

1. **Add a new AI agent adapter** (Codex, Gemini CLI, opencode, aider, …)
2. **Validate the plugin on Linux or Windows** — code paths exist (see
   `hook-runtime.service.ts`'s `HANDLER_PS1` for the PowerShell handler and
   the `process.platform === 'win32'` branches throughout) but only macOS
   has been exercised end-to-end.

## Architecture in one diagram

```
                                                  ~/.glanceterm/
   ┌──────────────────┐                            ├── handlers/
   │ AI CLI process   │  fires hook on event       │   ├── glanceterm-hook.sh  (POSIX, embedded in
   │ (claude, codex…) │ ─────────────────────────► │   │                        hook-runtime.service)
   └──────────────────┘  spawned with              │   └── glanceterm-hook.ps1 (Windows)
            ▲            GLANCETERM_TAB_ID env     │
            │                                      ├── hooks/
            │ env-injected at PTY spawn            │   └── <tab-id>.log  (one NDJSON line per event)
            │                                      │
   ┌──────────────────┐                            ├── auto-approve.flag  ("0"|"1")
   │ Tabby PTY layer  │                            └── auto-approve.log   (audit, tab-separated)
   └──────────────────┘
            ▲                                                  │
            │ status pushed back into Tabby tab list           │ fs.watch
            │                                                  ▼
   ┌──────────────────┐                              ┌──────────────────┐
   │ Sidebar UI       │  ◄── observable updates ──── │ HookWatcherSvc   │
   │ (Angular)        │                              │ TabMonitor       │
   └──────────────────┘                              └──────────────────┘
```

The whole pipeline is hook-driven, never screen-scraped. A tab only shows
fine-grained status when (a) we recognise its process tree as a known agent
(`tab-monitor.ts` regex list) AND (b) we have a registered `HookAdapter`
for that agent.

## Status state machine

`TabStatus` (see `tab-monitor.ts`):

```
                          UserPromptSubmit
                  ┌──────────────────────────┐
                  ▼                          │
              ┌──────────┐  PermissionRequest │
   ┌────────► │ working  │ ───────────────►  │  ┌────────────────────┐
   │          └──────────┘                   ▼  │ needs_permission   │
   │ Stop          │                            └────────────────────┘
   │               │                                      │
   │               ▼                                      │
   │          ┌──────────┐                                │ Pre/PostToolUse
   │          │   done   │ ◄─── (UnreadService flag) ─────┘ (user approved)
   │          └──────────┘
   │               │ focus tab → UnreadService.clear()
   │               ▼
   │          ┌──────────┐
   └──────────│   idle   │
              └──────────┘
```

- `no_ai` is the resting state for tabs whose process tree doesn't match any
  AI CLI — they sit grouped at the bottom of the list and never get hook
  events.
- `done` is "agent finished a turn AND user hasn't focused the tab yet". The
  `done → idle` transition is driven by `UnreadService` on tab focus, not by
  the agent itself.
- The `Pre/PostToolUse → working` edge from `needs_permission` is the
  unstick path after the user approves an inline prompt — agents don't emit
  a discrete "permission resolved" event. See the head comment in
  `hook-adapters/claude.ts` for the rationale.

## Adding a new agent adapter

The whole point of `HookAdapter` is to make this two files of work.

### Step 1 — write `src/hook-adapters/<your-tool>.ts`

Implement `HookAdapter` (interface in `src/hook-adapters/adapter.ts`). The
contract:

| Method                          | Returns                                         |
|---------------------------------|-------------------------------------------------|
| `readonly id`                   | A literal from the `AiTool` union              |
| `readonly displayName`          | Used in installer dialogs                      |
| `configFilePath()`              | Absolute path to the agent's settings file     |
| `hookEvents()`                  | List of `{event, matcher?, async}` to register |
| `installHooks(handlerCommand)`  | Idempotently inject our hooks; preserve other keys |
| `uninstallHooks()`              | Remove our entries; preserve other keys        |
| `isInstalled()`                 | Cheap check without writing                    |
| `mapEventToStatus(event, m?)`   | Event → `TabStatus` (or `null` for noise)      |

Use `src/hook-adapters/claude.ts` as the reference implementation. It
handles the awkward parts you'll likely also need:

- **Atomic write**: read settings, mutate in memory, write to a temp file,
  `fs.rename` (atomic on POSIX + NTFS). Never truncate-in-place.
- **`ReadResult` discriminated union**: distinguish "file missing" (safe to
  start from `{}`) from "file present but unparseable" (UNSAFE to overwrite
  — bail with `installed: false`). Destroying the user's hand-edited
  settings file because it had a trailing comma is the worst kind of bug.
- **Cross-platform settings path**: use `os.homedir()`, never `~`. Branch on
  `process.platform === 'win32'` for `%APPDATA%`-style paths.
- **Sync vs async hooks**: `async: false` only when you need to read the
  handler's stdout (Claude's auto-approve uses this). Otherwise default to
  `async: true` so the handler doesn't block the agent's main loop.

### Step 2 — register in `src/hook-adapters/registry.ts`

```ts
private readonly adapters: Map<AiTool, HookAdapter> = new Map<AiTool, HookAdapter>([
    ['claude', new ClaudeHookAdapter()],
    ['codex',  new CodexHookAdapter()],   // ← your line
])
```

That's it. The installer, watcher, and sidebar all route through the
registry — no edits to them.

### What the registered handler script receives

The handler (`glanceterm-hook.sh` or `glanceterm-hook.ps1`, generated by
`hook-runtime.service.ts` on every launch) is invoked as:

```
glanceterm-hook.sh <agent-id>
```

with the hook payload piped on stdin. It extracts `hook_event_name`,
`session_id`, `tool_name`, `matcher`, `cwd` and appends one NDJSON line to
`~/.glanceterm/hooks/<tab-id>.log`. `<tab-id>` comes from the
`GLANCETERM_TAB_ID` env var that Tabby's PTY layer injects per tab.

If your agent fires hooks with a payload shape that differs from Claude's,
extend the extractor block in `HANDLER_SH` / `HANDLER_PS1` — keep the
output NDJSON schema (`tab_id, agent, event, matcher, tool_name,
session_id, cwd, ts`) unchanged so the watcher doesn't need agent-specific
parsing.

### Process-tree detection

Add a `regexes` entry to `AI_PATTERNS` in `src/tab-monitor.ts` so the
detector recognises your tool from `ps` output. Two patterns: the short
command name (`\bcodex(\s|$)`) and the node-module path
(`/codex(?:-cli)?/[^\s]+\.[mc]?js`). The path pattern is what catches
sessions launched via `npx`, where the short name isn't visible.

If your agent has no hook mechanism at all (aider, opencode, goose today),
add it to `AI_PATTERNS` but skip the adapter — the tab will show as
`working` whenever the process is alive, with no finer-grained granularity,
which is still better than `no_ai`.

## Auto-approve subsystem

`src/auto-approve.service.ts` owns `~/.glanceterm/auto-approve.flag`
(1 byte: `'0'` or `'1'`). The hook handler reads that byte on every
`PermissionRequest` event for Claude — if `'1'`, it prints
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
to stdout and Claude proceeds without prompting. Every grant is appended to
`~/.glanceterm/auto-approve.log` for audit.

If you're adding auto-approve support to another agent, the contract is:

1. The agent must support a sync hook with a settings-blessed way to skip
   the user prompt via stdout JSON (Claude is the only one that does so
   today).
2. Mirror the POSIX `if [ "$AGENT" = "claude" ] && [ "$EVENT" = "PermissionRequest" ]; then …` block in `HANDLER_SH` (and the
   parallel block in `HANDLER_PS1`) for your agent's event name and stdout
   JSON shape.
3. The flag file is shared across all agents — if a user enables
   auto-approve, it's on for every supported agent simultaneously. Don't
   add per-agent flag files; one switch keeps the threat model legible.

## Local dev loop

```bash
# one-time
cd glanceterm/tabby-plugin-ai-sidebar && npm install && npm run build

# iterate (auto-rebuild + launch with debug port)
cd glanceterm && ./dev.sh
```

`dev.sh` rebuilds the plugin, then launches the fork with `TABBY_PLUGINS=`
pointed at it and Chrome DevTools on port 9222. Reach it via
`chrome://inspect` → "Configure" → add `localhost:9222` → "Inspect" the
GlanceTerm target. Useful for live-editing the sidebar CSS or stepping
through hook-event flow without a packaging round-trip.

Plugin changes take effect on app restart. SidebarProvider / tabby-core
changes require `npm run build` in the root before the next launch.

## File map

```
glanceterm/
├── tabby-core/src/
│   ├── api/sidebarProvider.ts            ← extension point
│   ├── services/sidebar.service.ts       ← visibility + width state
│   └── components/appRoot.component.*    ← renders the slot
│
└── tabby-plugin-ai-sidebar/src/
    ├── hook-adapters/
    │   ├── adapter.ts                    ← HookAdapter interface
    │   ├── registry.ts                   ← register new adapters here
    │   └── claude.ts                     ← reference impl
    ├── hook-runtime.service.ts           ← embedded handler scripts (sh+ps1)
    ├── hook-installer.service.ts         ← runs adapter.installHooks() per tool
    ├── hook-watcher.service.ts           ← fs.watch on ~/.glanceterm/hooks/
    ├── tab-monitor.ts                    ← TabState, status map, process-tree detect
    ├── auto-approve.service.ts           ← flag file + confirmation dialog
    ├── screenshot/                       ← capture + per-agent paste adapters
    ├── split-shell.service.ts            ← "open a shell in this AI tab's cwd"
    ├── sidebar.component.ts              ← the rendered UI
    └── index.ts                          ← NgModule + SidebarProvider impl
```

## Code style and review

- TypeScript strict mode is on; no `any` without a comment explaining why.
- Comments explain **why**, not what. The codebase is already heavy on
  rationale for past bugs (`fix(...)` commits often add a long block
  comment) — please continue that habit when fixing something subtle.
- Adversarial review is welcome and expected. Several recent commits
  (`ad49dbce`, `2c134933`) are explicitly tagged as "address adversarial
  review of <previous SHA>" — that's the bar.
- One PR per concern. Drive-by refactors in a bug-fix PR will get split.

## Things known to be wanted

If you're looking for a starter contribution:

- **Codex hook adapter** — Codex CLI ships hooks under
  `~/.codex/config.toml`. Same shape as Claude's adapter.
- **Gemini CLI hook adapter** — Gemini CLI's `~/.gemini/settings.json`
  supports lifecycle hooks; needs an adapter.
- **Linux validation pass** — the PowerShell handler proves the
  cross-platform plumbing was designed in, but only macOS has been
  exercised end-to-end. Most likely breakage points: `xdg-open` vs `open`
  in `split-shell.service.ts`, screenshot capture (which uses Electron's
  `desktopCapturer` — should work on Linux but untested).
- **Windows validation pass** — same as Linux. The hook handler exists
  (`HANDLER_PS1`) but has never been observed running.
- **Replace the in-README ASCII diagram with a real GIF demo** — pulls
  way more weight than text.
