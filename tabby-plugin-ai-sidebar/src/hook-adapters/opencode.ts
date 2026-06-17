import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'

import type { AiTool } from '../tab-monitor'
import { TabStatus } from '../tab-monitor'
import { HookAdapter, HookEventEntry, InstallReport } from './adapter'

/**
 * opencode (https://opencode.ai) integration.
 *
 * Unlike Claude / Codex / Gemini, opencode has NO config-file shell-hook — its
 * extensibility is a JS/TS PLUGIN auto-loaded from `~/.config/opencode/plugins/`.
 * So this adapter's `installHooks` writes a plugin file (not JSON), and the
 * plugin — running IN opencode's Bun process — appends NDJSON records to
 * `~/.glanceterm/hooks/<tab_id>.log` in the exact shape HookWatcher reads. The
 * rest of the pipeline (watcher → TabMonitor) is then identical to the other
 * agents.
 *
 * Why routing is CLEAN here (cleaner than Gemini): the plugin runs in-process,
 * so `process.env.GLANCETERM_TAB_ID` (inherited from the Tabby-spawned shell)
 * is directly readable — no sanitized hook env, no parent-env read, no command
 * expansion assumption. The plugin writes `<that-uuid>.log`, and TabMonitor
 * correlates the opencode tab to the same uuid (sess.glancetermTabId). Match.
 *
 * Status mapping (opencode bus event → TabStatus):
 *   - first activity per turn (message.updated / message.part.updated /
 *     tool.execute.before) → `working`. The plugin debounces the token-stream
 *     spam into a single `working` edge held until `session.idle`.
 *   - `session.idle` → `idle` (turn finished, waiting for the user).
 *   - `permission.asked` → `needs_permission`; `permission.replied` → back to
 *     `working`.
 *
 * Source-confirmed (sst/opencode v1.17.0, commit 97e713e): the plugin dir glob
 * is `{plugin,plugins}/*.{ts,js}` (both singular and plural load — we use
 * `plugins/`); a named export returning `{ event }` is the right contract; and
 * the default `opencode` TUI runs one process per invocation, so the plugin's
 * `process.env.GLANCETERM_TAB_ID` is this tab's id. `tool.execute.before` is a
 * Hooks key (not a bus event.type) so it's NOT handled in the `event` hook.
 *
 * UNTESTED (🧪) — what's left to confirm on a real install:
 *   1. The events fire in practice as the source suggests; `session.idle` is
 *      marked deprecated upstream (alias of `session.status`/idle) but still
 *      fires — revisit if a future opencode drops it.
 *   2. A shared `opencode serve` daemon (non-default) would collapse tabs onto
 *      one env — out of scope; the default per-invocation TUI is fine.
 */

/** Global plugin dir name — opencode loads both `plugin/` and `plugins/`. */
const PLUGIN_SUBDIR = 'plugins'
const PLUGIN_FILENAME = 'glanceterm.ts'

/**
 * The plugin we ship. Self-contained: reads the per-tab id + home from its own
 * (in-process) environment and appends watcher-compatible NDJSON. No type
 * imports so it loads as a plain module. The `glanceterm-` marker in the
 * leading comment lets isOurPlugin()/uninstall identify our file.
 */
