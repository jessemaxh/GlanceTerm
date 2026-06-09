import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'

import type { AiTool } from '../tab-monitor'
import { TabStatus } from '../tab-monitor'
import { HookAdapter, HookEventEntry, InstallReport } from './adapter'

// Cross-platform note: every fs/process touchpoint in this file must work
// on Windows too. Settings path uses os.homedir() (Windows USERPROFILE),
// JSON write uses fs.rename (atomic on POSIX + NTFS), and the hook
// command string is platform-prebuilt by HookRuntimeService — we never
// touch shell-quoting here.

/**
 * Claude Code's hook system: each event maps to a list of "matcher blocks",
 * each containing a list of `{type, command, async?}` entries. The shape:
 *
 *   {
 *     "hooks": {
 *       "UserPromptSubmit": [
 *         { "hooks": [ { "type": "command", "command": "<our handler>", "async": true } ] }
 *       ],
 *       ...
 *     }
 *   }
 *
 * Reference: https://code.claude.com/docs/en/hooks
 *
 * Event list rationale — two complementary paths to `needs_permission`:
 *
 *   1. `PermissionRequest` — the canonical event for inline "y/n" tool
 *      permission prompts (e.g. `Bash(rm *)` when the user's
 *      permissions.ask list matches). Per the docs it fires reliably the
 *      moment Claude renders the dialog, regardless of terminal focus.
 *      An earlier iteration of this adapter dropped this subscription
 *      under the (mistaken) belief that it was Agent SDK-only and the
 *      CLI ignored it — restoring it is what fixes the "Claude is sat
 *      on a rm * prompt but the sidebar still says working" bug.
 *
 *   2. `Notification` (matcher `permission_prompt|elicitation_dialog`) —
 *      kept as a backstop. Notification is documented as observability-
 *      only, but it does fire on permission-related notifications under
 *      some configurations (and on `elicitation_dialog` for MCP
 *      elicitations, which PermissionRequest doesn't cover). Both
 *      events map to `needs_permission`; whichever arrives first wins.
 *
 * `PreToolUse` / `PostToolUse` map to `working`. Two motivations:
 *
 *   - Counter side-channel: HookWatcher uses PreToolUse with
 *     `tool_name: "Task"` or `"Agent"` (the same tool, renamed by Anthropic
 *     mid-flight) to increment the subagent-in-flight tracker.
 *   - **Unsticking needs_permission**: when the user approves an inline
 *     prompt, Claude does not emit a discrete "permission resolved" event.
 *     The next signal is the tool actually running — i.e. PostToolUse —
 *     followed by further Pre/PostToolUse pairs as the AI keeps working.
 *     Without mapping these to `working`, the row stayed red right up
 *     until the main agent's next `Stop`, which can be minutes of the AI
 *     visibly working with a stale "needs you" badge.
 *
 * The historical worry — "PreToolUse fires BEFORE PermissionRequest, so
 * mapping it to working would race PermissionRequest" — is moot. They
 * arrive in the same tool-invocation window within milliseconds, and
 * PermissionRequest is last-writer, so the user sees needs_permission
 * stable. Only the POST-approval Pre/PostToolUse — where no
 * PermissionRequest follows — actually changes display state.
 */

interface ClaudeHookEntry {
    type: 'command'
    command: string
    async?: boolean
}

interface ClaudeHookMatcher {
    matcher?: string
    hooks: ClaudeHookEntry[]
}

type ClaudeSettings = Record<string, unknown> & {
    hooks?: Record<string, ClaudeHookMatcher[]>
}

/** Outcome of readSettings — discriminated so install can distinguish
 *  "file not present" (safe to start with `{}`) from "file present but
 *  unparseable" (UNSAFE to overwrite, would destroy user data — issue C3). */
type ReadResult =
    | { kind: 'missing' }
    | { kind: 'ok'; settings: ClaudeSettings }
    | { kind: 'malformed'; reason: string }

