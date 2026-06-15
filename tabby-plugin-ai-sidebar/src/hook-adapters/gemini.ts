import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'

import type { AiTool } from '../tab-monitor'
import { TabStatus } from '../tab-monitor'
import { HookAdapter, HookEventEntry, InstallReport } from './adapter'
import { withFileLock, escapeRegex } from './claude'

/**
 * Gemini CLI's hook system (https://geminicli.com/docs/hooks/, shipped
 * v0.26.0 / 2026-01-28). Config lives in `~/.gemini/settings.json` under a
 * top-level `hooks` object, schema close to Claude's:
 *
 *   { "hooks": { "<EventName>": [ { "matcher"?, "sequential"?,
 *       "hooks": [ { "type": "command", "command": "...", "name"?,
 *                    "timeout"? } ] } ] } }
 *
 * Two things make Gemini NOT a 1:1 clone of claude.ts / codex.ts:
 *
 *   1. **Event names differ.** Gemini uses `BeforeAgent` / `AfterAgent` for
 *      turn start/end (its analogue of Claude's UserPromptSubmit / Stop),
 *      and `BeforeTool` / `AfterTool` for tool activity. We subscribe to
 *      exactly the events needed for a truthful working/idle badge — see
 *      EVENTS + mapEventToStatus.
 *
 *   2. **Tab id via command arg (source-confirmed).** We APPEND
 *      `"$GLANCETERM_TAB_ID"` to the installed hook command. Verified against
 *      gemini-cli source (`packages/core/src/hooks/hookRunner.ts`, commit
 *      1d2adf7, 2026-06): Gemini runs each hook via `spawn('bash', ['-c',
 *      command])` (PowerShell `-Command` on Windows) with the FULL inherited
 *      `process.env` by default — env "sanitization" is opt-in
 *      (`enableEnvironmentVariableRedaction`, default false) and even when on
 *      keeps a non-secret name like `GLANCETERM_TAB_ID` (only GitHub-Actions
 *      strict mode strips it). So bash expands `"$GLANCETERM_TAB_ID"` to its
 *      real value, AND the var is present in the hook env directly — the
 *      handler's normal env read works too, with the arg as belt-and-braces.
 *      The handler takes the arg only when its own env lacks the var and
 *      discards an unexpanded literal. Everything downstream (per-tab `.log`,
 *      watcher, TabMonitor correlation) is identical to Claude's. The only
 *      residual unknown is end-to-end behaviour on a live install (events
 *      actually firing) — not the routing mechanism.
 *
 * NEEDS-PERMISSION (deferred): Gemini surfaces a tool-approval prompt via the
 * `Notification` event with `notification_type == "ToolPermission"`. We do NOT
 * subscribe to it in v1 because it's unconfirmed whether the settings `matcher`
 * filters `Notification` by `notification_type` — subscribing without a working
 * filter would map every system notification to needs_permission (false
 * alarms). Add it once the matcher behaviour is validated on a real install;
 * the mapEventToStatus switch has a placeholder comment marking where.
 *
 * AUTO-APPROVE: not possible for Gemini. The `Notification`/`ToolPermission`
 * event is advisory ("cannot grant permissions automatically") and `BeforeTool`
 * only supports a `deny` decision, never `allow`. The shield toggle stays inert
 * for Gemini tabs (the auto-approve branch in the handler is gated on
 * `AGENT = claude || codex`, never Gemini).
 *
 * STATUS: UNTESTED end-to-end. Written from the Gemini hooks docs + verified
 * against gemini-cli source (2026-06-10): the settings schema matches Claude's
 * and the tab-id routing mechanism (point 2 above) is source-confirmed. What's
 * left to confirm on a real install is purely runtime — that the events fire as
 * documented. Track in docs/feature-matrix.md.
 */

interface GeminiHookEntry {
    type: 'command'
    command: string
    name?: string
    timeout?: number
}

interface GeminiHookMatcher {
    matcher?: string
    sequential?: boolean
    hooks: GeminiHookEntry[]
}

type GeminiSettings = Record<string, unknown> & {
    hooks?: Record<string, GeminiHookMatcher[]>
}

type ReadResult =
    | { kind: 'missing' }
    | { kind: 'ok'; settings: GeminiSettings }
    | { kind: 'malformed'; reason: string }

