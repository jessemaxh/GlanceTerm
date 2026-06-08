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
 * Codex CLI's hook system (https://developers.openai.com/codex/hooks) ships
 * with an almost-1:1 schema to Claude Code's: same JSON shape (events →
 * matcher blocks → array of {type, command, ...} entries), same event names
 * (PreToolUse, PostToolUse, PermissionRequest, SessionStart, UserPromptSubmit,
 * Stop, SubagentStart, SubagentStop, PreCompact, PostCompact), and the same
 * stdin payload fields (hook_event_name, session_id, cwd, tool_name,
 * tool_input, tool_response on PostToolUse). That means this adapter is
 * largely a clone of claude.ts with three changes:
 *
 *   1. Settings file path: ~/.codex/hooks.json (Codex also accepts hooks
 *      under [hooks] in config.toml, but the JSON path is the cleaner write
 *      target — we never have to navigate TOML's nested table semantics).
 *   2. No async:true / async:false distinction. Codex's docs don't document
 *      a per-hook async flag — we omit it on every entry and let Codex run
 *      hooks however it normally runs them. Our handler is fast (<100ms),
 *      so blocking is fine.
 *   3. No auto-approve hookSpecificOutput. Codex docs explicitly call out
 *      that PermissionRequest only supports `systemMessage` — `continue`,
 *      `stopReason`, and `suppressOutput` aren't supported, and there's no
 *      documented `decision: { behavior: "allow" }` channel. The shield
 *      toggle therefore stays inert for Codex tabs (status detection still
 *      works, the auto-allow path doesn't). Marked clearly in the feature
 *      matrix.
 *
 * STATUS: UNTESTED. Written from the Codex hooks docs without a
 * verifying install on this machine. Architecture confidence is high
 * because the schemas overlap so heavily with Claude's (the docs read
 * like the authors copied Claude's design); behavioural confidence is
 * lower until someone runs Codex with these hooks installed and the
 * NDJSON log shows events arriving with the expected shape. Track in
 * the feature_agent_matrix memory file.
 */

interface CodexHookEntry {
    type: 'command'
    command: string
    statusMessage?: string
    timeout?: number
}

interface CodexHookMatcher {
    matcher?: string
    hooks: CodexHookEntry[]
}

type CodexSettings = Record<string, unknown> & {
    hooks?: Record<string, CodexHookMatcher[]>
}

type ReadResult =
    | { kind: 'missing' }
    | { kind: 'ok'; settings: CodexSettings }
    | { kind: 'malformed'; reason: string }

const EVENTS: HookEventEntry[] = [
    { event: 'SessionStart',      async: true },
    { event: 'UserPromptSubmit',  async: true },
    { event: 'PreToolUse',        async: true },
    { event: 'PostToolUse',       async: true },
    { event: 'Stop',              async: true },
    { event: 'SubagentStop',      async: true },
    // PermissionRequest registered here for status visibility (Codex
    // blocking on a tool approval should surface as needs_permission in
    // the sidebar). We do NOT use it for auto-allow — see the head
    // comment for why.
    { event: 'PermissionRequest', async: true },
]

export class CodexHookAdapter extends HookAdapter {
    readonly id: AiTool = 'codex'
    readonly displayName = 'Codex'

    configFilePath (): string {
        // Codex writes settings under ~/.codex/. Project-local
        // <repo>/.codex/hooks.json is also supported by Codex, but the
        // installer runs at GlanceTerm startup with no notion of which
        // project the user will work in — the home-directory file is
        // the right default scope.
        return path.join(os.homedir(), '.codex', 'hooks.json')
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
                    `[glanceterm] refusing to install Codex hooks: ${settingsPath} is not valid JSON ` +
                    `(${r.reason}). Fix or remove the file, then re-launch GlanceTerm.`,
                )
                return { installed: false, settingsPath }
            }

            const settings: CodexSettings = r.kind === 'ok' ? r.settings : {}
            const hooks: Record<string, CodexHookMatcher[]> = (settings.hooks as any) ?? {}

            let changed = false
            for (const ev of EVENTS) {
                const list = hooks[ev.event] ?? []
                const ours = this.findAllOurEntries(list)
                if (ours.length > 0) continue   // already installed for this event
                const entry: CodexHookEntry = {
                    type: 'command',
                    command: handlerCommand,
                }
                const matcherBlock: CodexHookMatcher = {
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

    async uninstallHooks (): Promise<void> {
        const settingsPath = this.configFilePath()
        await withFileLock(`${settingsPath}.lock`, async () => {
            const r = await this.readSettings()
            if (r.kind !== 'ok' || !r.settings.hooks) return

            let changed = false
            for (const [event, matchers] of Object.entries(r.settings.hooks)) {
                const filtered: CodexHookMatcher[] = []
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
        })
    }

    mapEventToStatus (event: string, _matcher?: string): TabStatus | null {
        // The mapping is identical to Claude's because the event semantics
        // overlap completely. If Codex ever diverges (e.g. a Stop semantic
        // that doesn't match Claude's "main agent done with this turn"),
        // adjust here.
        switch (event) {
            case 'UserPromptSubmit':
            case 'PreToolUse':
            case 'PostToolUse':
                return TabStatus.Working
            case 'Stop':
                return TabStatus.Idle
            case 'SubagentStop':
                return null
            case 'PermissionRequest':
                return TabStatus.NeedsPermission
            case 'SessionStart':
                return TabStatus.Idle
            default:
                return null
        }
    }

    // ── internals (parallel to claude.ts) ─────────────────────────────────

    private readonly agentTokenRe = new RegExp(`(?:^|[\\s/\\\\"'])${escapeRegex(this.id)}(?:[\\s"']|$)`)
    private isOurEntry (h: CodexHookEntry): boolean {
        if (h?.type !== 'command' || typeof h.command !== 'string') return false
        if (!h.command.includes('glanceterm-hook')) return false
        return this.agentTokenRe.test(h.command)
    }

    private findOurEntry (matchers: CodexHookMatcher[]): CodexHookEntry | undefined {
        for (const m of matchers) {
            const found = m.hooks?.find(h => this.isOurEntry(h))
            if (found) return found
        }
        return undefined
    }

    private findAllOurEntries (matchers: CodexHookMatcher[]): CodexHookEntry[] {
        const out: CodexHookEntry[] = []
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
            const settings = JSON.parse(raw) as CodexSettings
            return { kind: 'ok', settings }
        } catch (e: any) {
            return { kind: 'malformed', reason: e?.message ?? 'parse error' }
        }
    }

    private async writeSettings (settings: CodexSettings): Promise<void> {
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
 * "Codex is established on this machine" — gate for the installer. Mirrors
 * the Claude version: directory existence (synchronous check), not binary
 * presence or settings file presence.
 */
export function codexConfigDirExistsSync (): boolean {
    try {
        const dir = path.join(os.homedir(), '.codex')
        return fsSync.statSync(dir).isDirectory()
    } catch { return false }
}