const EVENTS: HookEventEntry[] = [
    { event: 'SessionStart',      async: true },
    { event: 'UserPromptSubmit',  async: true },
    { event: 'PreToolUse',        async: true },
    // PostToolUse is what unsticks `needs_permission` after the user
    // approves an inline prompt — see the head comment for the full
    // rationale. Doubles per-turn hook traffic vs not subscribing, but
    // each invocation is sub-100 ms async so it doesn't block Claude.
    { event: 'PostToolUse',       async: true },
    { event: 'Stop',              async: true },
    // Claude can end a turn through StopFailure instead of Stop. Treat it as
    // a terminal per-turn signal so interrupted/error turns don't remain
    // displayed as working when no Stop follows.
    { event: 'StopFailure',       async: true },
    // Subagent lifecycle. When the main agent invokes the `Task` tool to
    // background a subagent, the main agent's response ends immediately and
    // fires Stop — so without this subscription the sidebar drops to "ready"
    // while the subagent is still chewing on tokens. HookWatcher uses
    // PreToolUse(tool=Task) + SubagentStop to maintain an in-flight counter,
    // and TabMonitor overrides idle → working while the counter is non-zero.
    { event: 'SubagentStop',      async: true },
    // Canonical event for the inline `Bash(rm *)`-style permission dialog.
    // Fires reliably regardless of terminal focus (unlike Notification).
    //
    // Registered **synchronously** (async:false) so Claude reads our hook
    // handler's stdout — that's how the P0 auto-approve feature returns a
    // `decision.behavior: "allow"` JSON to bypass the prompt when the user
    // has flipped the toggle on. Sync hook entries block Claude's main loop
    // until the handler exits, but PermissionRequest only fires when Claude
    // is *about* to ask the user (i.e. already going to block), so this
    // adds zero latency to normal tool calls. The handler is a sub-100 ms
    // shell/PS script that writes the audit log + decision JSON and exits.
    //
    // The earlier async:true registration is detected and "upgraded" in
    // installHooks() — see the comment at the upgrade branch below.
    { event: 'PermissionRequest', async: false },
    // Backstop / MCP elicitation coverage — matcher narrows to the two
    // notification types that mean "user must decide". Documented as
    // observability-only, but fires in some cases PermissionRequest
    // doesn't cover (e.g. elicitation_dialog).
    { event: 'Notification',      async: true, matcher: 'permission_prompt|elicitation_dialog' },
    { event: 'SessionEnd',        async: true },
]

export class ClaudeHookAdapter extends HookAdapter {
    readonly id: AiTool = 'claude'
    readonly displayName = 'Claude Code'

    configFilePath (): string {
        // Claude Code writes settings.json under $CLAUDE_CONFIG_DIR if set,
        // else ~/.claude. We mirror that resolution — no surprise locations.
        const override = process.env.CLAUDE_CONFIG_DIR
        const dir = override && override.trim() ? override : path.join(os.homedir(), '.claude')
        return path.join(dir, 'settings.json')
    }

    hookEvents (): HookEventEntry[] {
        return EVENTS
    }

    async isInstalled (): Promise<boolean> {
        const r = await this.readSettings()
        if (r.kind !== 'ok' || !r.settings.hooks) return false
        for (const ev of EVENTS) {
            const matchers = r.settings.hooks[ev.event]
            if (!matchers || !this.findOurEntry(matchers)) return false
        }
        return true
    }

