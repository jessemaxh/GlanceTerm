import { Injectable } from '@angular/core'
import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

/**
 * Embedded POSIX-sh hook handler — written to `~/.glanceterm/handlers/glanceterm-hook.sh`
 * on macOS / Linux. The platform-specific runtime path is picked at install time
 * (see `handlerInvocation()`).
 *
 * Contract — invoked by an AI agent's hook system:
 *   stdin  : the agent's JSON event payload (Claude format today)
 *   $1     : the agent identifier ("claude", "codex", "gemini", …)
 *   env    : GLANCETERM_TAB_ID is inherited from the spawning Tabby shell
 *
 * Output: APPENDS one NDJSON line per event to `~/.glanceterm/hooks/<TAB_ID>.log`.
 * Always exits 0 — failed status writes must not stall the agent's main loop.
 *
 * Why append-only (was: overwrite-single-file `<TAB_ID>.json` + atomic rename):
 *   Claude fires multiple hook events for one tool invocation within
 *   milliseconds — PreToolUse → PermissionRequest for permission-gated tools,
 *   PreToolUse → PostToolUse for sub-100ms tools like Read/Glob. fs.watch
 *   coalesces rapid writes on macOS (FSEvents has a ~10ms latency window)
 *   and sometimes on Linux too, so the watcher's single-file read used to
 *   see ONLY the last event in such bursts — silently dropping any earlier
 *   PreToolUse's tool_name (sidebar needs it to render `working · Bash`
 *   inline) and any same-second SubagentStop pair (subagent counter would
 *   stick one too high). Append-only lets the watcher read every event in
 *   the order it fired, by tracking a byte offset per file.
 *
 * Hardening notes (carried over from the overwrite-pattern handler):
 *   - Extracted fields are run through `tr -d '\\\000-\037'` to strip
 *     backslashes + every ASCII control byte (0x00-0x1F, the full RFC 8259
 *     forbidden range for JSON strings); without this a malicious cwd /
 *     matcher containing `\` or a literal control character would produce
 *     unparseable JSON that the watcher silently drops (issue C1 in the
 *     v0.2 review).
 *   - If `GLANCETERM_TAB_ID` is missing/empty/"unknown", exit silently instead
 *     of writing to `hooks/unknown.log` — that file would otherwise grow
 *     forever with every pre-injection Claude session's events and never
 *     match a real tab (issue M3).
 */