const OPENCODE_PLUGIN = `// glanceterm-opencode bridge — DO NOT EDIT BY HAND (regenerated on launch).
// Bridges opencode lifecycle events to the GlanceTerm sidebar. Runs in the
// opencode (Bun) process, which inherited GLANCETERM_TAB_ID from the Tabby
// shell, so we read the per-tab id straight from process.env and append NDJSON
// to ~/.glanceterm/hooks/<tab_id>.log in the shape HookWatcher parses.
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export const GlanceTerm = async () => {
    const tabId = process.env.GLANCETERM_TAB_ID
    const home = process.env.HOME || process.env.USERPROFILE
    const isUuid = !!tabId && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(tabId)
    if (!isUuid || !home) return {}   // can't attribute to a tab → no-op

    const dir = join(home, ".glanceterm", "hooks")
    const logPath = join(dir, tabId + ".log")
    try { mkdirSync(dir, { recursive: true }) } catch (e) {}

    // Collapse the per-chunk message.part.updated spam: emit one "working"
    // edge and hold it until session.idle, so we don't append hundreds of
    // lines per turn.
    let working = false
    // Wall-clock (ms) of the last session.idle, gating the post-idle guard.
    let lastIdleAt = 0
    // After session.idle, ignore message re-arms for this long. opencode emits
    // a stray message.part.updated for the JUST-FINISHED turn AFTER idle; left
    // unguarded it flips the row back to "working" with no closing idle and
    // wedges it there forever. A genuine next turn keeps emitting past the
    // grace and re-arms then (worst case: "working" shows up to this late), so
    // only an isolated post-idle stray is suppressed.
    const IDLE_GRACE_MS = 1500
    // Active model slug, captured from assistant message.updated events
    // (event.properties.info.modelID). Included in every emitted record once
    // known so the sidebar can show it next to the opencode tag.
    let model = null
    // opencode session id, captured best-effort from whatever event carries it
    // (session.* events expose event.properties.sessionID; message events carry
    // it on the Message under event.properties.info.sessionID). Emitted as
    // session_id so GlanceTerm's auto-resume can rebuild "opencode --session
    // <id>" for a restored tab. Stays null if the field shape differs — the
    // resume path then safely falls back to a fresh launch.
    let sessionId = null
    // Running token totals, built from assistant message.updated
    // event.properties.info.tokens.{input,output}. message.updated can fire
    // repeatedly for the same message as streaming progresses, so keep the
    // latest token block per message id and recompute the session total from
    // those latest values instead of double-counting every update.
    const messageTokens = new Map()
    let tokensIn = 0
    let tokensOut = 0
    let tokensCache = 0
    const emit = (event) => {
        const rec = { tab_id: tabId, agent: "opencode", event: event, ts: Math.floor(Date.now() / 1000) }
        if (model) rec.model = model
        if (sessionId) rec.session_id = sessionId
        if (tokensIn || tokensOut || tokensCache) {
            rec.tokens_in = tokensIn
            rec.tokens_out = tokensOut
            if (tokensCache) rec.tokens_cache = tokensCache
        }
        try { appendFileSync(logPath, JSON.stringify(rec) + "\\n") } catch (e) {}
    }

    return {
        event: async ({ event }) => {
            const t = event && event.type
            if (!t) return
            // Capture the model from an assistant message (info.modelID); the
            // event carries the full Message under event.properties.info.
            const info = event.properties && event.properties.info
            // Best-effort session id capture (see sessionId decl above).
            const sid = (event.properties && (event.properties.sessionID || event.properties.sessionId)) || (info && (info.sessionID || info.sessionId)) || null
            if (sid && sid !== sessionId) sessionId = sid
            if (info && info.role === "assistant" && info.modelID && info.modelID !== model) {
                // First time we learn the model (or it changes): surface it
                // immediately. The "working" edge fires on the FIRST message
                // event — which is usually BEFORE the assistant message that
                // carries modelID — and every later message event is swallowed
                // by the !working guard below, so without this the model would
                // not reach the sidebar until the turn ends (session.idle).
                // Emit a model-carrying record now if we're already working; if
                // we're not yet working, the working edge below emits it.
                model = info.modelID
                if (working) emit("working")
            }
            if (info && info.role === "assistant" && info.tokens) {
                const input = typeof info.tokens.input === "number" ? info.tokens.input : 0
                const output = typeof info.tokens.output === "number" ? info.tokens.output : 0
                // opencode also reports reasoning (generated → fold into out) and
                // cache read (info.tokens.cache.read → its own figure, like Claude/
                // Codex). Defensive: missing fields stay 0.
                const reasoning = typeof info.tokens.reasoning === "number" ? info.tokens.reasoning : 0
                const cacheRead = info.tokens.cache && typeof info.tokens.cache.read === "number" ? info.tokens.cache.read : 0
                const messageId = info.id || info.messageID || info.messageId || "__latest__"
                messageTokens.set(messageId, { input, output, reasoning, cacheRead })
                tokensIn = 0
                tokensOut = 0
                tokensCache = 0
                for (const usage of messageTokens.values()) {
                    tokensIn += usage.input || 0
                    tokensOut += (usage.output || 0) + (usage.reasoning || 0)
                    tokensCache += usage.cacheRead || 0
                }
                if (working) emit("working")
            }
            // NOTE: session.idle is the turn-end signal (source-confirmed). It
            // is marked deprecated upstream in favour of session.status
            // (status.type === "idle") but still fires; handle session.status
            // too if a future opencode drops session.idle.
            if (t === "session.idle") {
                working = false
                lastIdleAt = Date.now()
                emit("session.idle")
            } else if (t === "permission.asked") {
                // Reset working so the NEXT activity event re-emits "working".
                // Without this, once we are in needs_permission, an approval
                // made in opencode's own TUI (no clean permission.replied edge)
                // would leave the row stuck "needs you" — every later activity
                // event is swallowed by the !working guard until session.idle.
                working = false
                emit("permission.asked")
            } else if (t === "permission.replied") {
                working = true
                emit("permission.replied")
            } else if (t === "message.updated" || t === "message.part.updated") {
                // tool.execute.before is a Hooks key, NOT a bus event.type —
                // it never arrives here (source-confirmed), so it's omitted.
                // message(.part).updated already covers the working edge.
                // Post-idle guard: a message landing right after session.idle is
                // the finished turn's tail render, not a new turn — don't re-arm
                // working (see IDLE_GRACE_MS), or the row wedges on "working".
                if (!working && Date.now() - lastIdleAt > IDLE_GRACE_MS) {
                    working = true
                    emit("working")
                }
            }
        },
    }
}
`