/**
 * Events we subscribe to. v1 covers the truthful working/idle pair plus
 * session bracketing; tool events reaffirm `working` mid-turn (harmless
 * even though BeforeAgent→AfterAgent already spans the whole turn).
 * `async` is carried for interface parity but NOT serialized — Gemini's
 * schema has no per-hook async flag (it has `sequential`, which we leave
 * at its default).
 */
const EVENTS: HookEventEntry[] = [
    { event: 'SessionStart', async: true },
    { event: 'BeforeAgent',  async: true },
    { event: 'AfterAgent',   async: true },
    { event: 'BeforeTool',   async: true },
    { event: 'AfterTool',    async: true },
    { event: 'SessionEnd',   async: true },
]

export class GeminiHookAdapter extends HookAdapter {
    readonly id: AiTool = 'gemini'
    readonly displayName = 'Gemini CLI'

    configFilePath (): string {
        return path.join(geminiConfigDirSync(), 'settings.json')
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
            const r = await this.readSettings()

            if (r.kind === 'malformed') {
                // eslint-disable-next-line no-console
                console.error(
                    `[glanceterm] refusing to install Gemini hooks: ${settingsPath} is not valid JSON ` +
                    `(${r.reason}). Fix or remove the file, then re-launch GlanceTerm.`,
                )
                return { installed: false, settingsPath }
            }

            const settings: GeminiSettings = r.kind === 'ok' ? r.settings : {}
            const hooks: Record<string, GeminiHookMatcher[]> = (settings.hooks as any) ?? {}

            // Append the per-tab id as a 2nd arg. The env var is the primary
            // path (gemini-cli runs hooks via `bash -c` / PowerShell `-Command`
            // with the full inherited env — source-confirmed), so the handler's
            // env read already resolves it. The arg is belt-and-braces: the
            // shell expands it from gemini's env at fire time. Platform-aware
            // because the Windows hook runs under PowerShell, where the env ref
            // is `$env:NAME`, not POSIX `$NAME`.
            const tabIdToken = process.platform === 'win32'
                ? '"$env:GLANCETERM_TAB_ID"'
                : '"$GLANCETERM_TAB_ID"'
            const command = `${handlerCommand} ${tabIdToken}`

            let changed = false
            for (const ev of EVENTS) {
                const list = hooks[ev.event] ?? []
                const ours = this.findAllOurEntries(list)
                if (ours.length > 0) {
                    // Reconcile the command on re-install (format drift, e.g. the
                    // appended arg changes) AND collapse any duplicate GlanceTerm
                    // entries to one (residue from copy-paste / an earlier bug).
                    // The user's own hooks are untouched. Idempotent: a single
                    // already-correct entry is left as-is (no settings write).
                    let kept = false
                    let droppedDup = false
                    for (const m of list) {
                        if (!Array.isArray(m.hooks)) continue   // foreign/malformed matcher — leave untouched
                        m.hooks = m.hooks.filter(h => {
                            if (!this.isOurEntry(h)) return true
                            if (kept) { changed = true; droppedDup = true; return false }   // drop duplicate
                            kept = true
                            if (h.command !== command) { h.command = command; changed = true }
                            return true
                        })
                    }
                    if (droppedDup) {
                        const compacted = list.filter(m => !Array.isArray(m.hooks) || m.hooks.length > 0)
                        if (compacted.length !== list.length) { hooks[ev.event] = compacted; changed = true }
                    }
                    continue
                }
                const entry: GeminiHookEntry = {
                    type: 'command',
                    command,
                    name: 'glanceterm',
                }
                const matcherBlock: GeminiHookMatcher = {
                    ...(ev.matcher ? { matcher: ev.matcher } : {}),
                    hooks: [entry],
                }
                list.push(matcherBlock)
                hooks[ev.event] = list
                changed = true
            }

            if (!changed) return { installed: false, settingsPath }

            settings.hooks = hooks
            await this.writeSettings(settings)
            return { installed: true, settingsPath }
        })
    }

    async uninstallHooks (): Promise<boolean> {
        const settingsPath = this.configFilePath()
        return withFileLock(`${settingsPath}.lock`, async () => {
            const r = await this.readSettings()
            if (r.kind !== 'ok' || !r.settings.hooks) return false

            let changed = false
            for (const [event, matchers] of Object.entries(r.settings.hooks)) {
                const filtered: GeminiHookMatcher[] = []
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

            if (changed) await this.writeSettings(r.settings)
            return changed
        })
    }

    mapEventToStatus (event: string, _matcher?: string): TabStatus | null {
        switch (event) {
            case 'BeforeAgent':
            case 'BeforeTool':
            case 'AfterTool':
                // Anywhere inside a turn → working. AfterAgent (below) is the
                // single end-of-turn signal that releases back to idle.
                return TabStatus.Working
            case 'AfterAgent':
                // "Fires once per turn after the model generates its final
                // response" — the canonical waiting-for-user signal.
                return TabStatus.Idle
            case 'SessionStart':
                return TabStatus.Idle
            case 'SessionEnd':
                return TabStatus.NoAi
            // needs_permission (deferred): add a `Notification` case here once
            // it's confirmed the settings matcher can narrow to
            // notification_type == "ToolPermission". Until then, subscribing
            // would risk mapping unrelated notifications to needs_permission.
            default:
                return null
        }
    }

    // ── internals (parallel to codex.ts / claude.ts) ──────────────────────

    private readonly agentTokenRe = new RegExp(`(?:^|[\\s/\\\\"'])${escapeRegex(this.id)}(?:[\\s"']|$)`)
    private isOurEntry (h: GeminiHookEntry): boolean {
        if (h?.type !== 'command' || typeof h.command !== 'string') return false
        if (!h.command.includes('glanceterm-hook')) return false
        return this.agentTokenRe.test(h.command)
    }

    private findOurEntry (matchers: GeminiHookMatcher[]): GeminiHookEntry | undefined {
        for (const m of matchers) {
            const found = m.hooks?.find(h => this.isOurEntry(h))
            if (found) return found
        }
        return undefined
    }

    private findAllOurEntries (matchers: GeminiHookMatcher[]): GeminiHookEntry[] {
        const out: GeminiHookEntry[] = []
        for (const m of matchers) {
            for (const h of m.hooks ?? []) {
                if (this.isOurEntry(h)) out.push(h)
            }
        }
        return out
    }

    private async readSettings (): Promise<ReadResult> {
        const p = this.configFilePath()
        let raw: string
        try {
            raw = await fs.readFile(p, 'utf8')
        } catch (e: any) {
            if (e?.code === 'ENOENT') return { kind: 'missing' }
            return { kind: 'malformed', reason: e?.message ?? 'unreadable' }
        }
        if (!raw.trim()) return { kind: 'missing' }
        try {
            const settings = JSON.parse(raw) as GeminiSettings
            return { kind: 'ok', settings }
        } catch (e: any) {
            return { kind: 'malformed', reason: e?.message ?? 'parse error' }
        }
    }

    private async writeSettings (settings: GeminiSettings): Promise<void> {
        const p = this.configFilePath()
        await fs.mkdir(path.dirname(p), { recursive: true })
        const tmp = `${p}.tmp.${crypto.randomUUID()}`
        const content = JSON.stringify(settings, null, 2) + '\n'
        await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
        try {
            await fs.rename(tmp, p)
        } catch (e) {
            try { await fs.unlink(tmp) } catch { /* */ }
            throw e
        }
    }
}

/**
 * "Gemini is established on this machine" — gate for the installer. Mirrors
 * the Claude/Codex versions: directory existence, not binary presence.
 */
export function geminiConfigDirExistsSync (): boolean {
    try {
        return fsSync.statSync(geminiConfigDirSync()).isDirectory()
    } catch { return false }
}

function geminiConfigDirSync (): string {
    // Gemini CLI reads settings from ~/.gemini (user scope). No documented
    // home-override env var (GEMINI_PROJECT_DIR is the project root, not the
    // config dir), so we resolve `~` ourselves.
    //
    // Resolve home from the environment (HOME / USERPROFILE) rather than
    // os.homedir(): `~` IS $HOME (the same expansion gemini does), and the
    // env read honours a redirected HOME in tests — os.homedir() ignores
    // runtime HOME changes (see hook-runtime.service.ts homeFromEnv for the
    // same reasoning), which would make this adapter read/write the REAL
    // ~/.gemini under test and clobber the user's config.
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
    return path.join(home, '.gemini')
}
