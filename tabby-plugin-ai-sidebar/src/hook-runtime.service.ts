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
 * Output: writes `~/.glanceterm/hooks/<TAB_ID>.json` (atomic rename pattern).
 * Always exits 0 — failed status writes must not stall the agent's main loop.
 *
 * Hardening notes (post-review fixes):
 *   - Extracted fields are run through `tr -d '\\\000-\031'` to strip
 *     backslashes + control bytes; without this, a malicious cwd / matcher
 *     containing `\` or a literal newline would produce unparseable JSON that
 *     the watcher silently drops (issue C1 in the v0.2 review).
 *   - If `GLANCETERM_TAB_ID` is missing/empty/"unknown", exit silently instead
 *     of writing to `hooks/unknown.json` — that file would otherwise get
 *     overwritten by every pre-injection Claude session and never match a
 *     real tab (issue M3).
 */
const HANDLER_SH = `#!/bin/sh
# GlanceTerm hook handler (POSIX) — see hook-runtime.service.ts for the contract.
# DO NOT EDIT BY HAND — regenerated on every GlanceTerm launch.
set -u

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
SAN='tr -d "\\\\\\\\\\000\\001\\002\\003\\004\\005\\006\\007\\010\\011\\012\\013\\014\\015\\016\\017\\020\\021\\022\\023\\024\\025\\026\\027\\030\\031"'
EVENT=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1 | eval "$SAN")
SESSION_ID=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1 | eval "$SAN")
MATCHER=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"matcher"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1 | eval "$SAN")
CWD=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1 | eval "$SAN")
TS=$(date +%s)

OUT="$STATE_DIR/$TAB_ID.json"
TMP="$OUT.tmp.$$"

cat > "$TMP" <<EOF_GT
{"tab_id":"$TAB_ID","agent":"$AGENT","event":"$EVENT","matcher":"$MATCHER","session_id":"$SESSION_ID","cwd":"$CWD","ts":$TS}
EOF_GT

mv "$TMP" "$OUT" 2>/dev/null
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

$out = [ordered]@{
    tab_id     = [string]$tabId
    agent      = [string]$Agent
    event      = [string]$json.hook_event_name
    matcher    = $matcher
    session_id = [string]$json.session_id
    cwd        = [string]$json.cwd
    ts         = [int][double]::Parse((Get-Date -UFormat %s))
}

$outPath = Join-Path $stateDir "$tabId.json"
$tmpPath = "$outPath.tmp.$PID"
$out | ConvertTo-Json -Compress | Out-File -FilePath $tmpPath -Encoding utf8 -NoNewline
Move-Item -Force -Path $tmpPath -Destination $outPath
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