const HANDLER_SH = `#!/bin/sh
# GlanceTerm hook handler (POSIX) — see hook-runtime.service.ts for the contract.
# DO NOT EDIT BY HAND — regenerated on every GlanceTerm launch.
set -u

# Restrict mode of every file we create here to 0600. Both the per-tab
# NDJSON log and the auto-approve audit log contain tool names and cwds
# (and, in the audit log, every command Claude was permitted to run); on
# multi-user hosts the default umask 022 leaves them world-readable.
# Setting it at the top covers all later >> redirections without per-call
# chmod fiddling. The flag-file write (in the Angular service) is already
# 0600 via fs.writeFile mode.
umask 077

AGENT="\${1:-unknown}"
# Tab id resolution. All agents inherit GLANCETERM_TAB_ID into the hook env, so
# the env read below is the primary (and usually only) path — including Gemini:
# gemini-cli runs hooks via \`bash -c\`/PowerShell with the FULL inherited env
# (source-confirmed; "sanitization" is opt-in and off by default), so the var
# is present here. As belt-and-braces, Gemini's installed command also appends
# the id as a 2nd arg (the shell expands it from gemini's env), which we use
# ONLY when the env var is somehow absent (e.g. a future build that sanitizes).
# An arg that arrives as an unexpanded literal (still containing '$', i.e. a
# shell that didn't expand it) is ignored so we never make a garbage-named log.
TAB_ID="\${GLANCETERM_TAB_ID:-}"
if [ -z "$TAB_ID" ]; then
    _arg="\${2:-}"
    case "$_arg" in
        ''|*'$'*) : ;;            # empty or unexpanded placeholder → ignore
        *) TAB_ID="$_arg" ;;      # a real id (UUID never contains '$')
    esac
fi

# No env var / arg = pre-injection session (started before GlanceTerm) or a tab
# we can't attribute. Emit nothing rather than poisoning a shared "unknown.json".
if [ -z "$TAB_ID" ] || [ "$TAB_ID" = "unknown" ]; then exit 0; fi

STATE_DIR="\${HOME}/.glanceterm/hooks"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Cap stdin at 1 MiB so a runaway agent can't blow up our memory.
PAYLOAD=$(head -c 1048576)
# Empty-stdin default \`{}\` — without this, an agent that fires the hook
# with no payload would let the wrapper-JSON writer in the relay branch
# emit \`{"tab_id":"X","payload":}\` which is invalid JSON, the JS-side
# parser drops it silently, and the handler then polls for 25 min with
# no chance of getting a verdict.
[ -z "\$PAYLOAD" ] && PAYLOAD='{}'

# Cheap field extraction without jq. Values are user-supplied: sed's [^"]*
# class blocks injected quotes, then tr strips backslashes + ASCII control
# bytes so a literal backslash or newline in the payload cannot break the
# JSON we emit downstream.
# tr range \\000-\\037 covers ALL ASCII control bytes (NUL through US, i.e. all
# RFC 8259 forbidden chars in JSON strings) plus the literal backslash. An
# earlier draft listed only \\000-\\031 and let 0x1A-0x1F (SUB/ESC/FS/GS/RS/US)
# through — those bytes pass the sed regex but break JSON.parse downstream,
# making the watcher silently drop the event.
SAN='tr -d "\\\\\\\\\\000-\\037"'

# Field extraction uses grep -o "key":"val" | head -1 rather than a greedy
# sed regex. The earlier sed pattern (.*"tool_name".*) matches the LAST
# occurrence of the key on the line — fine for fields Claude only ever puts at
# the top level (event/session_id/cwd) but broken for tool_name once a Task
# subagent's free-form tool_response content contains a literal
# "tool_name":"..." substring on PostToolUse, which would mis-classify the
# event and corrupt the in-flight counter. grep -o emits each match on its
# own line; head -1 takes the FIRST one, which in Claude top-level-keys-
# first payload order is the real top-level field.
#
# IMPORTANT: $1 is interpolated INTO the grep regex without escaping. All
# call sites pass static identifiers (lowercase + underscore) so this is
# safe today; if you add a caller, pass only [a-z_]+ keys — anything with
# a regex metacharacter would silently match nested fields.
extract () {
    printf '%s' "$PAYLOAD" \\
        | grep -o "\\"$1\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" \\
        | head -1 \\
        | sed -n 's/.*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' \\
        | eval "$SAN"
}

EVENT=$(extract hook_event_name)
SESSION_ID=$(extract session_id)
MATCHER=$(extract matcher)
# SessionStart \`source\` — "startup" | "resume" | "clear" | "compact". Only the
# \`compact\` value matters downstream: a post-compaction SessionStart is a
# mid-turn continuation (the agent keeps working), NOT a fresh idle session, so
# HookWatcher must NOT flip the row to idle/"ready" on it. Scoped to SessionStart
# so a nested "source" key inside some tool's payload can't leak in on other
# events. Empty on every non-SessionStart event / agents that don't send it.
SOURCE=""
if [ "\$EVENT" = "SessionStart" ]; then SOURCE=$(extract source); fi
# Active model slug. Codex sends a top-level "model" on EVERY hook event
# (live); Claude sends it only on SessionStart. Empty for events/agents that
# don't carry it — HookWatcher keeps the last non-empty value, so a one-shot
# SessionStart model sticks. (Gemini nests it under llm_request on BeforeModel
# which we don't subscribe to, so it stays empty here — see feature-matrix.)
MODEL=$(extract model)
# tool_name only present on PreToolUse / PostToolUse payloads. We need it to
# know which PreToolUse events spawn a subagent (tool_name = "Task" on older
# Claude Code, "Agent" on current) vs every other tool — only those bump the
# subagent in-flight counter that keeps the row at 'working' across main-agent
# Stop. See hook-watcher.service.ts processEvent() for the match.
TOOL_NAME=$(extract tool_name)
CWD=$(extract cwd)
# transcript_path is the absolute path to Claude's own .jsonl transcript file.
# Authoritative — Claude knows where it writes; reconstructing it from cwd is
# unsafe because the file lives at the directory where \`claude\` was launched
# (project root), not the agent's current cwd if it has cd'd into a subdir.
# Used by tabby-plugin-mobile-bridge's TranscriptTailerService.
TRANSCRIPT_PATH=$(extract transcript_path)
TS=$(date +%s)

# Subagent identity fields. Source of truth for the id-based pairing in
# hook-watcher.service.ts — see processEvent() and the AGENT_ID lifecycle
# notes there.
#
#   agent_id        present at TOP LEVEL on every hook event that fires inside
#                   a subagent's own turn (subagent's PreToolUse/PostToolUse,
#                   subagent's SubagentStop). Absent on the main agent's own
#                   events. We use it as the "which subagent is this for"
#                   key and as a passive liveness signal: any hook event with
#                   agent_id=X proves subagent X is still running, so we add
#                   X to the live set even without seeing an explicit spawn.
#   agent_type      present alongside agent_id ("general-purpose", "Explore",
#                   etc.). Mostly informational — kept so the sidebar can show
#                   "Reviewing… (Explore)" instead of just "working".
#   spawn_agent_id  extracted from PostToolUse(Agent)'s tool_response.agentId —
#                   that's where Claude returns the id of a freshly-launched
#                   subagent. Authoritative spawn signal: the moment we read
#                   it, that id is live. Note the camelCase: top-level
#                   subagent fields are snake_case (agent_id) and the nested
#                   tool_response from the Agent tool uses camelCase
#                   (agentId). \`extract\` matches on key literal so the two
#                   don't collide.
AGENT_ID=$(extract agent_id)
AGENT_TYPE=$(extract agent_type)
SPAWN_AGENT_ID=""
if [ "\$EVENT" = "PostToolUse" ] && [ "\$TOOL_NAME" = "Agent" ]; then
    SPAWN_AGENT_ID=$(extract agentId)
fi

# Monitor task lifecycle. Claude's footer reads "N shell, M monitor": shell
# is bg-Bash count (already captured via BG above), monitor is the live
# Monitor-tool task count, decremented when TaskStop fires for that id.
# Hooks expose both events but with the id nested under tool_response /
# tool_input respectively; we extract both casings (camelCase for nested
# tool_response per the agentId precedent, snake_case for tool_input per
# the run_in_background precedent) and fall back to the other if the first
# casing returns empty — costs us one extra grep per Monitor / TaskStop
# event, buys us robustness against any future field-naming drift.
MONITOR_TASK_ID=""
# Monitor's own give-up deadline (tool_input.timeout_ms). HookWatcher
# stamps the live-monitor id with start+timeout so it self-evicts —
# Claude fires no hook when a monitor ends naturally, so without this
# bound a completed monitor would inflate the "M monitor" badge until the
# next session. Number-valued, so \`extract\` (string-only) can't read it;
# grep the digits directly. Scoped to PostToolUse(Monitor) like the id,
# so the only place "timeout_ms" can appear is this monitor's tool_input.
MONITOR_TIMEOUT_MS=0
if [ "\$EVENT" = "PostToolUse" ] && [ "\$TOOL_NAME" = "Monitor" ]; then
    MONITOR_TASK_ID=$(extract taskId)
    if [ -z "\$MONITOR_TASK_ID" ]; then
        MONITOR_TASK_ID=$(extract task_id)
    fi
    MONITOR_TIMEOUT_MS=$(printf '%s' "\$PAYLOAD" \\
        | grep -oE '"timeout_ms"[[:space:]]*:[[:space:]]*[0-9]+' \\
        | head -1 \\
        | grep -oE '[0-9]+$')
    [ -z "\$MONITOR_TIMEOUT_MS" ] && MONITOR_TIMEOUT_MS=0
fi
STOP_TASK_ID=""
if [ "\$EVENT" = "PreToolUse" ] && [ "\$TOOL_NAME" = "TaskStop" ]; then
    STOP_TASK_ID=$(extract task_id)
    if [ -z "\$STOP_TASK_ID" ]; then
        STOP_TASK_ID=$(extract taskId)
    fi
fi

# Background-shell indicator: set BG=1 when this is a PreToolUse for the
# Bash tool with tool_input.run_in_background == true. Used downstream by
# TabMonitor to definitively credit a new child PID as a backgrounded
# shell (bypassing the persistence-time heuristic, which is fallback-only
# for agents we don't have hook adapters for).
#
# Pure-sh JSON parsing is not worth the code weight here — Claude emits
# well-formed JSON, and the literal pattern is unique enough across the
# documented hook payload schema that a grep is reliable. If a future
# Claude version embeds the substring inside something other than the
# tool_input field we'd over-count, but the only known location for the
# key in Claude's hook payloads IS tool_input.
BG=0
if [ "\$EVENT" = "PreToolUse" ] && [ "\$TOOL_NAME" = "Bash" ]; then
    if printf '%s' "\$PAYLOAD" | grep -qE '"run_in_background"[[:space:]]*:[[:space:]]*true'; then
        BG=1
    fi
fi

# User-interrupted tool calls surface on PostToolUse as
# tool_response.interrupted=true. Claude may not fire Stop after this path,
# so preserve the bit for HookWatcher instead of leaving the tab stuck working.
#
# Match is scoped two ways to avoid false positives where the literal
# string "interrupted":true appears elsewhere in the payload:
#   1. \`"tool_response"\` must appear in the payload at all — gates against
#      payloads that don't have a tool_response field surfacing the flag.
#   2. The \`"interrupted"\` token must be preceded by a legal JSON key
#      boundary ({, ',', or whitespace). A stdout / command echo of the
#      literal \`"interrupted":true\` would be JSON-escaped as
#      \\"interrupted\\":true, where the preceding char is a backslash —
#      that fails the \`[{,[:space:]]\` guard and is therefore ignored.
# Residual risk: a custom hook tool whose tool_input contains an
# "interrupted":true field at the legal-key position would still match.
# Documented; PowerShell handler does the JSON-typed equivalent.
INTERRUPTED=0
if [ "\$EVENT" = "PostToolUse" ]; then
    if printf '%s' "\$PAYLOAD" | grep -qE '"tool_response"[[:space:]]*:' \\
       && printf '%s' "\$PAYLOAD" | grep -qE '[{,[:space:]]"interrupted"[[:space:]]*:[[:space:]]*true'; then
        INTERRUPTED=1
    fi
fi

# Pre-resolve the auto-approve decision BEFORE writing the per-tab .log line.
# A PermissionRequest that we are about to grant instantly (auto-approve on)
# must NOT read as \`needs_permission\` in the sidebar: the tool runs the moment
# we emit the allow, but the next status-changing event (PostToolUse) only
# lands when the tool finishes — which for a long command is 1-2 min later. So
# we stamp the logged event with \`auto_approved:1\` and HookWatcher maps it to
# \`working\` instead of \`needs_permission\`.
#
# Read the flag ONCE here and reuse it in the grant branch below: reading it
# twice would let a flag toggle between the two reads desync the marker from
# the actual decision (e.g. stamp working but then NOT grant → row says working
# while the agent is really blocked on a local prompt). The guard mirrors the
# grant branch exactly — same agents, same AskUserQuestion exclusion — so we
# never stamp an event we wouldn't also auto-grant.
AUTO_APPROVED=0
if { [ "\$AGENT" = "claude" ] || [ "\$AGENT" = "codex" ]; } && [ "\$EVENT" = "PermissionRequest" ] && [ "\$TOOL_NAME" != "AskUserQuestion" ]; then
    if [ "\$(head -c 1 "\${HOME}/.glanceterm/auto-approve.flag" 2>/dev/null)" = "1" ]; then
        AUTO_APPROVED=1
    fi
fi

# IMPORTANT — write the per-tab .log line HERE (before any PermissionRequest
# handling) so HookWatcher sees the event immediately, not 25 minutes later
# when relay polling resolves. Without this, a tab sitting in permission-
# relay limbo would show no "needs permission" state in the sidebar.
OUT="\$STATE_DIR/\$TAB_ID.log"
# Append one newline-terminated JSON record. POSIX \`>>\` opens the file with
# O_APPEND, which guarantees the write goes to current EOF; for writes
# ≤ PIPE_BUF (4 KiB+ on macOS / Linux) the write is atomic with respect to
# other concurrent appenders. Our records are ~250 bytes — well under the
# limit — so two handler processes firing simultaneously cannot interleave
# bytes mid-record.
printf '{"tab_id":"%s","agent":"%s","event":"%s","matcher":"%s","tool_name":"%s","session_id":"%s","cwd":"%s","transcript_path":"%s","ts":%s,"bg":%s,"interrupted":%s,"agent_id":"%s","agent_type":"%s","spawn_agent_id":"%s","monitor_task_id":"%s","monitor_timeout_ms":%s,"stop_task_id":"%s","model":"%s","auto_approved":%s,"source":"%s"}\\n' \\
    "\$TAB_ID" "\$AGENT" "\$EVENT" "\$MATCHER" "\$TOOL_NAME" "\$SESSION_ID" "\$CWD" "\$TRANSCRIPT_PATH" "\$TS" "\$BG" "\$INTERRUPTED" "\$AGENT_ID" "\$AGENT_TYPE" "\$SPAWN_AGENT_ID" "\$MONITOR_TASK_ID" "\$MONITOR_TIMEOUT_MS" "\$STOP_TASK_ID" "\$MODEL" "\$AUTO_APPROVED" "\$SOURCE" \\
    >> "\$OUT" 2>/dev/null

# Auto-approve permission prompts (Claude + Codex). When the user has
# explicitly enabled the feature via the sidebar toggle, AutoApproveService
# writes "1" to ~/.glanceterm/auto-approve.flag; when disabled, "0". On a
# PermissionRequest, emit the allow-decision JSON. Both Claude and Codex read
# the hook's stdout for PermissionRequest and honor the SAME shape
# (hookSpecificOutput.decision.behavior = "allow") — Codex added this in
# PR #17563 (2026-04), verified against codex-rs source. For all other events /
# agents / when flag is 0, emit nothing — the agent's normal approval flow runs.
# (Note: the JSON we emit carries ONLY "behavior" — no updatedInput/
# updatedPermissions/interrupt, which Codex rejects fail-closed.) Each grant is
# appended to ~/.glanceterm/auto-approve.log (tab-separated: ts, tab_id,
# tool_name, cwd) so a user can review what was auto-approved after the fact.
# \`head -c 1\` deliberately reads only ONE byte: tolerates a trailing newline
# in the flag file (most editors add one) without an extra \`tr -d\`.
#
# Precedence (decided 2026-06-08): auto-approve short-circuits — if it
# fires, the relay branch never runs and the phone never sees this
# request. Two independent switches; users can have any combination.
#
# EXCLUDE AskUserQuestion: it is a multiple-choice question, not a yes/no
# permission — the tool's RESULT is whichever option the user picks. An
# auto "allow" (or a relayed allow/deny) runs it with NO selection, so the
# agent gets an empty answer and the turn either dies ("no answer") or
# silently proceeds on a wrong default. We emit nothing for it: the agent then
# shows its interactive A/B/C selector and the user actually chooses, and
# the sidebar row stays needs_permission ("needs you") until they do. It's a
# Claude tool name; harmless to also guard for Codex. Add any other
# selection-class tools to the guard below as they surface.
if { [ "\$AGENT" = "claude" ] || [ "\$AGENT" = "codex" ]; } && [ "\$EVENT" = "PermissionRequest" ] && [ "\$TOOL_NAME" != "AskUserQuestion" ]; then
    # AUTO_APPROVED was resolved above from a single read of auto-approve.flag
    # (reused here so the logged \`auto_approved\` marker and this grant decision
    # can never disagree). RELAY_FLAG is read fresh — it only matters on the
    # else branch, where a stale read is harmless.
    RELAY_FLAG=$(head -c 1 "\${HOME}/.glanceterm/permission-relay.flag" 2>/dev/null)
    if [ "\$AUTO_APPROVED" = "1" ]; then
        printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\\n'
        printf '%s\\t%s\\t%s\\t%s\\n' "\$TS" "\$TAB_ID" "\$TOOL_NAME" "\$CWD" \\
            >> "\${HOME}/.glanceterm/auto-approve.log" 2>/dev/null
    elif [ "\$RELAY_FLAG" = "1" ]; then
        # Mint a 5-letter id from [a-km-z] — Anthropic's anti-l/I-confusion
        # alphabet, same as their official Channels plugin. The id flows
        # into the .req filename, the IM-side keyboard callback_data
        # (\`perm:allow:<id>\`), and the decision file.
        PERM_DIR="\${HOME}/.glanceterm/permissions"
        mkdir -p "\$PERM_DIR" 2>/dev/null
        PERM_ID=$(LC_ALL=C tr -dc 'a-km-z' < /dev/urandom 2>/dev/null | head -c 5)
        # Fallback if /dev/urandom is unreadable (sandbox / unusual fs);
        # awk \`rand()\` seeded with \$\$ + epoch nanos avoids the all-zero
        # collision that a constant fallback id would cause.
        if [ -z "\$PERM_ID" ]; then
            PERM_ID=$(awk -v s="\$\$\${TS}" 'BEGIN{srand(s);a="abcdefghijkmnopqrstuvwxyz";o="";for(i=0;i<5;i++)o=o substr(a,int(rand()*25)+1,1);print o}')
        fi
        REQ_FILE="\$PERM_DIR/\$PERM_ID.req"
        DEC_FILE="\$PERM_DIR/\$PERM_ID.decision"
        # Wrapper JSON: \`{"tab_id":"...","payload":<raw>}\`. tab_id is
        # outside payload so JS-side can route to the right tab without
        # heuristics (cwd / session_id matching is unreliable when the
        # user has several tabs in the same dir). PAYLOAD is itself a
        # JSON object so embedding it after \`"payload":\` yields a valid
        # outer JSON document.
        printf '{"tab_id":"%s","payload":%s}' "\$TAB_ID" "\$PAYLOAD" > "\$REQ_FILE" 2>/dev/null
        # Poll for the decision file. 15000 × 0.1 s = ~25 min ceiling —
        # safety net for a forgotten request. Claude's own local dialog
        # is NOT shown during this poll (we own the hook); on timeout
        # we exit with no output and Claude falls back to its built-in
        # approval prompt. (A local "cancel relay, ask me here" sidebar
        # escape-hatch is in scope for mobile-bridge-v2 Block 1.5 but
        # NOT implemented in v1 — see todo-mobile-bridge-v2.md.)
        # Each iteration is one stat syscall; negligible CPU.
        PERM_I=0
        while [ "\$PERM_I" -lt 15000 ]; do
            if [ -f "\$DEC_FILE" ]; then
                DEC=$(head -c 16 "\$DEC_FILE" 2>/dev/null | tr -d '\\n\\r ')
                rm -f "\$REQ_FILE" "\$DEC_FILE" 2>/dev/null
                if [ "\$DEC" = "allow" ] || [ "\$DEC" = "deny" ]; then
                    printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"%s"}}}\\n' "\$DEC"
                    printf '%s\\t%s\\t%s\\t%s\\trelay\\t%s\\n' "\$TS" "\$TAB_ID" "\$TOOL_NAME" "\$CWD" "\$DEC" \\
                        >> "\${HOME}/.glanceterm/permission-relay.log" 2>/dev/null
                else
                    # \"cancel\" or anything else: exit silent, Claude's local dialog handles it.
                    printf '%s\\t%s\\t%s\\t%s\\trelay\\tcancel\\n' "\$TS" "\$TAB_ID" "\$TOOL_NAME" "\$CWD" \\
                        >> "\${HOME}/.glanceterm/permission-relay.log" 2>/dev/null
                fi
                break
            fi
            sleep 0.1
            PERM_I=$((PERM_I + 1))
        done
        if [ "\$PERM_I" -ge 15000 ]; then
            rm -f "\$REQ_FILE" 2>/dev/null
            printf '%s\\t%s\\t%s\\t%s\\trelay\\ttimeout\\n' "\$TS" "\$TAB_ID" "\$TOOL_NAME" "\$CWD" \\
                >> "\${HOME}/.glanceterm/permission-relay.log" 2>/dev/null
        fi
    fi
fi

# Per-tab .log already written above; nothing else to do.
exit 0
`