    async installHooks (handlerCommand: string): Promise<InstallReport> {
        const settingsPath = this.configFilePath()
        return withFileLock(`${settingsPath}.lock`, async () => {
            // Re-read INSIDE the lock — important. The version we read before
            // acquiring the lock could be stale if another writer (a second
            // Tabby launch, Claude itself, the user's editor) raced us.
            // (issue C2/M7)
            const r = await this.readSettings()

            // Parse-error path (issue C3): the existing file is a non-empty
            // garbage blob. Writing `{}` over it would obliterate everything
            // the user had. Abort loudly instead — re-attempt on next launch
            // once the user has fixed their file.
            if (r.kind === 'malformed') {
                // eslint-disable-next-line no-console
                console.error(
                    `[glanceterm] refusing to install Claude hooks: ${settingsPath} is not valid JSON ` +
                    `(${r.reason}). Fix or remove the file, then re-launch GlanceTerm.`,
                )
                return { installed: false, settingsPath }
            }

            const settings: ClaudeSettings = r.kind === 'ok' ? r.settings : {}
            const hooks: Record<string, ClaudeHookMatcher[]> = (settings.hooks as any) ?? {}

            let changed = false
            for (const ev of EVENTS) {
                const list = hooks[ev.event] ?? []
                const ours = this.findAllOurEntries(list)
                if (ours.length > 0) {
                    // Upgrade path: bring EVERY existing GlanceTerm entry's
                    // `async` flag in sync with what EVENTS now declares.
                    // Added when P0 auto-approve flipped PermissionRequest
                    // from async:true → async:false — a user who upgraded
                    // GlanceTerm with the old entry still in
                    // ~/.claude/settings.json would have a `async:true` entry
                    // whose stdout Claude ignores, so the auto-approve
                    // toggle would silently no-op until manual cleanup.
                    //
                    // We iterate ALL matches (not just the first) for the
                    // edge case of a user with duplicated entries — copy-
                    // pasted between machines, or remnants of an earlier
                    // bug. Leaving one un-upgraded would still defeat
                    // auto-approve depending on which entry Claude picks
                    // first when reading stdout.
                    const shouldBeAsync = !!ev.async
                    for (const existing of ours) {
                        const isAsync = existing.async === true
                        if (shouldBeAsync && !isAsync) {
                            existing.async = true
                            changed = true
                        } else if (!shouldBeAsync && isAsync) {
                            delete existing.async
                            changed = true
                        }
                    }
                    continue
                }

                const entry: ClaudeHookEntry = {
                    type: 'command',
                    command: handlerCommand,
                    ...(ev.async ? { async: true } : {}),
                }
                const matcherBlock: ClaudeHookMatcher = {
                    ...(ev.matcher ? { matcher: ev.matcher } : {}),
                    hooks: [entry],
                }
                list.push(matcherBlock)
                hooks[ev.event] = list
                changed = true
            }

            if (!changed) {
                return { installed: false, settingsPath }
            }

            settings.hooks = hooks
            await this.writeSettings(settings)
            return { installed: true, settingsPath }
        })
    }

    async uninstallHooks (): Promise<void> {
        const settingsPath = this.configFilePath()
        await withFileLock(`${settingsPath}.lock`, async () => {
            const r = await this.readSettings()
            // Same parse-error policy as install: don't touch a file we
            // can't parse — we'd nuke the user's data.
            if (r.kind !== 'ok' || !r.settings.hooks) return

            let changed = false
            for (const [event, matchers] of Object.entries(r.settings.hooks)) {
                const filtered: ClaudeHookMatcher[] = []
                for (const m of matchers) {
                    const before = m.hooks.length
                    const survivors = m.hooks.filter(h => !this.isOurEntry(h))
                    if (survivors.length !== before) changed = true
                    if (survivors.length > 0) filtered.push({ ...m, hooks: survivors })
                }
                if (filtered.length === 0) {
                    delete r.settings.hooks[event]
                } else {
                    r.settings.hooks[event] = filtered
                }
            }

            if (changed) {
                await this.writeSettings(r.settings)
            }
        })
    }

