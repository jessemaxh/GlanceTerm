import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'

import type { AiTool, TabStatus } from '../tab-monitor'
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
 * `PreToolUse` is subscribed for one specific transition: when the user
 * answers a permission prompt with "approve", the next event Claude fires
 * is PreToolUse for the actual tool. Mapping it to `working` flips the
 * row out of needs_permission instantly instead of leaving it stuck red
 * until the eventual Stop. PreToolUse fires for every tool call (not just
 * post-permission), so the mapping is a no-op when status was already
 * `working` — cost is one harmless re-emit per tool call, coalesced by
 * the watcher's 60ms debounce.
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
    { event: 'Stop',              async: true },
    // Subagent lifecycle. When the main agent invokes the `Task` tool to
    // background a subagent, the main agent's response ends immediately and
    // fires Stop — so without this subscription the sidebar drops to "ready"
    // while the subagent is still chewing on tokens. HookWatcher uses
    // PreToolUse(tool=Task) + SubagentStop to maintain an in-flight counter,
    // and TabMonitor overrides idle → working while the counter is non-zero.
    { event: 'SubagentStop',      async: true },
    // Canonical event for the inline `Bash(rm *)`-style permission dialog.
    // Fires reliably regardless of terminal focus (unlike Notification).
    { event: 'PermissionRequest', async: true },
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
                if (this.findOurEntry(list)) continue   // already wired

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
                return 'working'
            case 'PreToolUse':
                // Flips the row out of needs_permission instantly when the
                // user approves a permission prompt — the next event Claude
                // fires after approval is PreToolUse for the actual tool.
                // Harmless re-affirmation for tools that didn't go through
                // a permission step.
                return 'working'
            case 'Stop':
                return 'idle'
            case 'SubagentStop':
                // A subagent finishing is not the same as the main agent
                // finishing — we don't change the row's displayed status
                // here. The HookWatcher uses this event purely to decrement
                // its in-flight subagent counter; whatever the main agent's
                // current status is (working / idle / needs_permission)
                // remains correct.
                return null
            case 'PermissionRequest':
                return 'needs_permission'
            case 'Notification':
                // The settings.json matcher already narrowed the firing set
                // to permission_prompt|elicitation_dialog — any Notification
                // we receive here is a permission ask. We trust the install-
                // time matcher rather than re-checking a `matcher` field in
                // the payload (which Claude does not always populate).
                return 'needs_permission'
            case 'SessionStart':
                return 'idle'
            case 'SessionEnd':
                return 'no_ai'
            default:
                return null
        }
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
async function withFileLock<T> (lockPath: string, fn: () => Promise<T>): Promise<T> {
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

function escapeRegex (s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