/**
 * Embedded PowerShell hook handler — written to
 * `%USERPROFILE%\\.glanceterm\\handlers\\glanceterm-hook.ps1` on Windows.
 * Invoked via `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <path> <agent>`
 * which sidesteps the system-wide execution policy without modifying it.
 *
 * Same contract as HANDLER_SH; PowerShell handles the JSON parsing natively
 * via ConvertFrom-Json, which is more robust than the sh regex extraction.
 */
const HANDLER_PS1 = `# GlanceTerm hook handler (Windows / PowerShell) — see hook-runtime.service.ts.
# DO NOT EDIT BY HAND — regenerated on every GlanceTerm launch.
param([string]$Agent = "unknown", [string]$TabIdArg = "")
$ErrorActionPreference = "SilentlyContinue"

# Tab id: env var for Claude/Codex (inherited into the hook env); for Gemini
# (sanitized env) the installed hook command passes the id as a 2nd arg, which
# gemini expands from "$GLANCETERM_TAB_ID" against its own process env. Ignore
# an unexpanded placeholder (still contains '$') so we don't make a garbage log.
$tabId = $env:GLANCETERM_TAB_ID
if (-not $tabId) {
    if ($TabIdArg -and ($TabIdArg -notmatch '\\$')) { $tabId = $TabIdArg }
}
# No env var / arg = pre-injection session; can't attribute, so silently exit
# rather than writing to a shared "unknown.json" the watcher would have to
# disambiguate later.
if (-not $tabId -or $tabId -eq "unknown") { exit 0 }

$stateDir = Join-Path $env:USERPROFILE ".glanceterm\\hooks"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

# Read stdin and cap at 1 MiB so a runaway agent can't blow up memory.
$payload = [Console]::In.ReadToEnd()
if ($payload.Length -gt 1048576) { $payload = $payload.Substring(0, 1048576) }
# Empty-stdin default '{}' — see HANDLER_SH for the rationale (wrapper-
# JSON validity in the relay branch).
if ([string]::IsNullOrEmpty($payload)) { $payload = '{}' }

# Native JSON parse — much cleaner than the sh regex approach.
try { $json = $payload | ConvertFrom-Json } catch { exit 0 }

# Claude's matcher can be a string OR an object. We only persist the string
# form, since the only matcher our adapter currently looks at is the
# permission_prompt|elicitation_dialog one (always a string).
$matcher = ""
if ($json.matcher -and ($json.matcher -is [string])) { $matcher = [string]$json.matcher }

# tool_name only present on PreToolUse / PostToolUse — see the sh handler
# comment for the rationale (Task subagent in-flight counter).
$toolName = ""
if ($json.tool_name -and ($json.tool_name -is [string])) { $toolName = [string]$json.tool_name }

# SessionStart \`source\` — see HANDLER_SH. Only \`compact\` matters downstream
# (a post-compaction SessionStart must NOT flip the row to idle). Scoped to
# SessionStart; empty everywhere else.
$source = ""
if ([string]$json.hook_event_name -eq "SessionStart" -and $json.source -and ($json.source -is [string])) {
    $source = [string]$json.source
}

# Subagent identity — see the HANDLER_SH equivalent block for the full
# contract. PowerShell can hit nested fields directly via ConvertFrom-Json,
# so the spawn-id extraction is just $json.tool_response.agentId — no
# regex fishing in the raw payload.
$agentId = ""
if ($json.agent_id -and ($json.agent_id -is [string])) { $agentId = [string]$json.agent_id }
$agentType = ""
if ($json.agent_type -and ($json.agent_type -is [string])) { $agentType = [string]$json.agent_type }
$spawnAgentId = ""
if ([string]$json.hook_event_name -eq "PostToolUse" -and $toolName -eq "Agent") {
    if ($json.tool_response -and $json.tool_response.agentId) {
        $spawnAgentId = [string]$json.tool_response.agentId
    }
}

# Monitor task lifecycle — mirror of the HANDLER_SH block. PowerShell can
# traverse nested fields directly, so we hit tool_response.taskId /
# tool_input.task_id without regex. Same dual-casing fallback: try the
# casing that matches the per-section precedent first (camelCase under
# tool_response, snake_case under tool_input), fall back to the other.
$monitorTaskId = ""
# Monitor's give-up deadline (tool_input.timeout_ms) — see HANDLER_SH for
# why HookWatcher needs it to self-evict completed monitors. Number-valued;
# default 0 when absent so HookWatcher falls back to DEFAULT_MONITOR_TTL_MS.
$monitorTimeoutMs = 0
if ([string]$json.hook_event_name -eq "PostToolUse" -and $toolName -eq "Monitor") {
    if ($json.tool_response) {
        if ($json.tool_response.taskId) {
            $monitorTaskId = [string]$json.tool_response.taskId
        } elseif ($json.tool_response.task_id) {
            $monitorTaskId = [string]$json.tool_response.task_id
        }
    }
    if ($json.tool_input -and $json.tool_input.timeout_ms) {
        # [long] + floor for parity with HANDLER_SH's digit-truncating
        # grep: [int] is Int32 and THROWS on > ~24.8 days of ms (aborting
        # the handler → the Monitor add is lost), and rounds floats where
        # the SH path truncates. [long] floors a fractional timeout_ms.
        $monitorTimeoutMs = [long][math]::Floor([double]$json.tool_input.timeout_ms)
    }
}
$stopTaskId = ""
if ([string]$json.hook_event_name -eq "PreToolUse" -and $toolName -eq "TaskStop") {
    if ($json.tool_input) {
        if ($json.tool_input.task_id) {
            $stopTaskId = [string]$json.tool_input.task_id
        } elseif ($json.tool_input.taskId) {
            $stopTaskId = [string]$json.tool_input.taskId
        }
    }
}

# Background-shell indicator — see HANDLER_SH for the rationale. PowerShell
# has native JSON parsing so we can read tool_input.run_in_background
# directly rather than regex-matching the raw payload.
$bg = 0
if ([string]$json.hook_event_name -eq "PreToolUse" -and $toolName -eq "Bash") {
    if ($json.tool_input -and $json.tool_input.run_in_background -eq $true) {
        $bg = 1
    }
}

# Pre-resolve auto-approve BEFORE building/writing the .log line — see
# HANDLER_SH for why an auto-approved PermissionRequest must be stamped
# auto_approved:1 so the sidebar shows \`working\`, not a stuck
# \`needs_permission\`, while the granted tool runs. Read the flag ONCE and reuse
# it in the grant branch below so a toggle between reads can't desync the marker
# from the actual decision.
$autoApproved = 0
if (($Agent -eq "claude" -or $Agent -eq "codex") -and [string]$json.hook_event_name -eq "PermissionRequest" -and $toolName -ne "AskUserQuestion") {
    try {
        if ((([System.IO.File]::ReadAllText((Join-Path $env:USERPROFILE ".glanceterm\\auto-approve.flag"))).Trim()) -eq "1") { $autoApproved = 1 }
    } catch {}
}

$out = [ordered]@{
    tab_id          = [string]$tabId
    agent           = [string]$Agent
    event           = [string]$json.hook_event_name
    matcher         = $matcher
    tool_name       = $toolName
    session_id      = [string]$json.session_id
    cwd             = [string]$json.cwd
    # See HANDLER_SH for why this field is authoritative and cwd-derived
    # paths are wrong.
    transcript_path = [string]$json.transcript_path
    ts              = [int][double]::Parse((Get-Date -UFormat %s))
    bg              = [int]$bg
    interrupted     = [int]$(if ($json.hook_event_name -eq "PostToolUse" -and $json.tool_response -and $json.tool_response.interrupted -eq $true) { 1 } else { 0 })
    agent_id        = $agentId
    agent_type      = $agentType
    spawn_agent_id  = $spawnAgentId
    monitor_task_id = $monitorTaskId
    monitor_timeout_ms = [long]$monitorTimeoutMs
    stop_task_id    = $stopTaskId
    # Active model slug — Codex sends it on every event, Claude on SessionStart;
    # empty otherwise (HookWatcher keeps the last non-empty). See HANDLER_SH.
    model           = [string]$json.model
    # 1 when this PermissionRequest is being auto-approved (see above) — tells
    # HookWatcher to render \`working\` rather than a stuck \`needs_permission\`.
    auto_approved   = [int]$autoApproved
    # SessionStart source (\`compact\` etc.) — lets HookWatcher keep a
    # post-compaction SessionStart from flipping the row to idle. See above.
    source          = [string]$source
}

# IMPORTANT — write the per-tab .log line HERE (before any PermissionRequest
# handling) so HookWatcher sees the event immediately, not 25 minutes later
# when relay polling resolves. See HANDLER_SH for the rationale.
$outPath = Join-Path $stateDir "\$tabId.log"
$line = ($out | ConvertTo-Json -Compress) + "\`n"
[System.IO.File]::AppendAllText($outPath, $line, [System.Text.Encoding]::UTF8)

# Auto-approve permission prompts (Claude + Codex) — mirror of the POSIX
# block in HANDLER_SH. See hook-runtime.service.ts comments there for the
# full rationale (both agents honor the same decision JSON; Codex since
# PR #17563). When enabled, AutoApproveService writes "1" to
# %USERPROFILE%\\.glanceterm\\auto-approve.flag.
#
# EXCLUDE AskUserQuestion (see HANDLER_SH): it's a multiple-choice question,
# not a yes/no permission, so "allow" runs it with no selection and the agent
# gets an empty answer. Emit nothing — the agent shows its interactive selector
# and the row stays needs_permission until the user picks.
if (($Agent -eq "claude" -or $Agent -eq "codex") -and $out.event -eq "PermissionRequest" -and $out.tool_name -ne "AskUserQuestion") {
    # $autoApproved was resolved above from a single read of auto-approve.flag
    # (reused here so the logged auto_approved marker and this grant decision
    # can never disagree). $relayFlag is read fresh — it only matters on the
    # else branch, where a stale read is harmless.
    $relayFlagFile = Join-Path $env:USERPROFILE ".glanceterm\\permission-relay.flag"
    $relayFlag = ""
    try { $relayFlag = ([System.IO.File]::ReadAllText($relayFlagFile)).Trim() } catch {}
    if ($autoApproved -eq 1) {
        # Claude reads stdout for sync hooks. Hard-coded JSON (rather than
        # ConvertTo-Json on a hashtable) keeps the on-the-wire payload
        # byte-identical to the POSIX handler, which simplifies regression
        # comparison and avoids any future PowerShell key-ordering surprise.
        #
        # Use Write + explicit \`n (LF) rather than WriteLine — the latter
        # emits CRLF on Windows, and if Claude's stdout reader line-splits
        # on \\n and feeds the trailing \\r into its JSON parser it would
        # treat the decision as malformed. LF matches the POSIX handler.
        [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' + "\`n")
        $auditPath = Join-Path $env:USERPROFILE ".glanceterm\\auto-approve.log"
        $auditLine = ("{0}\`t{1}\`t{2}\`t{3}\`n" -f $out.ts, $out.tab_id, $out.tool_name, $out.cwd)
        [System.IO.File]::AppendAllText($auditPath, $auditLine, [System.Text.Encoding]::UTF8)
    } elseif ($relayFlag -eq "1") {
        # Permission relay — see HANDLER_SH for the full rationale. Same
        # 5-letter id alphabet, same .req/.decision file contract, same
        # ~25 min poll ceiling, same fall-through-to-local-dialog on
        # timeout/cancel.
        $permDir = Join-Path $env:USERPROFILE ".glanceterm\\permissions"
        New-Item -ItemType Directory -Path $permDir -Force | Out-Null
        $alpha = "abcdefghijkmnopqrstuvwxyz"  # no l (Anthropic alphabet)
        # Explicit Guid-derived seed — \`New-Object System.Random\` with no seed
        # uses Environment.TickCount on PowerShell 5.1 (default Windows shell),
        # which means two handlers spawned in the same millisecond (concurrent
        # tabs / subagent fan-out) get IDENTICAL seeds → identical 5-letter
        # ids → second .req overwrites the first, losing one request and
        # routing its verdict to the wrong tab. NewGuid is cheap and per-call
        # unique; GetHashCode squeezes it to the Int32 the Random ctor wants.
        $rng = New-Object System.Random ([System.Guid]::NewGuid().GetHashCode())
        $permId = -join (1..5 | ForEach-Object { $alpha[$rng.Next(0, $alpha.Length)] })
        $reqFile = Join-Path $permDir "\$permId.req"
        $decFile = Join-Path $permDir "\$permId.decision"
        # Wrapper JSON \`{"tab_id":"...","payload":<raw>}\` — see HANDLER_SH
        # for the rationale (clean tab routing without cwd heuristics).
        $wrapper = '{"tab_id":"' + $tabId + '","payload":' + $payload + '}'
        [System.IO.File]::WriteAllText($reqFile, $wrapper, [System.Text.Encoding]::UTF8)
        $auditPath = Join-Path $env:USERPROFILE ".glanceterm\\permission-relay.log"
        $decided = $false
        for ($i = 0; $i -lt 15000; $i++) {
            if (Test-Path $decFile) {
                $dec = ""
                try { $dec = ([System.IO.File]::ReadAllText($decFile)).Trim() } catch {}
                Remove-Item -Force $reqFile, $decFile -ErrorAction SilentlyContinue
                if ($dec -eq "allow" -or $dec -eq "deny") {
                    [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"' + $dec + '"}}}' + "\`n")
                    $line = ("{0}\`t{1}\`t{2}\`t{3}\`trelay\`t{4}\`n" -f $out.ts, $out.tab_id, $out.tool_name, $out.cwd, $dec)
                } else {
                    $line = ("{0}\`t{1}\`t{2}\`t{3}\`trelay\`tcancel\`n" -f $out.ts, $out.tab_id, $out.tool_name, $out.cwd)
                }
                [System.IO.File]::AppendAllText($auditPath, $line, [System.Text.Encoding]::UTF8)
                $decided = $true
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if (-not $decided) {
            Remove-Item -Force $reqFile -ErrorAction SilentlyContinue
            $line = ("{0}\`t{1}\`t{2}\`t{3}\`trelay\`ttimeout\`n" -f $out.ts, $out.tab_id, $out.tool_name, $out.cwd)
            [System.IO.File]::AppendAllText($auditPath, $line, [System.Text.Encoding]::UTF8)
        }
    }
}

# Per-tab .log already written above; nothing else to do.
exit 0
`

