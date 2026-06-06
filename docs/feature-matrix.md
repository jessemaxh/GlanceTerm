# Feature × Agent Support Matrix

This document is the **single source of truth** for which GlanceTerm
features work with which AI agents. Keep it in sync with reality —
contributors update it as part of the same PR that ships the feature
or adapter.

The 6 agents tracked here are the ones recognised by `AI_PATTERNS` in
`tabby-plugin-ai-sidebar/src/tab-monitor.ts` (process-tree detection).
Adding a new agent means editing that file **and** adding a column
here.

## Legend

| Symbol | Meaning |
|---|---|
| ✅ | Implemented AND tested on a real install |
| 🧪 | Implemented but **not tested** with this specific agent — confidence comes from architectural agnosticism (or, for adapters, from following the agent's documented hook schema), not from observed behaviour |
| ❌ | Not implemented; would require writing a per-agent hook adapter (see [HACKING-glanceterm.md](../HACKING-glanceterm.md#adding-a-new-agent-adapter)). Doable, just hasn't been done |
| 🚫 | Architecturally not possible — the agent has no hook mechanism, so we'd have to fall back to screen scraping which the codebase explicitly avoids |
| — | Not applicable (the feature isn't agent-specific) |

## Matrix

| Feature | Claude | Codex | Gemini | opencode | aider | goose |
|---|---|---|---|---|---|---|
| **Detection & display** ||||||
| Process-tree detection (regex in `AI_PATTERNS`) | ✅ | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| Tool tag on row line2 (Claude / Codex / …) | ✅ | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| Detected tab counts toward sidebar pill totals | ✅ | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| **Hook adapter** ||||||
| HookAdapter implementation exists | ✅ | 🧪 (`codex.ts`, untested) | ❌ | ❌ | 🚫 (no hooks) | 🚫 (no hooks) |
| Auto-install hook into agent's settings file | ✅ | 🧪 (`~/.codex/hooks.json`) | ❌ | ❌ | 🚫 | 🚫 |
| **Status states** ||||||
| `working` state | ✅ | 🧪 (Pre/PostToolUse) | 🧪 (process-alive proxy) | 🧪 (process-alive proxy) | 🧪 (process-alive proxy) | 🧪 (process-alive proxy) |
| `idle` / "ready" state | ✅ | 🧪 (Stop event) | ❌ adapter | ❌ adapter | 🚫 | 🚫 |
| `needs_permission` state | ✅ | 🧪 (PermissionRequest) | ❌ adapter | ❌ adapter | 🚫 | 🚫 |
| `done` (working → idle → unfocused) | ✅ | 🧪 (depends on Stop firing as Claude does) | ❌ depends on idle | ❌ depends on idle | 🚫 | 🚫 |
| Subagent in-flight `· N agents` badge | ✅ | 🧪 (SubagentStart/Stop subscribed) | ❌ adapter | ❌ adapter | 🚫 | 🚫 |
| **Auto-approve** ||||||
| Shield button toggle (UI present) | ✅ | 🧪 (button shown but inert) | 🧪 (inert) | 🧪 (inert) | 🧪 (inert) | 🧪 (inert) |
| Actually responds `allow` to permission prompts | ✅ | 🚫 (Codex docs: PermissionRequest doesn't accept decision JSON) | ❌ adapter | ❌ adapter | 🚫 | 🚫 |
| **Background-job indicator (`· N bg`)** ||||||
| Hook-anchored count (zero false positives) | ✅ | ❌ (Codex Bash bg-flag detection not implemented) | ❌ adapter | ❌ adapter | 🚫 | 🚫 |
| Heuristic ≥2 s persistence fallback | ✅ (also active) | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| **Notifications** ||||||
| OS notification on `needs_permission` | ✅ | 🧪 (gated on PermissionRequest firing) | ❌ no state | ❌ no state | 🚫 | 🚫 |
| OS notification on `working → idle` | ✅ | 🧪 (gated on Stop firing) | ❌ no state | ❌ no state | 🚫 | 🚫 |
| Sound chime on `working → done` | ✅ | 🧪 (gated on Stop) | ❌ no state | ❌ no state | 🚫 | 🚫 |
| **Per-tab actions (agent-agnostic by design)** ||||||
| Screenshot button | ✅ | 🧪 (generic paste adapter) | 🧪 (generic) | 🧪 (generic) | 🧪 (generic) | 🧪 (generic) |
| Split-shell button | — | — | — | — | — | — |
| Pin to top + cwd persistence | — | — | — | — | — | — |
| **Auto-resume on app restart** ||||||
| Captures `cwd → command` with flags | ✅ | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| Replays `${command}\r` in first 30 s window | ✅ | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| Auto-delete entry when user exits agent | ✅ | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |

## Notes by agent

### Claude Code — first-class

The reference HookAdapter (`tabby-plugin-ai-sidebar/src/hook-adapters/claude.ts`).
Subscribes to `SessionStart`, `UserPromptSubmit`, `Pre/PostToolUse`,
`Stop`, `SubagentStop`, `PermissionRequest`. Settings file at
`~/.claude/settings.json`. Validated in the maintainer's daily use.

### Codex — adapter shipped, untested

Adapter written from the [Codex hooks docs](https://developers.openai.com/codex/hooks)
on 2026-06-06 (`hook-adapters/codex.ts`). Schema is nearly 1:1 with
Claude — same `hooks.json` shape, same event names, same stdin payload
fields. Settings file: `~/.codex/hooks.json`.

**Status detection** is expected to "just work" by architectural
symmetry with Claude. **Auto-approve is genuinely unsupported** —
Codex's documented hook output schema for `PermissionRequest` only
accepts `systemMessage`, not the `decision: { behavior: "allow" }`
channel Claude's adapter uses. The shield button shows on Codex tabs
(UI is agent-agnostic) but flipping it on has no effect for them.

**Validate by**: installing Codex CLI, opening a tab, watching
`~/.glanceterm/hooks/<tab-id>.log` for incoming events. Sidebar status
should follow Claude's pattern.

### Gemini CLI — researched, adapter NOT written

[Hooks docs](https://geminicli.com/docs/hooks/reference/) confirm
Gemini CLI has hooks in `~/.gemini/settings.json`, but the event names
diverge (`BeforeTool` / `AfterTool` / `BeforeAgent` / `AfterAgent` /
`BeforeModel` / `AfterModel` / `SessionStart` / `SessionEnd` /
`Notification`) and crucially there is **no dedicated permission-request
event** — tool approval flows through the standard tool hook's
`decision` field. A status-only adapter would map every `Before*` event
to `working` but with no clear "agent done" signal the row would never
transition to `idle` — same degradation as having no adapter.

Deferred until someone with Gemini installed can confirm which event
marks "turn finished, waiting for next user prompt." `BeforeToolSelection`
arriving after `AfterAgent` might serve, but needs a real session to
verify.

### opencode — different architecture, won't fit current model

[opencode plugin docs](https://opencode.ai/docs/plugins/) show
opencode uses a **JavaScript/TypeScript plugin file** model
(`.opencode/plugins/*.{js,ts}`), not a config-file-with-shell-commands
model. To support opencode we'd need to ship and install a JS plugin
file rather than just writing JSON. Different shape from `claude.ts`;
deserves its own dedicated effort when prioritised.

### aider — architecturally blocked

Pure-Python single-process REPL. No documented hook mechanism. Would
require either (a) upstream PR to aider adding hooks, or (b) screen
scraping — explicitly out of scope per the
[architecture choice](../HACKING-glanceterm.md#architecture-in-one-diagram).
Stuck at "we know the process is alive" until aider grows hooks.

### goose — architecturally blocked

Same situation as aider: no hook mechanism today.

## Test coverage

Only **Claude on macOS** has been driven end-to-end by the maintainer.
Everything marked 🧪 above is architecturally expected to work but has
not been observed on a real machine. The
[README](../README.md#known-limitations-v02) flags this publicly —
don't claim "supports Codex/Gemini/etc." in marketing material until
at least process-detection + status events have been validated for the
specific agent.

## Update protocol

This is the **single source of truth** for which features work with
which agents. Memory snapshots, README claims, and marketing
descriptions all defer to this table.

**You MUST update this file in the same PR as any of the following:**

- A new `HookAdapter` lands → flip ❌ → 🧪 (if untested) or ✅ (if
  tested) for the relevant rows; mark adjacent state rows accordingly.
- A new feature is added → add a new row; populate per-agent status.
- An agent is added to `AI_PATTERNS` → add a new column; start every
  cell as ❌ for hook-dependent rows and 🧪 for agent-agnostic ones.
- A 🧪 cell gets manually verified on a real machine → flip to ✅ and
  add a one-line "verified by X on YYYY-MM-DD with ToolName vX.Y.Z"
  note in the agent's section.
- An architectural assumption changes (e.g. screen-scraping becomes
  acceptable, or the project adopts a new IPC channel) → re-evaluate
  every 🚫 entry.

**Where to find the truth for each cell:**

- Adapter status: `tabby-plugin-ai-sidebar/src/hook-adapters/*.ts` and `registry.ts`
- Agent list: `tabby-plugin-ai-sidebar/src/tab-monitor.ts` `AI_PATTERNS`
- Handler-script behaviour: `tabby-plugin-ai-sidebar/src/hook-runtime.service.ts`
- Feature toggles: `tabby-plugin-ai-sidebar/src/ai-config-provider.ts`
- Auto-resume behaviour: `tabby-plugin-ai-sidebar/src/auto-resume.service.ts`
- Status state mapping: each adapter's `mapEventToStatus()` method

**Format conventions:**

- One row per logically distinct feature, not per implementation file.
- Group rows under a bold header row (`**Section name**`) for readability.
- Cells use the legend symbols above — if you need additional context,
  add a parenthetical in the cell itself rather than a footnote.
- When a feature lands AND is tested in the same PR, go directly from
  ❌ to ✅ — don't pass through 🧪.

**Why this file lives in the repo, not in a wiki:**

It's version-controlled alongside the code it describes, so the table
state for any commit is recoverable via `git show`. Wikis drift; this
doesn't.
