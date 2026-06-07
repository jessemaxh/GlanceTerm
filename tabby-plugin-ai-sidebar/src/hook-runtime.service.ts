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
TAB_ID="\${GLANCETERM_TAB_ID:-}"

# No env var = pre-injection Claude session (started before GlanceTerm). We
# can't attribute this event to any sidebar row, so emit nothing rather than
# poisoning a shared "unknown.json".
if [ -z "$TAB_ID" ] || [ "$TAB_ID" = "unknown" ]; then exit 0; fi

STATE_DIR="\${HOME}/.glanceterm/hooks"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Cap stdin at 1 MiB so a runaway agent can't blow up our memory.
PAYLOAD=$(head -c 1048576)

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
# tool_name only present on PreToolUse / PostToolUse payloads. We need it to
# know which PreToolUse events spawn a subagent (tool_name = "Task" on older
# Claude Code, "Agent" on current) vs every other tool — only those bump the
# subagent in-flight counter that keeps the row at 'working' across main-agent
# Stop. See hook-watcher.service.ts processEvent() for the match.
TOOL_NAME=$(extract tool_name)
CWD=$(extract cwd)
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

# Auto-approve permission prompts (Claude only, P0). When the user has
# explicitly enabled the feature via the sidebar toggle, AutoApproveService
# writes "1" to ~/.glanceterm/auto-approve.flag; when disabled, "0". For
# Claude's PermissionRequest event (registered with async:false in
# claude.ts so Claude reads stdout), emit the allow-decision JSON. For all
# other events / agents / when flag is 0, emit nothing — Claude's normal
# approval flow runs. Each grant is appended to ~/.glanceterm/auto-approve.log
# (tab-separated: ts, tab_id, tool_name, cwd) so a user can review what
# was auto-approved after the fact.
# \`head -c 1\` deliberately reads only ONE byte: tolerates a trailing newline
# in the flag file (most editors add one) without an extra \`tr -d\`.
if [ "\$AGENT" = "claude" ] && [ "\$EVENT" = "PermissionRequest" ]; then
    FLAG=$(head -c 1 "\${HOME}/.glanceterm/auto-approve.flag" 2>/dev/null)
    if [ "\$FLAG" = "1" ]; then
        printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\\n'
        printf '%s\\t%s\\t%s\\t%s\\n' "\$TS" "\$TAB_ID" "\$TOOL_NAME" "\$CWD" \\
            >> "\${HOME}/.glanceterm/auto-approve.log" 2>/dev/null
    fi
fi

OUT="$STATE_DIR/$TAB_ID.log"

# Append one newline-terminated JSON record. POSIX \`>>\` opens the file with
# O_APPEND, which guarantees the write goes to current EOF; for writes
# ≤ PIPE_BUF (4 KiB+ on macOS / Linux) the write is atomic with respect to
# other concurrent appenders. Our records are ~250 bytes — well under the
# limit — so two handler processes firing simultaneously cannot interleave
# bytes mid-record.
printf '{"tab_id":"%s","agent":"%s","event":"%s","matcher":"%s","tool_name":"%s","session_id":"%s","cwd":"%s","ts":%s,"bg":%s,"agent_id":"%s","agent_type":"%s","spawn_agent_id":"%s"}\\n' \\
    "$TAB_ID" "$AGENT" "$EVENT" "$MATCHER" "$TOOL_NAME" "$SESSION_ID" "$CWD" "$TS" "$BG" "$AGENT_ID" "$AGENT_TYPE" "$SPAWN_AGENT_ID" \\
    >> "$OUT" 2>/dev/null

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
param([string]$Agent = "unknown")
$ErrorActionPreference = "SilentlyContinue"

$tabId = $env:GLANCETERM_TAB_ID
# No env var = pre-injection session; can't attribute, so silently exit
# rather than writing to a shared "unknown.json" the watcher would have to
# disambiguate later.
if (-not $tabId -or $tabId -eq "unknown") { exit 0 }

$stateDir = Join-Path $env:USERPROFILE ".glanceterm\\hooks"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

# Read stdin and cap at 1 MiB so a runaway agent can't blow up memory.
$payload = [Console]::In.ReadToEnd()
if ($payload.Length -gt 1048576) { $payload = $payload.Substring(0, 1048576) }

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

# Background-shell indicator — see HANDLER_SH for the rationale. PowerShell
# has native JSON parsing so we can read tool_input.run_in_background
# directly rather than regex-matching the raw payload.
$bg = 0
if ([string]$json.hook_event_name -eq "PreToolUse" -and $toolName -eq "Bash") {
    if ($json.tool_input -and $json.tool_input.run_in_background -eq $true) {
        $bg = 1
    }
}

$out = [ordered]@{
    tab_id          = [string]$tabId
    agent           = [string]$Agent
    event           = [string]$json.hook_event_name
    matcher         = $matcher
    tool_name       = $toolName
    session_id      = [string]$json.session_id
    cwd             = [string]$json.cwd
    ts              = [int][double]::Parse((Get-Date -UFormat %s))
    bg              = [int]$bg
    agent_id        = $agentId
    agent_type      = $agentType
    spawn_agent_id  = $spawnAgentId
}

# Auto-approve permission prompts (Claude only, P0) — mirror of the POSIX
# block in HANDLER_SH. See hook-runtime.service.ts comments there for the
# full rationale. When the user has enabled the feature, AutoApproveService
# writes "1" to %USERPROFILE%\\.glanceterm\\auto-approve.flag.
if ($Agent -eq "claude" -and $out.event -eq "PermissionRequest") {
    $flagFile = Join-Path $env:USERPROFILE ".glanceterm\\auto-approve.flag"
    $flag = ""
    try { $flag = ([System.IO.File]::ReadAllText($flagFile)).Trim() } catch {}
    if ($flag -eq "1") {
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
    }
}

$outPath = Join-Path $stateDir "$tabId.log"

# Append one NDJSON record. See HANDLER_SH for the rationale (single-file
# overwrite + fs.watch coalescing lost fast event pairs). NTFS does not give
# the POSIX-style O_APPEND atomicity guarantee, but System.IO.File.AppendAllText
# opens with FILE_APPEND_DATA which serializes appends at the OS level for
# small writes — and concurrent Claude handler instances for the same tab are
# rare enough (Claude runs hooks async per event, not per turn) that the
# residual interleave risk is acceptable. If it ever bites us, switch to a
# named mutex.
$line = ($out | ConvertTo-Json -Compress) + "\`n"
[System.IO.File]::AppendAllText($outPath, $line, [System.Text.Encoding]::UTF8)
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
    /** Root of all GlanceTerm filesystem state. */
    readonly root = path.join(os.homedir(), '.glanceterm')
    /** Per-tab status files written by the handler script. */
    readonly stateDir = path.join(this.root, 'hooks')
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
