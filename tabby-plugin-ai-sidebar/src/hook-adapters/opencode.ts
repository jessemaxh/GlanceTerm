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
    // Active model slug, captured from assistant message.updated events
    // (event.properties.info.modelID). Included in every emitted record once
    // known so the sidebar can show it next to the opencode tag.
    let model = null
    const emit = (event) => {
        const rec = { tab_id: tabId, agent: "opencode", event: event, ts: Math.floor(Date.now() / 1000) }
        if (model) rec.model = model
        try { appendFileSync(logPath, JSON.stringify(rec) + "\\n") } catch (e) {}
    }

    return {
        event: async ({ event }) => {
            const t = event && event.type
            if (!t) return
            // Capture the model from an assistant message (info.modelID); the
            // event carries the full Message under event.properties.info.
            const info = event.properties && event.properties.info
            if (info && info.role === "assistant" && info.modelID) {
                model = info.modelID
            }
            // NOTE: session.idle is the turn-end signal (source-confirmed). It
            // is marked deprecated upstream in favour of session.status
            // (status.type === "idle") but still fires; handle session.status
            // too if a future opencode drops session.idle.
            if (t === "session.idle") {
                working = false
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
                if (!working) { working = true; emit("working") }
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

    async uninstallHooks (): Promise<void> {
        const pluginPath = this.configFilePath()
        try {
            const raw = await fs.readFile(pluginPath, 'utf8')
            if (raw.includes('glanceterm-opencode bridge')) {
                await fs.unlink(pluginPath)
            }
        } catch { /* not present — nothing to do */ }
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