    mapEventToStatus (event: string, _matcher?: string): TabStatus | null {
        switch (event) {
            case 'UserPromptSubmit':
                return TabStatus.Working
            case 'PreToolUse':
            case 'PostToolUse':
                // The AI is actively running a tool. Map both to working —
                // this is what unsticks a row from `needs_permission` once
                // the user approves a prompt: the next PreToolUse (the AI
                // executing the approved tool, or its successor tool) wins
                // over the lingering needs_permission, and PostToolUse keeps
                // the row honest while Claude continues thinking between
                // tool calls. Without this, the row stays red until the next
                // Stop (whole turn ends) — which can be minutes, with the AI
                // visibly working the whole time.
                //
                // The old worry "PreToolUse fires BEFORE PermissionRequest"
                // is moot: PermissionRequest follows within milliseconds and
                // overwrites back to needs_permission, so the user never
                // sees the brief working → needs_permission ping. Only the
                // post-approval Pre/PostToolUse — where no PermissionRequest
                // follows — actually changes display state.
                return TabStatus.Working
            case 'Stop':
            case 'StopFailure':
                return TabStatus.Idle
            case 'SubagentStop':
                // A subagent finishing is not the same as the main agent
                // finishing — we don't change the row's displayed status
                // here. The HookWatcher uses this event purely to decrement
                // its in-flight subagent counter; whatever the main agent's
                // current status is (working / idle / needs_permission)
                // remains correct.
                return null
            case 'PermissionRequest':
                return TabStatus.NeedsPermission
            case 'Notification':
                // The settings.json matcher already narrowed the firing set
                // to permission_prompt|elicitation_dialog — any Notification
                // we receive here is a permission ask. We trust the install-
                // time matcher rather than re-checking a `matcher` field in
                // the payload (which Claude does not always populate).
                return TabStatus.NeedsPermission
            case 'SessionStart':
                return TabStatus.Idle
            case 'SessionEnd':
                return TabStatus.NoAi
            default:
                return null
        }
    }

    // The Claude handler script classifies EVERY PreToolUse(Bash) as bg=0 or
    // bg=1 by reading tool_input.run_in_background. So a child of the Claude
    // process whose parent PreToolUse carried bg=0 (synchronous) is NEVER a
    // background job, even if it runs for minutes (e.g. xcodebuild). Letting
    // TabMonitor know we honour this contract lets it skip the persistence-
    // time heuristic that would otherwise falsely badge long sync calls.
    override signalsBgJobs (): boolean {
        return true
    }

    // ── internals ────────────────────────────────────────────────────────

    /**
     * Identify OUR hook entries — robust across:
     *   POSIX:   `'.../glanceterm-hook.sh' claude`
     *   Windows: `powershell.exe -File "...\\glanceterm-hook.ps1" claude`
     *
     * Strategy: require BOTH the script filename (uniquely identifies "an
     * entry installed by some GlanceTerm adapter") AND the agent id as a
     * standalone token (so a Codex adapter's entry doesn't get matched as
     * Claude's — issue Min2 in the v0.2 review).
     */
    private readonly agentTokenRe = new RegExp(`(?:^|[\\s/\\\\"'])${escapeRegex(this.id)}(?:[\\s"']|$)`)
    private isOurEntry (h: ClaudeHookEntry): boolean {
        if (h?.type !== 'command' || typeof h.command !== 'string') return false
        if (!h.command.includes('glanceterm-hook')) return false
        return this.agentTokenRe.test(h.command)
    }

    private findOurEntry (matchers: ClaudeHookMatcher[]): ClaudeHookEntry | undefined {
        for (const m of matchers) {
            const found = m.hooks?.find(h => this.isOurEntry(h))
            if (found) return found
        }
        return undefined
    }

    /**
     * Collect EVERY GlanceTerm-owned entry across every matcher block. Used
     * by the install upgrade path so a user with hand-duplicated entries gets
     * all of them brought to current spec, not just the first one Claude
     * happens to read. Returns mutable references — callers mutate in place
     * and the surrounding install flow's writeSettings() persists.
     */
    private findAllOurEntries (matchers: ClaudeHookMatcher[]): ClaudeHookEntry[] {
        const out: ClaudeHookEntry[] = []
        for (const m of matchers) {
            for (const h of m.hooks ?? []) {
                if (this.isOurEntry(h)) out.push(h)
            }
        }
        return out
    }

    /** Read settings, returning a tagged outcome so callers can react. */
    private async readSettings (): Promise<ReadResult> {
        const p = this.configFilePath()
        let raw: string
        try {
            raw = await fs.readFile(p, 'utf8')
        } catch (e: any) {
            if (e?.code === 'ENOENT') return { kind: 'missing' }
            return { kind: 'malformed', reason: e?.message ?? 'unreadable' }
        }
        // Treat empty file as missing — Claude does the same.
        if (!raw.trim()) return { kind: 'missing' }
        try {
            const settings = JSON.parse(raw) as ClaudeSettings
            return { kind: 'ok', settings }
        } catch (e: any) {
            return { kind: 'malformed', reason: e?.message ?? 'parse error' }
        }
    }

