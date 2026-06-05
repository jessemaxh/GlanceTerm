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
    /** Set only on PreToolUse / PostToolUse payloads — used by the
     *  subagent in-flight counter to detect `Task` tool invocations
     *  (which spawn background subagents). Other events leave this
     *  field empty. */
    tool_name?: string
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

    /**
     * Per-tab count of in-flight subagents — how many `Task` tool calls have
     * been started (PreToolUse with tool_name=Task) without a matching
     * SubagentStop yet. Tab-monitor consults this to override raw `idle` to
     * `working` while the count is > 0, which fixes the "main agent's Stop
     * fired but a backgrounded subagent is still chewing tokens" case
     * where the row would otherwise read as ready.
     *
     * Reset to 0 on SessionStart so a stale count from a prior Claude
     * session (e.g. crashed before SubagentStop landed) doesn't pin the
     * row to working forever. Kept separate from HookSnapshot so the
     * count can change without forcing a snapshot replacement that would
     * disturb the idle-stability gate's eventAt arithmetic.
     *
     * KNOWN LIMITATIONS:
     *
     *   1. If a subagent crashes mid-task and Claude never emits SubagentStop
     *      for it, the counter stays > 0 until SessionStart resets it or
     *      the tab is closed. Auto-reaper rejected for v0.2 because the user
     *      can submit new prompts while a backgrounded subagent is running,
     *      so "main has been idle a while" isn't a clean signal.
     *
     *   2. Two SubagentStops firing in the same wall-clock second are not
     *      both decremented. The handler writes one file per tab, last-
     *      write-wins; the watcher sees at most one of the two payloads.
     *      Even if it saw both, the dedup `(ts, event)` gate would bail on
     *      the second. Real bug for users with parallel Tasks finishing
     *      simultaneously — counter sticks one too high. Root cause is the
     *      single-file IPC; the proper fix (event-log / per-event files +
     *      tool_use_id tracking) is a v0.3 IPC redesign.
     */
    private readonly subagentInFlight = new Map<string, number>()

    /**
     * Per-tab "last event we've already processed" — `{ts, event}`. Used to
     * make `ingest()` idempotent across the four ways the same on-disk file
     * can get read more than once:
     *   1. The 30s periodic `coldLoad` rescan re-reads every file in the dir.
     *   2. fs.watch can fire multiple times for the same write under load.
     *   3. Out-of-order read completion: two reads in flight whose callbacks
     *      return reversed (older read returns last).
     *   4. The startup coldLoad and the first fs.watch event for a brand-new
     *      file racing each other.
     *
     * Without this dedup, the subagent counter (which mutates as a side-effect
     * of ingesting PreToolUse(Task) / SubagentStop) would drift: every rescan
     * of a tab whose last event was PreToolUse(Task) would bump the counter
     * again, and a stale SubagentStop read would decrement an active counter
     * for a still-running subagent. Snapshot writes have a separate ts-merge
     * guard at the bottom of ingest, but that guard ran AFTER the counter
     * mutation, leaving the counter exposed.
     *
     * Compared via (ts, event_name): same-second writes with DIFFERENT event
     * names are both processed (e.g. an immediate PreToolUse followed by a
     * PostToolUse in the same wall-clock second).
     */
    private readonly lastProcessedEvent = new Map<string, { ts: number, event: string }>()

    /**
     * Stamp of when this HookWatcher instance was constructed. Used to
     * distinguish "fresh" events written during this run from "stale" events
     * left in the state dir by prior runs / closed tabs. Counter mutations
     * are gated on `eventAt >= startupTs`, so cold-loading a stale file whose
     * last-write was PreToolUse(Task) does NOT pollute the counter for a
     * tab_id the matching SubagentStop will never come back for.
     *
     * UNIT-CORRECTNESS NOTE: Claude's handler timestamp is `date +%s` (whole
     * seconds), which we multiply by 1000 in ingest to derive `eventAt` in
     * ms. That means `eventAt` is always a multiple of 1000. If we naively
     * kept `Date.now()` with its sub-second precision, every event firing
     * inside the same wall-clock second as launch would have
     * `eventAt = floor(launchMs / 1000) * 1000 < Date.now()` and get
     * mis-classified as stale (lost the increment / decrement). Flooring
     * startupTs to the same second-granularity it'll be compared against
     * makes `eventAt >= startupTs` correct in that boundary second.
     */
    private readonly startupTs = Math.floor(Date.now() / 1000) * 1000

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

    /** Sync lookup — how many subagents the main agent has spawned without a
     *  SubagentStop for them yet. TabMonitor uses this to keep the row
     *  green even after the main agent fires Stop. */
    getSubagentInFlight (tabId: string): number {
        return this.subagentInFlight.get(tabId) ?? 0
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
            // Drop EVERY per-tab map's entry keyed off the file's base name:
            // snapshot, in-flight counter, dedup tracker. Missing any of
            // these would leave per-tab state for a tab that no longer
            // exists, which over many sessions amounts to a slow leak and
            // (for subagentInFlight) a stale value if a future tab somehow
            // reuses the same tab_id.
            const snapshotDropped = this.map.delete(baseName)
            const counterDropped = this.subagentInFlight.delete(baseName)
            const dedupDropped = this.lastProcessedEvent.delete(baseName)
            if ((snapshotDropped || counterDropped || dedupDropped) && !opts.skipEmit) this.emit()
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

        // (1) Idempotency / out-of-order gate — runs BEFORE any side-effect
        // (counter mutation or snapshot write). See `lastProcessedEvent`
        // doc for the four re-read paths this catches. Two bail conditions:
        //   - last.ts > eventAt        → older event arriving out-of-order;
        //                                 the newer one already won.
        //   - last.ts === eventAt
        //     && last.event === event  → same file content as last read
        //                                 (rescan, fs.watch storm, …).
        // Same-ts + different-event proceeds: distinct events sharing a
        // wall-clock second (Claude ts has 1 s resolution) both deserve
        // processing.
        const eventAt = (parsed.ts || 0) * 1000
        const last = this.lastProcessedEvent.get(parsed.tab_id)
        if (last) {
            if (last.ts > eventAt) return
            if (last.ts === eventAt && last.event === parsed.event) return
        }
        this.lastProcessedEvent.set(parsed.tab_id, { ts: eventAt, event: parsed.event })

        // (2) Subagent in-flight counter — runs BEFORE the status-mapping
        // bail so SubagentStop (which maps to null) still decrements. Three
        // transitions matter:
        //   PreToolUse(tool_name=Task) → +1
        //   SubagentStop                → -1   (floored at 0)
        //   SessionStart                → 0    (fresh Claude session)
        //
        // Counter mutations are gated on `eventAt >= startupTs`: events from
        // before this process started (stale tab files cold-loaded at launch)
        // do NOT touch the counter. Without that gate, a stale file whose
        // last-write was PreToolUse(Task) would push the counter to 1 for a
        // tab_id whose matching SubagentStop will never arrive, pinning the
        // row to working forever.
        let counterChanged = false
        if (eventAt >= this.startupTs) {
            if (parsed.event === 'PreToolUse' && parsed.tool_name === 'Task') {
                this.subagentInFlight.set(parsed.tab_id, (this.subagentInFlight.get(parsed.tab_id) ?? 0) + 1)
                counterChanged = true
            } else if (parsed.event === 'SubagentStop') {
                const cur = this.subagentInFlight.get(parsed.tab_id) ?? 0
                if (cur > 0) {
                    this.subagentInFlight.set(parsed.tab_id, cur - 1)
                    counterChanged = true
                }
            } else if (parsed.event === 'SessionStart') {
                if ((this.subagentInFlight.get(parsed.tab_id) ?? 0) !== 0) {
                    this.subagentInFlight.set(parsed.tab_id, 0)
                    counterChanged = true
                }
            }
        }

        // (3) Status mapping.
        const status = adapter.mapEventToStatus(parsed.event, parsed.matcher)
        if (!status) {
            // Adapter says this event doesn't change displayed status (e.g.
            // SubagentStop, PreToolUse, PreCompact). Emit anyway if the
            // counter changed so the tab-monitor override re-evaluates.
            if (counterChanged && !opts.skipEmit) this.emit()
            return
        }

        // (4) Snapshot write. The dedup gate at (1) already filters
        // out-of-order ts and exact re-reads, so the old snapshot-level
        // `existing.eventAt > eventAt` ts-merge guard is now redundant.
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