/**
 * Owns the on-disk hook runtime — the platform-appropriate handler script
 * and the per-tab state directory. Single source of truth for those
 * filesystem paths; the installer service and watcher service both ask
 * this service for them.
 */
@Injectable({ providedIn: 'root' })
export class HookRuntimeService {
    /** Root of all GlanceTerm filesystem state. Resolved from `$HOME`
     *  (POSIX) / `$USERPROFILE` (Windows) at construction, matching the
     *  embedded handler scripts which expand the same env vars. Using
     *  the env var directly — not `os.homedir()` — because the latter
     *  caches its result inside Node's userInfo() lookup and ignores
     *  runtime env changes, which would silently desync the TS-side
     *  root from the handler-side root in tests that redirect HOME
     *  into a tempdir. */
    readonly root = path.join(homeFromEnv(), '.glanceterm')
    /** Per-tab status files written by the handler script. */
    readonly stateDir = path.join(this.root, 'hooks')
    /** Permission-relay request/decision files. Pre-created in doEnsure()
     *  so the hook handler's first \`mkdir -p\` is a no-op; same dir is
     *  also fs.watched by tabby-plugin-mobile-bridge's PermissionRelayService. */
    readonly permissionsDir = path.join(this.root, 'permissions')
    /** Where the handler scripts live (we write BOTH so a user dragging the
     *  home folder between platforms keeps working). */
    readonly handlerDir = path.join(this.root, 'handlers')
    readonly shHandlerPath = path.join(this.handlerDir, 'glanceterm-hook.sh')
    readonly ps1HandlerPath = path.join(this.handlerDir, 'glanceterm-hook.ps1')

