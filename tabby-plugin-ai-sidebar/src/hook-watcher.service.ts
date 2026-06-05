import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'

import type { AiTool, TabStatus } from './tab-monitor'
import { HookAdapterRegistry } from './hook-adapters/registry'
import { HookRuntimeService } from './hook-runtime.service'

/**
 * One on-disk status file written by the handler script, after JSON decode.
 * Field shape is contractual with hook-runtime.service.ts's embedded sh.
 */
interface HookStatusFile {
    tab_id: string
    agent: string
    event: string
    matcher?: string
    session_id?: string
    cwd?: string
    ts: number
}

/** Per-tab snapshot the rest of the plugin consumes. */
export interface HookSnapshot {
    tabId: string
    tool: AiTool
    status: TabStatus
    /** ms-since-epoch of the underlying event — useful for "X seconds ago". */
    eventAt: number
    sessionId: string | null
    cwd: string | null
}

/**
 * UUID v4 shape — matches what crypto.randomUUID() produces (and what
 * tabby-local/session.ts injects as GLANCETERM_TAB_ID). Used to reject
 * `unknown.json` and other malformed names from contaminating the map
 * (issue M3 in the v0.2 review).
 */
const TAB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Periodic safety rescan — covers fs.watch reliability holes on NFS/SMB
 *  homes and other edge cases where rename-into-dir events get dropped
 *  (issue M2). 30s is comfortably below "user will notice" but rare enough
 *  not to spin disk. */
const RESCAN_MS = 30_000

/**
 * Watches `~/.glanceterm/hooks/` and exposes the latest status per tab id.
 *
 * Architecture notes:
 *   - fs.watch is best-effort: drops events on NFS/SMB, sometimes on Linux
 *     for `mv`-into-dir. We compensate with a periodic 30s rescan AND with
 *     a "start-watch-before-cold-load" ordering — events that arrive during
 *     the brief cold-load window get buffered by Node and overwritten by
 *     newer ts-stamped entries (ts-aware merge in `ingest`).
 *   - Concurrent reads of the same file can complete out of order. Every
 *     ingest checks the parsed `ts` against the existing snapshot's `ts`
 *     and refuses stale updates (issue M1).
 *   - Tab IDs that aren't UUIDs (e.g. `unknown.json` from a pre-injection
 *     Claude session) are dropped at ingest time.
 */
@Injectable({ providedIn: 'root' })
export class HookWatcherService implements OnDestroy {
    /** Latest snapshot per GLANCETERM_TAB_ID. */
    private readonly map = new Map<string, HookSnapshot>()
    private readonly subject = new BehaviorSubject<Map<string, HookSnapshot>>(this.map)
    readonly snapshots$: Observable<Map<string, HookSnapshot>> = this.subject.asObservable()

    private watcher: fsSync.FSWatcher | null = null
    private rescanTimer: NodeJS.Timeout | null = null
    /** Debounce: a Claude turn fires several events in quick succession;
     *  coalesce into one observable emission so the sidebar repaints once. */
    private flushScheduled = false

    constructor (
        private registry: HookAdapterRegistry,
        private runtime: HookRuntimeService,
    ) {
        void this.start()
    }

    ngOnDestroy (): void {
        this.watcher?.close()
        this.watcher = null
        if (this.rescanTimer) {
            clearInterval(this.rescanTimer)
            this.rescanTimer = null
        }
    }

    /** Sync lookup used by the sidebar render path. */
    getStatus (tabId: string): HookSnapshot | null {
        return this.map.get(tabId) ?? null
    }

    private async start (): Promise<void> {
        await this.runtime.ensureReady()

        // ORDER MATTERS (issue M2): start the watcher BEFORE the cold-load,
        // so events landing during the cold-load window aren't lost. The
        // ts-aware merge in ingest() handles the race: newer events
        // overwrite older cold-loaded ones; older events lose.
        try {
            this.watcher = fsSync.watch(this.runtime.stateDir, { persistent: false }, (_event, filename) => {
                if (!filename || !filename.endsWith('.json')) return
                this.scheduleFlush(path.join(this.runtime.stateDir, filename))
            })
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] cannot watch hook state dir:', e?.message ?? e)
        }

        await this.coldLoad()

        // Periodic safety rescan — fs.watch silently drops events on NFS
        // and some FUSE mounts. Re-enumerate the dir every 30s as a backstop.
        this.rescanTimer = setInterval(() => { void this.coldLoad() }, RESCAN_MS)
    }

    private async coldLoad (): Promise<void> {
        let entries: string[] = []
        try {
            entries = await fs.readdir(this.runtime.stateDir)
        } catch { /* no state dir yet — first run */ }

        let anyChanged = false
        for (const e of entries) {
            if (!e.endsWith('.json')) continue
            const before = this.map.size + (this.lastTsOf(e) ?? 0)
            await this.ingest(path.join(this.runtime.stateDir, e), { skipEmit: true })
            const after = this.map.size + (this.lastTsOf(e) ?? 0)
            if (after !== before) anyChanged = true
        }
        if (anyChanged) this.emit()
    }

    private lastTsOf (filename: string): number | null {
        const tabId = filename.replace(/\.json$/, '')
        return this.map.get(tabId)?.eventAt ?? null
    }

    private scheduleFlush (filePath: string): void {
        // Read immediately but coalesce the OBSERVABLE emission so a flurry
        // of events during one Claude turn becomes a single sidebar repaint.
        void this.ingest(filePath).then(() => {
            if (this.flushScheduled) return
            this.flushScheduled = true
            setTimeout(() => {
                this.flushScheduled = false
                this.emit()
            }, 60)
        })
    }

    private async ingest (filePath: string, opts: { skipEmit?: boolean } = {}): Promise<void> {
        const baseName = path.basename(filePath, '.json')

        let raw: string
        try {
            raw = await fs.readFile(filePath, 'utf8')
        } catch {
            // File deleted (e.g. on session end the handler might tidy up).
            // Drop any prior snapshot keyed off the file's base name.
            if (this.map.delete(baseName) && !opts.skipEmit) this.emit()
            return
        }

        let parsed: HookStatusFile
        try {
            parsed = JSON.parse(raw)
        } catch {
            return // Half-written read; the next event will give us a clean one.
        }

        // Reject malformed/sentinel tab IDs — issue M3. The handler script's
        // own short-circuit usually prevents these from being written, but
        // defense in depth catches anything that slipped through (manual
        // file creation, downgraded handler version, etc.).
        if (!parsed.tab_id || !TAB_ID_RE.test(parsed.tab_id)) return

        const adapter = this.registry.forTool(parsed.agent as AiTool)
        if (!adapter) return

        const status = adapter.mapEventToStatus(parsed.event, parsed.matcher)
        if (!status) return     // Event we don't care about (e.g. PreCompact).

        // Ts-aware merge (issue M1): two events arriving in close succession
        // can have their readFile()s complete out of order. The later read
        // would naively overwrite the newer-event snapshot with a stale one.
        // Compare ts and keep the newer.
        const eventAt = (parsed.ts || 0) * 1000
        const existing = this.map.get(parsed.tab_id)
        if (existing && existing.eventAt > eventAt) return

        this.map.set(parsed.tab_id, {
            tabId: parsed.tab_id,
            tool: adapter.id,
            status,
            eventAt,
            sessionId: parsed.session_id || null,
            cwd: parsed.cwd || null,
        })
    }

    private emit (): void {
        // Pass a new Map reference so downstream pure-equality checks fire.
        this.subject.next(new Map(this.map))
    }
}
