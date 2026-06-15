import { Injectable } from '@angular/core'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Unified, always-on, size-rotated debug log for GlanceTerm.
 *
 * One file — `~/.glanceterm/debug.log` — gathers every diagnostic stream
 * (auto-resume decisions, watcher events, auto-approve grants, and any
 * renderer console.warn/console.error) so a user filing an issue can attach a
 * SINGLE file. No on/off toggle: it's always on at normal runtime.
 *
 * Lifecycle:
 *   - Fresh file each app startup — init() rotates the previous out first.
 *   - Capped at ~10 MB — when a write would exceed it, rotate and continue.
 *   - Keeps a few backups: debug.log.1 … debug.log.3 (oldest dropped).
 *
 * Safety contract (load-bearing — this runs in the renderer hot path and tees
 * the global console):
 *   - Every write is best-effort + synchronous; a failed write NEVER throws and
 *     NEVER breaks the caller.
 *   - The writer NEVER calls console.* (it would recurse through the tee).
 *   - A re-entrancy guard makes the console tee impossible to loop.
 *
 * Renderer-side fs writes mirror the prior auto-resume DIAG approach (which this
 * replaces).
 */

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_BACKUPS = 3

export interface DebugLogOptions {
    filePath?: string
    maxBytes?: number
    backups?: number
    /** Patch console.warn/error to also land here. Default true (production);
     *  tests that only exercise rotation set this false to avoid touching the
     *  global console. */
    teeConsole?: boolean
}

type ConsoleFn = (...args: unknown[]) => void

/**
 * Exported for unit tests (so they can inject a tiny maxBytes / temp path and
 * not write 10 MB for real). Production code uses the {@link debugLog}
 * singleton + {@link DebugLogService}.
 */
export class DebugLog {
    private readonly filePath: string
    private readonly maxBytes: number
    private readonly backups: number
    private readonly tee: boolean
    private bytes = 0
    private initialized = false
    private writing = false
    private origWarn: ConsoleFn | null = null
    private origError: ConsoleFn | null = null

    constructor (opts: DebugLogOptions = {}) {
        this.filePath = opts.filePath ?? path.join(os.homedir(), '.glanceterm', 'debug.log')
        this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
        this.backups = opts.backups ?? DEFAULT_BACKUPS
        this.tee = opts.teeConsole ?? true
    }

    /** Rotate the previous file out, open a fresh one, header it, tee console.
     *  Idempotent — safe to call from multiple eager-injected services. */
    init (): void {
        if (this.initialized) {
            return
        }
        this.initialized = true
        try {
            fsSync.mkdirSync(path.dirname(this.filePath), { recursive: true })
        } catch { /* best-effort */ }
        this.rotate()
        this.write('info', 'startup', `GlanceTerm debug log — platform=${process.platform} — ${new Date().toISOString()}`)
        if (this.tee) {
            this.teeConsole()
        }
    }

    log (level: string, area: string, msg: string): void {
        this.write(level, area, msg)
    }

    /** debug.log -> .1 -> .2 -> .3 ; the oldest (.backups) is dropped. */
    private rotate (): void {
        try {
            try { fsSync.rmSync(`${this.filePath}.${this.backups}`, { force: true }) } catch { /* */ }
            for (let i = this.backups - 1; i >= 1; i--) {
                try {
                    if (fsSync.existsSync(`${this.filePath}.${i}`)) {
                        fsSync.renameSync(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`)
                    }
                } catch { /* */ }
            }
            try {
                if (fsSync.existsSync(this.filePath)) {
                    fsSync.renameSync(this.filePath, `${this.filePath}.1`)
                }
            } catch { /* */ }
        } catch { /* best-effort */ }
        this.bytes = 0
    }

    private write (level: string, area: string, msg: string): void {
        // Only active once the app has bootstrapped the log (init()). This keeps
        // the shared singleton inert in unit tests — where no DI bootstrap runs,
        // so diag()/watcher writes would otherwise append to the real
        // ~/.glanceterm/debug.log — while production stays "always on" because
        // DebugLogService is eager-injected first at launch. Tests that target
        // the log construct their own DebugLog and call init().
        if (!this.initialized) {
            return
        }
        // Re-entrancy guard: a console.* fired from inside this method (directly
        // or via the tee) must NOT recurse. Also why we never call console.*
        // ourselves on failure.
        if (this.writing) {
            return
        }
        this.writing = true
        try {
            const line = `${new Date().toISOString()} ${level.toUpperCase()} [${area}] ${msg}\n`
            const len = Buffer.byteLength(line)
            if (this.bytes + len > this.maxBytes) {
                this.rotate()
            }
            fsSync.appendFileSync(this.filePath, line)
            this.bytes += len
        } catch {
            /* best-effort; never throw, never console.* (would recurse) */
        } finally {
            this.writing = false
        }
    }

    private teeConsole (): void {
        if (this.origWarn) {
            return // already patched
        }
        const c = console as unknown as { warn: ConsoleFn; error: ConsoleFn }
        this.origWarn = c.warn.bind(console)
        this.origError = c.error.bind(console)
        const fmt = (args: unknown[]): string => args.map(a => {
            if (typeof a === 'string') {
                return a
            }
            if (a instanceof Error) {
                return a.stack ?? a.message
            }
            try { return JSON.stringify(a) } catch { return String(a) }
        }).join(' ')
        c.warn = (...args: unknown[]) => { this.write('warn', 'console', fmt(args)); this.origWarn?.(...args) }
        c.error = (...args: unknown[]) => { this.write('error', 'console', fmt(args)); this.origError?.(...args) }
    }

    /** Test helper: undo the console tee (so a test run doesn't leak the patch). */
    restoreConsole (): void {
        if (!this.origWarn) {
            return
        }
        const c = console as unknown as { warn: ConsoleFn; error: ConsoleFn }
        c.warn = this.origWarn
        c.error = this.origError as ConsoleFn
        this.origWarn = null
        this.origError = null
    }
}

/** Module-level singleton — usable from non-DI code (auto-resume's `diag`,
 *  the hook watcher) without threading DI through every call site. */
export const debugLog = new DebugLog()

/** DI entry point: eager-inject once at plugin bootstrap so the startup
 *  rotation + console tee happen at launch. Thin wrapper over the singleton. */
@Injectable({ providedIn: 'root' })
export class DebugLogService {
    constructor () {
        debugLog.init()
    }

    log (level: string, area: string, msg: string): void {
        debugLog.log(level, area, msg)
    }
}