    private ready: Promise<void> | null = null

    /**
     * Absolute path to the handler appropriate for THIS platform. Adapters
     * compose the actual invocation string via `handlerInvocation(agentId)`,
     * which adds the right prefix (`powershell.exe -NoProfile …` on Windows)
     * and the agent id arg.
     */
    get handlerPath (): string {
        return process.platform === 'win32' ? this.ps1HandlerPath : this.shHandlerPath
    }

    /**
     * The exact `command` string the agent's settings file should record.
     * Encapsulates the platform-specific invocation prefix so adapters
     * don't each have to re-derive it.
     */
    handlerInvocation (agentId: string): string {
        if (process.platform === 'win32') {
            // -NoProfile dodges user profile load (faster startup); Bypass on
            // ExecutionPolicy is scoped to this single invocation and does not
            // change the system policy.
            return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${winQuote(this.ps1HandlerPath)} ${agentId}`
        }
        return `${posixQuote(this.shHandlerPath)} ${agentId}`
    }

    /**
     * Ensures the state directory and handler scripts exist with current
     * content + executable mode. Idempotent. Re-writes the scripts every
     * launch so an upgraded GlanceTerm can ship a new handler without the
     * user manually clearing the old one.
     */
    ensureReady (): Promise<void> {
        if (!this.ready) this.ready = this.doEnsure()
        return this.ready
    }

    private async doEnsure (): Promise<void> {
        await fs.mkdir(this.stateDir, { recursive: true })
        await fs.mkdir(this.handlerDir, { recursive: true })
        await fs.mkdir(this.permissionsDir, { recursive: true })

        // Write BOTH scripts on every platform — cheap, and means the user
        // copying their home dir between machines keeps working.
        await safeAtomicWrite(this.shHandlerPath, HANDLER_SH, 0o755)
        await safeAtomicWrite(this.ps1HandlerPath, HANDLER_PS1, 0o644)

        // chmod is a no-op on Windows but cheap and needed on POSIX in case
        // mode= on writeFile didn't take (some FUSE/NFS mounts).
        if (process.platform !== 'win32') {
            try { await fs.chmod(this.shHandlerPath, 0o755) } catch { /* swallow */ }
        }
    }
}

/**
 * Read the user's home from the environment, falling back to
 * `os.homedir()` only when neither HOME nor USERPROFILE is set. The
 * fallback matters for daemon-launched cases where Node's startup didn't
 * inherit the user shell's env; everywhere else, the env value is
 * authoritative and matches what the embedded handler scripts read.
 */
function homeFromEnv (): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
}

/**
 * Atomic write with two safety nets:
 *
 *   1. If the target's current content already equals the new content, skip
 *      the rename — needed on Windows where overwriting an executable that
 *      powershell.exe is currently running fails with ERROR_SHARING_VIOLATION
 *      (issue M5). For an idempotent re-run on launch this is the common case.
 *
 *   2. Temp filename uses crypto.randomUUID() rather than just PID — two
 *      Tabby instances starting concurrently have different PIDs but could
 *      still race; UUID + same-content short-circuit makes the operation
 *      genuinely safe under parallel launches (related: issue C2/M7 for the
 *      settings.json mutator, which adds a lockfile on top of this).
 */
async function safeAtomicWrite (target: string, content: string, mode: number): Promise<void> {
    // Same-content short-circuit: read the existing file, compare hashes,
    // skip the rename entirely if they match. Hash because content can be
    // ~1.5 KiB and equality on Buffer is cheap regardless, but hash also
    // makes the intent obvious.
    try {
        const existing = await fs.readFile(target, 'utf8')
        if (hash(existing) === hash(content)) return
    } catch (e: any) {
        if (e?.code !== 'ENOENT') {
            // unreadable but exists — fall through to write attempt
        }
    }

    const tmp = `${target}.tmp.${crypto.randomUUID()}`
    await fs.writeFile(tmp, content, { encoding: 'utf8', mode })
    try {
        await fs.rename(tmp, target)
    } catch (e: any) {
        // Windows ReplaceFileW raises EBUSY / EPERM when the target file is
        // open (e.g. powershell.exe is mid-execution of the script). Since
        // we already verified the on-disk content doesn't match what we'd
        // write, give up gracefully: the running handler is "good enough"
        // until the next launch when nothing's executing.
        if (process.platform === 'win32' && (e?.code === 'EBUSY' || e?.code === 'EPERM')) {
            try { await fs.unlink(tmp) } catch { /* */ }
            return
        }
        // Clean up the temp file on any other failure too.
        try { await fs.unlink(tmp) } catch { /* */ }
        throw e
    }
}

function hash (s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex')
}

/** Single-quote for POSIX shells; escape embedded single quotes. */
function posixQuote (p: string): string {
    return `'${p.replace(/'/g, `'\\''`)}'`
}

/** Double-quote for cmd.exe; escape embedded double quotes. */
function winQuote (p: string): string {
    return `"${p.replace(/"/g, '\\"')}"`
}
