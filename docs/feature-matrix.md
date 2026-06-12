# Feature × Agent Support Matrix

This document is the **single source of truth** for which GlanceTerm
features work with which AI agents. Keep it in sync with reality —
contributors update it as part of the same PR that ships the feature
or adapter.

The **4 supported agents** tracked here are the ones recognised by
`AI_PATTERNS` in `tabby-plugin-ai-sidebar/src/tab-monitor.ts`
(process-tree detection): **Claude Code, Codex, Gemini CLI, opencode**.
Adding a new agent means editing that file **and** adding a column here.

> **Scope decision (2026-06-10):** we support exactly Claude Code, Codex,
> Gemini CLI, and opencode. `aider` and `goose` were **removed** — see
> [Dropped agents](#dropped-agents-2026-06-10).

## Legend

| Symbol | Meaning |
|---|---|
| ✅ | Implemented AND tested on a real install |
| 🧪 | Implemented but **not tested** with this specific agent — confidence comes from architectural agnosticism (or, for adapters, from following the agent's documented hook schema), not from observed behaviour |
| ❌ | Not implemented; would require writing a per-agent hook adapter (see [HACKING-glanceterm.md](../HACKING-glanceterm.md#adding-a-new-agent-adapter)). Doable — the agent has a usable hook/event mechanism, the adapter just hasn't been written |
| 🚫 | The agent's hook surface exists but **cannot express this feature** (e.g. it can observe a permission prompt but not auto-answer it). Distinct from ❌, which is "just not written yet" |
| — | Not applicable (the feature isn't agent-specific) |

## Matrix

| Feature | Claude | Codex | Gemini | opencode |
|---|---|---|---|---|
| **Detection & display** |||||
| Process-tree detection (regex in `AI_PATTERNS`) | ✅ | 🧪 | 🧪 | 🧪 |
| Tool tag on row line2 (Claude / Codex / …) | ✅ | 🧪 | 🧪 | 🧪 |
| Active model shown next to the tag | 🧪 (`SessionStart` slug; mid-session `/model` not yet tracked) | 🧪 (hook `.model` every event — source-confirmed) | ❌ deferred (`.llm_request.model` on `BeforeModel`, not subscribed) | 🧪 (plugin `event.properties.info.modelID`) |
| Session token usage shown (`in: … out: …`, k/m) | 🧪 (transcript `message.usage` summed, incremental; input includes cache read/creation) | ❌ deferred (rollout `total_token_usage` — running total, locate file by session_id) | ❌ deferred (`~/.gemini/tmp/<hash>/chats` `message.tokens`) | ❌ deferred (plugin `info.tokens.{input,output}` summed) |
| Detected tab counts toward sidebar pill totals | ✅ | 🧪 | 🧪 | 🧪 |
| **Hook adapter** |||||
| HookAdapter implementation exists | ✅ | ✅ (verified 2026-06-10, codex 0.138.0) | 🧪 (`gemini.ts`; routing source-confirmed, events untested) | 🧪 (`opencode.ts` ships a JS plugin, untested) |
| Auto-install hook into agent's settings file | ✅ | ✅ (`~/.codex/hooks.json` — installed entries fire correctly) | 🧪 (`~/.gemini/settings.json`) | 🧪 (writes `~/.config/opencode/plugins/glanceterm.ts`) |
| **Status states** |||||
| `working` state | ✅ | ✅ (UserPromptSubmit/Pre/PostToolUse — verified e2e) | 🧪 (`BeforeAgent`) | 🧪 (debounced `message`/`tool.execute.before`) |
| `idle` / "ready" state | ✅ | ✅ (Stop — verified e2e) | 🧪 (`AfterAgent`) | 🧪 (`session.idle`) |
| `needs_permission` state | ✅ | 🧪 (PermissionRequest — fires only in interactive codex, not `exec`; untested e2e) | ❌ deferred (`Notification`/`ToolPermission` — matcher filtering unverified) | 🧪 (`permission.asked`) |
| `done` (working → idle → unfocused) | ✅ | ✅ (derives from Stop — verified e2e) | 🧪 (depends on `AfterAgent`) | 🧪 (depends on `session.idle`) |
| Subagent in-flight `· N agents` badge | ✅ | ❌ (side-channel is Claude-only by construction; Codex's hook payload carries no subagent id — see note) | ❌ adapter (not subscribed) | ❌ adapter (not surfaced) |
| **Auto-approve** |||||
| Shield button toggle (UI present) | ✅ | 🧪 (now active — auto-approves) | 🧪 (inert — auto-approve not possible) | 🧪 (inert — observe-only) |
| Actually responds `allow` to permission prompts | ✅ | 🧪 (Codex added it in PR #17563 — same decision JSON as Claude, source-confirmed; untested e2e) | 🚫 (`Notification` is advisory — "cannot grant permissions automatically"; `BeforeTool` can only `deny`) | ❌ (observe-only; `permission.ask` interceptor exists but unused — flaky) |
| **Background-job indicator (`· N bg`)** |||||
| Hook-anchored count (zero false positives) | ✅ | ❌ (Codex Bash bg-flag detection not implemented) | ❌ adapter | ❌ adapter |
| Heuristic ≥2 s persistence fallback | ✅ (also active) | ❌ (suppressed: `spawnsNativeHelper()` true forces `hookAuthoritative` from t=0, and no Bash bg-flag is set → count stays 0) | 🧪 | 🧪 |
| **Notifications** |||||
| OS notification on `needs_permission` | ✅ | 🧪 (gated on PermissionRequest firing) | ❌ no needs_permission state yet | 🧪 (gated on `permission.asked`) |
| OS notification on `working → idle` | ✅ | 🧪 (gated on Stop firing) | 🧪 (gated on `AfterAgent`) | 🧪 (gated on `session.idle`) |
| Sound chime on `working → done` | ✅ | 🧪 (gated on Stop) | 🧪 (gated on `AfterAgent`) | 🧪 (gated on `session.idle`) |
| **Per-tab actions (agent-agnostic by design)** |||||
| Screenshot button | ✅ | 🧪 (generic paste adapter) | 🧪 (generic) | 🧪 (generic) |
| Split-shell button | — | — | — | — |
| Pin to top + cwd persistence | — | — | — | — |
| **Auto-resume on app restart** (per-tab recovery token) |||||
| Captures the re-runnable agent command with flags | ✅ | 🧪 | 🧪 | 🧪 |
| Replays `${command}\r` into the restored tab | ✅ | 🧪 | 🧪 | 🧪 |
| Clears the command when the user exits the agent | ✅ | 🧪 | 🧪 | 🧪 |

## Notes by agent

### Claude Code — first-class

The reference HookAdapter (`tabby-plugin-ai-sidebar/src/hook-adapters/claude.ts`).
Subscribes to `SessionStart`, `UserPromptSubmit`, `Pre/PostToolUse`,
`Stop`, `SubagentStop`, `PermissionRequest`. Settings file at
`~/.claude/settings.json`. Validated in the maintainer's daily use.
Auto-approve excludes `AskUserQuestion` (a multiple-choice question, not a
yes/no permission — "allow" would discard the user's selection); see
`hook-runtime.service.ts`.

### Codex — status detection VERIFIED; auto-approve source-confirmed

Adapter written from the [Codex hooks docs](https://developers.openai.com/codex/hooks)
(`hook-adapters/codex.ts`). Schema is nearly 1:1 with Claude — same
`hooks.json` shape, same event names, same stdin payload fields. Settings
file: `~/.codex/hooks.json`.

**Status detection — verified on a real machine 2026-06-10 (codex-cli 0.138.0).**
Ran `codex exec` with a shell-tool prompt and a test `GLANCETERM_TAB_ID`; the
installed hooks fired `SessionStart → UserPromptSubmit → PreToolUse(Bash) →
PostToolUse(Bash) → Stop`, the handler wrote a well-formed per-tab log
(`agent:"codex"`, correct `tab_id`, `tool_name:"Bash"`), giving the full
working→idle lifecycle. Note: codex's hooks require persisted TRUST
(`[hooks.state]` in config.toml — GlanceTerm's were already trusted);
`--dangerously-bypass-hook-trust` bypasses it.

**needs_permission / auto-approve are NOT e2e-tested** and can't be via
`codex exec`: exec forces `approval: never` (it never asks), so PermissionRequest
only fires in INTERACTIVE codex — which is exactly how GlanceTerm tabs run it.
The auto-approve MECHANISM is source-confirmed (below) + unit-tested; validate
the live behaviour by running interactive `codex` in a tab with the shield on. **Auto-approve IS supported** (corrected 2026-06-10 — was
previously believed unsupported): Codex added hook-driven PermissionRequest
allow/deny in [PR #17563](https://github.com/openai/codex/pull/17563) (merged
2026-04-17) and reads the hook's stdout for that event synchronously, accepting
the byte-identical `{"hookSpecificOutput":{"hookEventName":"PermissionRequest",
"decision":{"behavior":"allow"}}}` shape GlanceTerm already emits. Verified
against codex-rs source (`hooks/src/schema.rs`, `engine/output_parser.rs`,
`core/src/tools/orchestrator.rs`). The shared handler now fires the allow path
for `AGENT=codex` too. Caveat: Codex fails CLOSED on the reserved
`updatedInput`/`updatedPermissions`/`interrupt` fields — our JSON omits them.

**Validate by**: installing Codex CLI, enabling the shield toggle, and
confirming a `Bash(...)` prompt is auto-approved (and that the grant lands in
`~/.glanceterm/auto-approve.log`).

**Subagent / monitor / bg side-channel is Claude-only (2026-06-11).** The
`liveAgentIds` / `liveMonitorTaskIds` / `pendingBgArrivals` machinery in
`hook-watcher.service.ts processEvent` keys off fields only Claude's payload
defines (`agent_id`, `spawn_agent_id`, `tool_name: Agent/Monitor/TaskStop`,
`bg`) and is now **gated on `adapter.id === 'claude'`**. Codex never populated
these in practice anyway (its documented schema has no subagent id, and the
bg-flag is only set for `tool_name === 'Bash'`, which Codex's shell tool isn't),
so the gate loses no Codex functionality — it removes a latent misfire (a
field-name collision could have pinned a Codex row to a phantom
`working · N agents` with no decrement path, since Codex subscribes to neither
`StopFailure` nor `SessionEnd`). The Codex `SubagentStop` subscription is inert
dead weight as a result. When Codex's real subagent/bg signal is verified e2e,
promote the gate to a per-adapter capability flag.

### Gemini CLI — adapter shipped (`gemini.ts`), UNTESTED

Re-researched 2026-06-10. **Gemini CLI has a first-class shell-command hook
system** (shipped v0.26.0, 2026-01-28; current ≈ v0.42.0). Config lives in
`~/.gemini/settings.json` under a top-level `hooks` object, schema ≈ Claude's.
This **supersedes** the older note that Gemini had no usable idle / permission
signal. `hook-adapters/gemini.ts` subscribes to:

| GlanceTerm status | Gemini hook event |
|---|---|
| `working` | `BeforeAgent` (+ `BeforeTool`/`AfterTool` reaffirm) |
| `idle` | `AfterAgent` (model finished its final response for the turn) |
| (open / cleanup) | `SessionStart` → idle, `SessionEnd` → no_ai |

**Per-tab routing — source-confirmed.** `gemini.ts` appends
`"$GLANCETERM_TAB_ID"` to the installed hook command. Verified against
gemini-cli source (`packages/core/src/hooks/hookRunner.ts`, commit 1d2adf7):
Gemini runs each hook via `spawn('bash', ['-c', command])` with the FULL
inherited `process.env` by default — env "sanitization" is opt-in
(`enableEnvironmentVariableRedaction`, default false) and even when on keeps a
non-secret name like `GLANCETERM_TAB_ID` (only GitHub-Actions strict mode
strips it). So bash expands `"$GLANCETERM_TAB_ID"` to its value, and the var is
also directly present in the hook env (the handler's normal env read works
too). The handler (`hook-runtime.service.ts`) reads the arg only when its own
env lacks the var and discards an unexpanded literal. What's left to confirm on
a real install is purely that the events fire — watch
`~/.glanceterm/hooks/<tab-id>.log` after running `gemini` in a tab.

**needs_permission deferred:** Gemini surfaces tool-approval via `Notification`
+ `notification_type == "ToolPermission"`, but it's unconfirmed whether the
settings `matcher` filters `Notification` by type — subscribing without a
working filter would map every notification to needs_permission. Add once
validated. **Auto-approve is not possible** (the event is advisory; `BeforeTool`
only supports `deny`).

**Abnormal-turn-end gap (known, 2026-06-11):** `AfterAgent → idle` is Gemini's
ONLY release from `working`. There is no `StopFailure`/interrupt-equivalent
event subscribed, and Gemini's stdin payload carries no `transcript_path`, so
the slow-path transcript interrupt probe (`maybeProbeTranscriptInterrupt`)
can't recover it either (it early-returns on the null path). Keyboard ESC is
still covered agent-agnostically (`EscInterruptService → forceIdle`), but a
NON-keyboard abnormal end (internal error / timeout that skips `AfterAgent`)
leaves the row stuck `working` until the next `BeforeAgent`/`SessionEnd`. Add a
Gemini terminal/abnormal-end event once one is identified upstream.
Docs: https://geminicli.com/docs/hooks/ and
https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md

### opencode — adapter shipped (`opencode.ts` + plugin), UNTESTED

Re-researched 2026-06-10. opencode has **no config-file shell-hook** (the Claude
`settings.json` model doesn't apply), so `opencode.ts`'s `installHooks` ships a
JS PLUGIN to `~/.config/opencode/plugins/glanceterm.ts` instead. The plugin runs
IN opencode's Bun process, so — unlike Gemini — there's no env problem: it reads
`process.env.GLANCETERM_TAB_ID` directly and appends watcher-compatible NDJSON to
`~/.glanceterm/hooks/<tab-id>.log`. The plugin debounces the per-chunk
`message.part.updated` stream into a single `working` edge held until
`session.idle`.

Status mapping (plugin `event.type` → emitted log event → TabStatus):
`message`/`tool.execute.before` → `working`; `session.idle` → `idle`;
`permission.asked` → `needs_permission`, `permission.replied` → back to working.

Confirmed against opencode source (sst/opencode v1.17.0, commit 97e713e): the
plugin dir glob is `{plugin,plugins}/*.{ts,js}` (BOTH singular and plural load —
we install to `plugins/`); a named export returning `{ event }` is the right
contract; `session.idle`/`permission.asked`/`permission.replied`/`message(.part)
.updated` all fire, `session.idle` on turn-end; and the default `opencode` TUI is
one process per invocation (so `process.env` routing is per-tab).

**Validation points** (untested end-to-end): (1) the events actually fire in
practice as the source suggests; (2) `session.idle` is marked deprecated upstream
(alias of `session.status`/idle) but still fires — revisit if a future opencode
drops it; (3) a shared `opencode serve` daemon (non-default) would collapse tabs
onto one env. Auto-approve is observe-only (the `permission.ask` interceptor is
unused). `tool.execute.before` is a hook key (not a bus event) so it's omitted.
Docs: https://opencode.ai/docs/plugins/ and https://opencode.ai/docs/server/

## Dropped agents (2026-06-10)

`aider` and `goose` were removed from `AI_PATTERNS` and this matrix.

- **aider** — no usable lifecycle hook system. Its only signal is
  `--notifications-command`, a single "now waiting for input" edge with no
  payload and **no turn-start event**, so hooks alone cannot keep a
  working/idle badge truthful (and `needs_permission` is unobservable
  off-TUI). Reaching qualified behaviour would require a bespoke
  input-submission detector — out of scope. Revisit if aider grows real
  hooks (feature request [#2045](https://github.com/Aider-AI/aider/issues/2045)
  was closed stale).
- **goose** — goose *did* ship Open-Plugins shell hooks (~v1.35.0, ~May 2026)
  that could yield working/idle, but goose is out of the supported set for
  now. If we re-add it, verify the hooks contract against the canonical
  `github.com/block/goose` repo first (the mid-2026 research turned up some
  non-canonical mirror URLs).

If either is re-added: restore its `AI_PATTERNS` entry + `AiTool` union
member, add the column back here, and (for qualified behaviour) ship an
adapter — don't ship detection-only, which shows a permanently-"working"
row.

## Test coverage

**Claude** (full) and **Codex** (status / working→idle lifecycle, 2026-06-10,
codex-cli 0.138.0) have been driven end-to-end on macOS. Codex needs_permission
+ auto-approve and ALL of Gemini/opencode remain 🧪 (architecturally expected /
source-confirmed but not observed live). Don't claim "supports Gemini/opencode"
in marketing material until at least process-detection + status events have
been validated for the specific agent.

## Update protocol

This is the **single source of truth** for which features work with which
agents. Memory snapshots, README claims, and marketing descriptions all defer
to this table.

**You MUST update this file in the same PR as any of the following:**

- A new `HookAdapter` lands → flip ❌ → 🧪 (if untested) or ✅ (if tested) for
  the relevant rows; mark adjacent state rows accordingly.
- A new feature is added → add a new row; populate per-agent status.
- An agent is added to / removed from `AI_PATTERNS` → add / remove its column
  (start every new cell as ❌ for hook-dependent rows and 🧪 for
  agent-agnostic ones).
- A 🧪 cell gets manually verified on a real machine → flip to ✅ and add a
  one-line "verified by X on YYYY-MM-DD with ToolName vX.Y.Z" note in the
  agent's section.
- An architectural assumption changes → re-evaluate every 🚫 entry.

**Where to find the truth for each cell:**

- Adapter status: `tabby-plugin-ai-sidebar/src/hook-adapters/*.ts` and `registry.ts`
- Agent list: `tabby-plugin-ai-sidebar/src/tab-monitor.ts` `AI_PATTERNS`
- Handler-script behaviour: `tabby-plugin-ai-sidebar/src/hook-runtime.service.ts`
- Feature toggles: `tabby-plugin-ai-sidebar/src/ai-config-provider.ts`
- Auto-resume behaviour: `tabby-plugin-ai-sidebar/src/auto-resume.service.ts`
- Status state mapping: each adapter's `mapEventToStatus()` method

**Why this file lives in the repo, not in a wiki:**

It's version-controlled alongside the code it describes, so the table state
for any commit is recoverable via `git show`. Wikis drift; this doesn't.