    /** Atomic write with 2-space JSON formatting. Caller MUST hold the file lock. */
    private async writeSettings (settings: ClaudeSettings): Promise<void> {
        const p = this.configFilePath()
        await fs.mkdir(path.dirname(p), { recursive: true })
        const tmp = `${p}.tmp.${crypto.randomUUID()}`
        const content = JSON.stringify(settings, null, 2) + '\n'
        await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
        try {
            // Atomic on POSIX. On Windows fs.rename via ReplaceFileW is also
            // atomic; just slower under contention.
            await fs.rename(tmp, p)
        } catch (e) {
            try { await fs.unlink(tmp) } catch { /* */ }
            throw e
        }
    }
}

/** Convenience for the installer service. */
export function claudeSettingsPathSync (): string {
    const override = process.env.CLAUDE_CONFIG_DIR
    const dir = override && override.trim() ? override : path.join(os.homedir(), '.claude')
    return path.join(dir, 'settings.json')
}

/**
 * Returns true if Claude is "established" on this machine — defined as
 * `~/.claude/` existing as a directory. This is stricter than checking for
 * settings.json (Claude only creates that file when the user changes a
 * setting; long-time users may never have one) and looser than checking
 * for the binary itself (Claude may be installed via npm/pnpm/yarn in
 * many ways).
 *
 * Used by HookInstallerService to decide whether to mutate ~/.claude/ at
 * all — without it we'd be pre-creating the directory on machines that
 * have never seen Claude, which the v0.2 review flagged as risky for
 * Claude's first-run wizard (issue M6).
 */
export function claudeConfigDirExistsSync (): boolean {
    try {
        const override = process.env.CLAUDE_CONFIG_DIR
        const dir = override && override.trim() ? override : path.join(os.homedir(), '.claude')
        return fsSync.statSync(dir).isDirectory()
    } catch {
        return false
    }
}

/**
 * Cross-process advisory lock via O_EXCL create. Two Tabby instances racing
 * to install hooks would otherwise BOTH read pre-install settings, BOTH
 * append our entries, and the second writer would silently drop the first
 * writer's modifications to other settings. (issue C2/M7)
 *
 * Stale-lock recovery: if the lock file is older than 30s, we assume the
 * holding process crashed and reclaim it. 30s is comfortably above the
 * expected install time (<100ms) and short enough that a crashed launch
 * doesn't paralyze the next one.
 */
/** Exported for reuse by sibling adapters (codex.ts and future ones) that
 *  need the same atomic-write discipline. Importing from claude.ts beats
 *  duplicating the implementation in every adapter; the function is pure
 *  enough that there's no behavioural coupling. */
export async function withFileLock<T> (lockPath: string, fn: () => Promise<T>): Promise<T> {
    const TIMEOUT_MS = 5_000
    const POLL_MS = 50
    const STALE_MS = 30_000
    const start = Date.now()

    await fs.mkdir(path.dirname(lockPath), { recursive: true })

    while (true) {
        try {
            const handle = await fs.open(lockPath, 'wx')
            await handle.writeFile(`${process.pid}\n`)
            await handle.close()
            break
        } catch (e: any) {
            if (e?.code !== 'EEXIST') throw e
            // Probe for staleness, then either reclaim or wait.
            try {
                const st = await fs.stat(lockPath)
                if (Date.now() - st.mtimeMs > STALE_MS) {
                    await fs.unlink(lockPath).catch(() => {})
                    continue
                }
            } catch { /* lock disappeared between EEXIST and stat — retry */ }
            if (Date.now() - start > TIMEOUT_MS) {
                throw new Error(`could not acquire ${lockPath} within ${TIMEOUT_MS}ms`)
            }
            await new Promise(r => setTimeout(r, POLL_MS))
        }
    }

    try {
        return await fn()
    } finally {
        try { await fs.unlink(lockPath) } catch { /* swallow */ }
    }
}

/** Exported sibling helper — see withFileLock above. */
export function escapeRegex (s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