export class OpencodeHookAdapter extends HookAdapter {
    readonly id: AiTool = 'opencode'
    readonly displayName = 'opencode'

    /** Reported path = the global plugin file we write. */
    configFilePath (): string {
        return path.join(opencodeConfigDirSync(), PLUGIN_SUBDIR, PLUGIN_FILENAME)
    }

    /** Informational — opencode subscribes via one `event` hook in the plugin,
     *  not per-event settings entries, so install/isInstalled key off the
     *  plugin file rather than this list. */
    hookEvents (): HookEventEntry[] {
        return [
            { event: 'session.idle', async: true },
            { event: 'permission.asked', async: true },
            { event: 'permission.replied', async: true },
            { event: 'message.updated', async: true },
        ]
    }

    async isInstalled (): Promise<boolean> {
        try {
            const raw = await fs.readFile(this.configFilePath(), 'utf8')
            return raw.includes('glanceterm-opencode bridge')
        } catch { return false }
    }

    async installHooks (_handlerCommand: string): Promise<InstallReport> {
        // opencode routes via the in-process plugin, so the shell handlerCommand
        // is unused here — we write the plugin file instead.
        const pluginPath = this.configFilePath()
        try {
            // Same-content short-circuit: don't rewrite (and don't bump mtime)
            // when the plugin already matches — keeps idempotent launches cheap
            // and avoids needless reloads.
            try {
                const existing = await fs.readFile(pluginPath, 'utf8')
                if (existing === OPENCODE_PLUGIN) return { installed: false, settingsPath: pluginPath }
            } catch { /* missing — fall through to write */ }
            // Atomic write: temp + rename, so opencode never loads a torn file
            // mid-rewrite (an upgrade where content differs) and two concurrent
            // first-run launches can't interleave. Mirrors writeSettings in the
            // other adapters.
            await fs.mkdir(path.dirname(pluginPath), { recursive: true })
            const tmp = `${pluginPath}.tmp.${crypto.randomUUID()}`
            await fs.writeFile(tmp, OPENCODE_PLUGIN, { encoding: 'utf8', mode: 0o644 })
            try {
                await fs.rename(tmp, pluginPath)
            } catch (e) {
                try { await fs.unlink(tmp) } catch { /* */ }
                throw e
            }
            return { installed: true, settingsPath: pluginPath }
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] failed to install opencode plugin:', e?.message ?? e)
            return { installed: false, settingsPath: pluginPath }
        }
    }

    async uninstallHooks (): Promise<boolean> {
        const pluginPath = this.configFilePath()
        try {
            const raw = await fs.readFile(pluginPath, 'utf8')
            if (raw.includes('glanceterm-opencode bridge')) {
                await fs.unlink(pluginPath)
                return true
            }
        } catch { /* not present — nothing to do */ }
        return false
    }

    mapEventToStatus (event: string, _matcher?: string): TabStatus | null {
        switch (event) {
            case 'working':
            case 'permission.replied':
                return TabStatus.Working
            case 'session.idle':
                return TabStatus.Idle
            case 'permission.asked':
                return TabStatus.NeedsPermission
            default:
                return null
        }
    }

    override signalsBgJobs (): boolean {
        // opencode permanently runs native helper children under its own pid —
        // its `.opencode` core subprocess plus the language servers it auto-
        // spawns (bash-language-server, pyright, …). The generic "child
        // persisted for ≥2s" heuristic badges those as `N bg` forever, even
        // though none are user background jobs. opencode's plugin never emits a
        // bg signal, so the authoritative bg count is simply 0 — mark the hook
        // authoritative to suppress the misfiring heuristic. (Real `&` bg jobs
        // are therefore not surfaced for opencode — same trade-off as Codex,
        // and far better than a permanent phantom badge.)
        return true
    }

    override spawnsNativeHelper (): boolean {
        // See signalsBgJobs() — opencode's core subprocess and its language
        // servers exist from launch, BEFORE any hook event arrives, so the
        // heuristic must be suppressed from t=0 (not just after the first hook
        // event), or they'd be badged `1 bg` during the startup window.
        return true
    }
}

/** "opencode is established on this machine" — gate for the installer. */
export function opencodeConfigDirExistsSync (): boolean {
    try {
        return fsSync.statSync(opencodeConfigDirSync()).isDirectory()
    } catch { return false }
}

function opencodeConfigDirSync (): string {
    // opencode reads global config/plugins from ~/.config/opencode. Resolve
    // the home from the environment (not os.homedir(), which ignores a
    // redirected HOME in tests — see gemini.ts for the same reasoning).
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
    return path.join(home, '.config', 'opencode')
}

/** Exported so a regression test can assert the shipped plugin parses as JS. */
export function opencodePluginSource (): string {
    return OPENCODE_PLUGIN
}
