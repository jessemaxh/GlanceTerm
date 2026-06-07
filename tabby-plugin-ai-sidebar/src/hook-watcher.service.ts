import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'

import type { AiTool, TabStatus } from './tab-monitor'
import { HookAdapter } from './hook-adapters/adapter'
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
    /** Set to 1 by the handler when this is PreToolUse(Bash) AND
     *  tool_input.run_in_background == true — i.e. Claude is about to
     *  spawn a backgrounded shell. TabMonitor uses this as the
     *  authoritative anchor for "the next new child PID under aiPid is a
     *  bg job". Older log lines (pre-feature) lack the field; the
     *  watcher treats absent/0 as "not a bg invocation". */
    bg?: 0 | 1
    /** Top-level `agent_id` from the raw Claude hook payload. Present on
     *  every hook event fired inside a subagent's own turn — the subagent's
     *  own PreToolUse / PostToolUse / SubagentStop. Absent on the main
     *  agent's own events. Drives id-based subagent pairing in
     *  `processEvent`: SubagentStop with this id matching a tracked live
     *  agent → real completion (pop). Mismatch → phantom (ignore).
     *  Older log lines (pre-feature) lack the field. */
    agent_id?: string
    /** Companion to `agent_id` — the subagent's declared agent_type
     *  ("general-purpose", "Explore", ...). Informational; the sidebar
     *  can show it inline as "Reviewing (Explore)" instead of a generic
     *  "working". Pairing logic doesn't depend on it. */
    agent_type?: string
    /** Authoritative spawn signal — extracted by the handler from
     *  `PostToolUse(Agent).tool_response.agentId`, the field Claude
     *  uses to return the id of a freshly-launched subagent (both
     *  background and foreground). Once we read this id we know the
     *  subagent is live until a SubagentStop with matching `agent_id`
     *  arrives. Empty on every other event. */
    spawn_agent_id?: string
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
 * `unknown.log` and other malformed names from contaminating the map
 * (issue M3 in the v0.2 review).
 */
const TAB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Periodic safety rescan — covers fs.watch reliability holes on NFS/SMB
 *  homes and other edge cases where rename-into-dir events get dropped
 *  (issue M2). 30s is comfortably below "user will notice" but rare enough
 *  not to spin disk. */
const RESCAN_MS = 30_000

/** How long a pending bg-shell arrival (PreToolUse(Bash,
 *  run_in_background:true) without a matching new child PID yet) is
 *  allowed to sit in the queue before being discarded. Generous because
 *  the gap between hook fire and process visibility is normally
 *  sub-second, and over-aging would cause us to under-count; the only
 *  failure mode of TOO LARGE a TTL is "if Claude crashed mid-launch,
 *  the next legitimate bg shell would be falsely credited to the dead
 *  arrival." A real user wouldn't notice. */
const BG_ARRIVAL_TTL_MS = 10_000

/**
 * Startup-sweep retention window for `~/.glanceterm/hooks/<tab_uuid>.log`
 * append-only logs. Files whose mtime is older than this are unlinked
 * before the watcher cold-loads.
 *
 * Without sweeping, every Tabby session creates a new UUID-named log file
 * that lives forever — the handler appends, never deletes, and the
 * watcher only drops in-memory state on ENOENT (which requires the file
 * to be gone). Cold-load and the 30s rescan both walk the entire dir, so
 * cold-load time grows linearly with cumulative-sessions-ever. 7 days is
 * long enough to recover state for any session a user might want to
 * "wake up after a weekend" but short enough that the dir doesn't
 * accumulate into the hundreds for a daily user.
 *
 * Sweep is best-effort. A failure (permission, race with another
 * process) is swallowed — cold-load still works on the remaining files,
 * and the next launch retries. */
const HOOK_LOG_RETENTION_MS = 7 * 24 * 60 * 60_000

/**
 * Tagged union for the per-tab subagent-id set reducer.
 *
 * Crosses the boundary between hook-event parsing (which knows about
 * `PostToolUse(Agent)`, `SubagentStop`, etc.) and the set reducer (which
 * only cares about add / remove / reset). Decoupled this way so the
 * reducer stays a pure function and can be exhaustively unit-tested
 * without a hook event JSON harness.
 */
export type SubagentEvent =
    | { kind: 'spawn'; agentId: string }
    | { kind: 'stop'; agentId: string }
    | { kind: 'reset' }

/**
 * Pure-function reduction over the per-tab live-subagent set.
 *
 * Returns the next set state. Caller owns persistence; we never mutate
 * the input. Extracted from `HookWatcherService.processEvent` so the
 * pairing semantics can be unit-tested without standing up the DI graph.
 *
 * Semantics:
 *   - `spawn`: add `agentId` to the set. Idempotent — re-adding an id
 *     already present is a no-op (returns the same reference). Lets the
 *     processEvent caller pass BOTH the authoritative spawn signal
 *     (PostToolUse(Agent).tool_response.agentId) AND the passive liveness
 *     signal (any hook event with top-level agent_id set) through the
 *     same path without double-counting.
 *   - `stop`: remove `agentId` from the set. No-op (identity-preserving)
 *     if the id wasn't tracked — that's how we drop "phantom" SubagentStop
 *     events Claude Code fires for subagents we never observed spawning
 *     (orphan ids from internal CC lifecycle, or pre-startup spawns whose
 *     PostToolUse(Agent) sits in a stale log line).
 *   - `reset`: clear the set (used on SessionStart / SessionEnd to drop
 *     stale ids from prior sessions).
 *
 * Identity-preserving on no-op: returns the same Set reference when the
 * event doesn't change state, so callers can cheaply detect "no change"
 * via reference equality.
 */
export function reduceSubagentSet (
    set: ReadonlySet<string>,
    ev: SubagentEvent,
): ReadonlySet<string> {
    if (ev.kind === 'reset') return set.size === 0 ? set : new Set()
    if (ev.kind === 'spawn') {
        if (set.has(ev.agentId)) return set
        const next = new Set(set)
        next.add(ev.agentId)
        return next
    }
    // ev.kind === 'stop'
    if (!set.has(ev.agentId)) return set
    const next = new Set(set)
    next.delete(ev.agentId)
    return next
}

/**
 * Watches `~/.glanceterm/hooks/` and exposes the latest status per tab id.
 *
 * IPC format: handler scripts APPEND one NDJSON record per event to a per-tab
 * log file `<TAB_ID>.log`. The watcher tails each log by remembering the byte
 * offset of the last fully-processed line. This replaces the earlier
 * single-file overwrite scheme, which lost any event in a sub-fs.watch-window
 * burst (PreToolUse → PermissionRequest for permission-gated tools, or
 * PreToolUse → PostToolUse for sub-100ms tools like Read). With append-only
 * + offset tracking, every fired event is observed exactly once.
 *
 * Architecture notes:
 *   - fs.watch is best-effort: drops events on NFS/SMB, sometimes on Linux
 *     for `mv`-into-dir. We compensate with a periodic 30s rescan AND with
 *     a "start-watch-before-cold-load" ordering — events that arrive during
 *     the brief cold-load window get coalesced with the cold-load result by
 *     offset-tracking (anything beyond `tailOffset` is processed exactly once
 *     regardless of which path saw the bytes first).
 *   - File size shrinking below the recorded offset means the log was
 *     truncated externally (rotation, manual cleanup) — reset offset to 0
 *     and re-process from the new beginning. This is the ONLY safe response
 *     to truncation that doesn't silently drop newly-appended events.
 *   - Tab IDs that aren't UUIDs (e.g. `unknown.log` from a pre-injection
 *     Claude session) are dropped at ingest time.
 *   - Stale lines from prior process lifetimes (eventAt < startupTs) update
 *     the displayed snapshot but do NOT mutate the subagent counter. That
 *     gate's the same as before; the only thing that changed is the on-disk
 *     format the lines come from.
 */
@Injectable({ providedIn: 'root' })
export class HookWatcherService implements OnDestroy {
    /** Latest snapshot per GLANCETERM_TAB_ID. */
    private readonly map = new Map<string, HookSnapshot>()
    private readonly subject = new BehaviorSubject<Map<string, HookSnapshot>>(this.map)
    readonly snapshots$: Observable<Map<string, HookSnapshot>> = this.subject.asObservable()

    /**
     * Per-tab set of currently-live subagent agent_ids. Set size = how
     * many subagents we believe are running. TabMonitor consults this
     * count to override raw `idle` to `working` while > 0, which fixes
     * the "main agent's Stop fired but a backgrounded subagent is still
     * chewing tokens" case where the row would otherwise read as ready.
     *
     * Why id-based instead of the older timestamp-window heuristic:
     *
     *   Claude Code 2026-06 fires SubagentStop LIBERALLY. Observed
     *   traces include phantom SubagentStops for subagents we never
     *   spawned (orphan agent_ids from internal CC lifecycle, possibly
     *   Skill internals or session-housekeeping subagents), AND ACK-
     *   pattern SubagentStops fired 1-5s after every main Stop
     *   regardless of whether a real subagent was running. The previous
     *   heuristic — "drop SubagentStop if its age relative to the oldest
     *   queued spawn is outside [30s, 4min]" — was a guess that fell
     *   apart when the ACK arrived just outside the window: a 35s gap
     *   from spawn to ACK passed the band check and decremented a real
     *   spawn that was still 2 minutes from finishing. The row dropped
     *   to "ready" while the background reviewer kept working.
     *
     *   The raw payload, however, IS deterministic. The handler now
     *   extracts:
     *     `agent_id`        — present on every hook event fired inside
     *                         a subagent's own turn (its tool calls,
     *                         its SubagentStop). Absent on main-agent
     *                         events.
     *     `spawn_agent_id`  — from PostToolUse(Agent).tool_response.agentId,
     *                         the id Claude returns for a freshly-launched
     *                         subagent.
     *
     *   That gives us a real identity to track instead of a timestamp
     *   to bracket. SubagentStop with `agent_id` in our set → real
     *   completion, remove it. SubagentStop with `agent_id` NOT in our
     *   set → phantom, ignore.
     *
     * Passive-liveness add: ANY hook event with a non-empty top-level
     * `agent_id` adds that id to the set, idempotently. Handles the
     * case where we missed the spawn signal (stale-log cold-load, or
     * a future CC version that doesn't surface tool_response.agentId).
     * The subagent's first tool call gives us its id; SubagentStop
     * pairs against the same id.
     *
     * Reset on SessionStart/SessionEnd so stale ids from a prior
     * Claude session (crashed before Stop) don't pin the row to working
     * forever.
     */
    private readonly liveAgentIds = new Map<string, Set<string>>()

    /**
     * Per-tab FIFO queue of timestamps for PreToolUse(Bash,
     * run_in_background:true) events that haven't yet been matched to a
     * concrete child PID by TabMonitor's process-tree poll. Each entry
     * means "we observed Claude *intend* to background a shell at time T;
     * the next new child of aiPid that appears in the poll should be
     * credited to this entry."
     *
     * Why a queue, not a count: order matters when several bg shells fire
     * in quick succession — TabMonitor claims them FIFO to keep the
     * intent → pid association at least roughly correct under load.
     *
     * Entries age out after BG_ARRIVAL_TTL_MS. The TTL covers the case
     * where the bash invocation was aborted before the shell actually
     * spawned (Claude crashed, user killed the tab, hook fired but tool
     * call never executed), so the queue doesn't grow without bound and
     * a stale arrival doesn't get falsely matched to a much-later child.
     */
    private readonly pendingBgArrivals = new Map<string, number[]>()

    /**
     * Per-tab byte offset of the next unread byte in `<TAB_ID>.log`. Append-only
     * format means every event sits at a unique offset — once we've processed
     * bytes [0, tailOffset) of a file, those events are done and never need to
     * be re-evaluated, no matter how many fs.watch fires / 30s rescans /
     * cold-load re-entries hit the same file.
     *
     * This replaces the `(ts, event)`-keyed dedup map the old single-file
     * scheme used. Offset dedup is strictly stronger: it disambiguates
     * same-second same-event writes (e.g. two SubagentStops within one
     * wall-clock second — the v0.2 KNOWN LIMITATION the subagent counter
     * doc-comment used to call out — by their byte position, so the counter
     * decrements both as it should).
     *
     * Truncation handling: if a stat shows `size < tailOffset`, the file was
     * rotated / cleared externally and we MUST reset offset to 0; otherwise
     * we'd skip everything written after the truncation. Detected per ingest
     * via a size check before the read.
     */
    private readonly tailOffset = new Map<string, number>()

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
        return this.liveAgentIds.get(tabId)?.size ?? 0
    }

    /**
     * Caller (TabMonitor) reports "I just observed N new children appear
     * under aiPid this poll tick; how many of them should I credit to
     * hook-signaled bg arrivals?". Returns the count claimed (≤ N), and
     * removes that many entries from the FIFO. Expired arrivals
     * (>BG_ARRIVAL_TTL_MS old) are evicted from the queue head before
     * claiming, so a long-stale arrival can't be matched to a new child.
     *
     * Returning 0 means: "all N new children are unattributed; fall back
     * to the persistence-time heuristic if you want to count them."
     */
    claimBgArrivals (tabId: string, maxToClaim: number): number {
        if (maxToClaim <= 0) return 0
        const arr = this.pendingBgArrivals.get(tabId)
        if (!arr || arr.length === 0) return 0
        const now = Date.now()
        while (arr.length > 0 && now - arr[0] > BG_ARRIVAL_TTL_MS) arr.shift()
        const claimable = Math.min(arr.length, maxToClaim)
        arr.splice(0, claimable)
        if (arr.length === 0) this.pendingBgArrivals.delete(tabId)
        return claimable
    }

    /**
     * Read-only peek at the (TTL-pruned) timestamps of pending bg arrivals for
     * a tab, in FIFO order (head = oldest). Used by TabMonitor's
     * race-recovery path so it can pair an arrival to a `firstSeen` PID only
     * when the PID's seenAt postdates the arrival — preventing an unrelated
     * long-pre-existing PID from being falsely credited to a freshly-queued
     * arrival. The returned array is a defensive copy; mutating it has no
     * effect on the queue (use `claimBgArrivals` to actually pop entries).
     *
     * Side effect: same TTL eviction that `claimBgArrivals` does on its head,
     * so a long-stale arrival doesn't linger in the snapshot. This keeps the
     * caller's "did I see any arrivals?" check honest without requiring a
     * separate poke method.
     */
    peekBgArrivals (tabId: string): number[] {
        const arr = this.pendingBgArrivals.get(tabId)
        if (!arr || arr.length === 0) return []
        const now = Date.now()
        while (arr.length > 0 && now - arr[0] > BG_ARRIVAL_TTL_MS) arr.shift()
        if (arr.length === 0) {
            this.pendingBgArrivals.delete(tabId)
            return []
        }
        return arr.slice()
    }

    private async start (): Promise<void> {
        await this.runtime.ensureReady()

        // Sweep stale logs BEFORE we attach the watcher or cold-load. Doing
        // it first means cold-load doesn't ingest events from sessions we're
        // about to delete (avoiding briefly populating subagentInFlight /
        // tailOffset for a tab_id whose file will vanish a moment later),
        // and the watcher won't fire spurious change events on the unlinks
        // (the watcher attaches AFTER this sweep). Best-effort: if it fails,
        // proceed anyway — see HOOK_LOG_RETENTION_MS doc for the trade-offs.
        await this.sweepStaleLogs()

        // ORDER MATTERS (issue M2): start the watcher BEFORE the cold-load,
        // so events landing during the cold-load window aren't lost. The
        // ts-aware merge in ingest() handles the race: newer events
        // overwrite older cold-loaded ones; older events lose.
        try {
            this.watcher = fsSync.watch(this.runtime.stateDir, { persistent: false }, (_event, filename) => {
                if (!filename || !filename.endsWith('.log')) return
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

    /**
     * Unlink `~/.glanceterm/hooks/<tab_uuid>.log` files whose mtime is
     * older than HOOK_LOG_RETENTION_MS. Called once at start. mtime gets
     * touched on every handler append, so a still-active session never
     * matches the predicate — only abandoned tabs from prior runs do.
     *
     * Best-effort: any per-file error (race with another process, fs
     * permission) is swallowed so a single problem file doesn't block
     * the rest of the sweep. A dir-level error (missing dir, permission)
     * is also swallowed because the watcher's fs.watch will report it
     * separately with better context.
     */
    private async sweepStaleLogs (): Promise<void> {
        let entries: string[] = []
        try {
            entries = await fs.readdir(this.runtime.stateDir)
        } catch { return }

        const now = Date.now()
        let removed = 0
        for (const e of entries) {
            if (!e.endsWith('.log')) continue
            const filePath = path.join(this.runtime.stateDir, e)
            try {
                const st = await fs.stat(filePath)
                if (now - st.mtimeMs > HOOK_LOG_RETENTION_MS) {
                    await fs.unlink(filePath)
                    removed++
                }
            } catch { /* race / perm — leave for next launch's sweep */ }
        }
        if (removed > 0) {
            // eslint-disable-next-line no-console
            console.log(`[glanceterm] hook-watcher: swept ${removed} stale .log file(s) (>${Math.floor(HOOK_LOG_RETENTION_MS / 86_400_000)}d old)`)
        }
    }

    private async coldLoad (): Promise<void> {
        let entries: string[] = []
        try {
            entries = await fs.readdir(this.runtime.stateDir)
        } catch { /* no state dir yet — first run */ }

        let anyChanged = false
        for (const e of entries) {
            if (!e.endsWith('.log')) continue
            const before = this.map.size + (this.lastTsOf(e) ?? 0)
            await this.ingest(path.join(this.runtime.stateDir, e), { skipEmit: true })
            const after = this.map.size + (this.lastTsOf(e) ?? 0)
            if (after !== before) anyChanged = true
        }
        if (anyChanged) this.emit()
    }

    private lastTsOf (filename: string): number | null {
        const tabId = filename.replace(/\.log$/, '')
        return this.map.get(tabId)?.eventAt ?? null
    }

    private scheduleFlush (filePath: string): void {
        // Read immediately but coalesce the OBSERVABLE emission so a flurry
        // of events during one Claude turn becomes a single sidebar repaint.
        void this.ingest(filePath).then(() => this.scheduleEmit())
    }

    /**
     * Single debounced-emit primitive. Sets `flushScheduled` and arms a
     * 60 ms timer that fires `emit()` once per window — any number of
     * `scheduleEmit()` calls inside the window collapse to one repaint.
     *
     * Use this from EVERY ingest path that wants to surface a state change
     * (snapshot, counter, dedup, …). Calling `this.emit()`
     * directly from inside `ingest()` would double-fire on the fs.watch
     * path: ingest's inner emit + scheduleFlush's `.then(() => emit)`
     * trailing emit. For a 30-tool turn that's the difference between 30
     * tab-monitor ticks and 60+ (each tick scans process trees and reads
     * env blocks — non-trivial work).
     *
     * Only `coldLoad()` keeps a direct `this.emit()` call, because it
     * batches its own end-of-pass emit after processing all files.
     */
    private scheduleEmit (): void {
        if (this.flushScheduled) return
        this.flushScheduled = true
        setTimeout(() => {
            this.flushScheduled = false
            this.emit()
        }, 60)
    }

    /**
     * Tail one per-tab log file: read [tailOffset, fileSize), split into
     * complete NDJSON lines, process each. A trailing partial line (no `\n`
     * yet) is left untouched — tailOffset advances only past complete lines,
     * so the next ingest picks the partial line up once its `\n` arrives.
     *
     * Truncation: `fileSize < tailOffset` means the log was rotated / cleared
     * externally; reset offset to 0 and re-process from the new beginning.
     *
     * Missing file (ENOENT): the handler tore down the per-tab log on
     * SessionEnd, or the user cleared `~/.glanceterm/hooks/`. Drop all
     * per-tab maps so a future tab reusing the same UUID doesn't inherit
     * stale counters.
     */
    private async ingest (filePath: string, opts: { skipEmit?: boolean } = {}): Promise<void> {
        const baseName = path.basename(filePath, '.log')

        // Reject malformed/sentinel tab IDs at the file-name layer so we
        // never even open something like `unknown.log` (issue M3). The
        // handler short-circuits before writing too — this is defense in
        // depth for orphaned files / manual creation.
        if (!TAB_ID_RE.test(baseName)) return

        let stat: fsSync.Stats
        try {
            stat = await fs.stat(filePath)
        } catch {
            // File gone — drop every per-tab map keyed off the base name so
            // we don't leak state across UUID reuse.
            const dropped = this.dropTabState(baseName)
            if (dropped && !opts.skipEmit) this.scheduleEmit()
            return
        }

        const recorded = this.tailOffset.get(baseName) ?? 0
        const readFrom = stat.size < recorded ? 0 : recorded
        if (stat.size === readFrom) return // nothing new

        let buf: Buffer
        try {
            const fd = await fs.open(filePath, 'r')
            try {
                buf = Buffer.alloc(stat.size - readFrom)
                await fd.read(buf, 0, buf.length, readFrom)
            } finally {
                await fd.close()
            }
        } catch {
            return // racy read; next fs.watch fire (or 30s rescan) will retry.
        }

        const text = buf.toString('utf8')
        const lastNewline = text.lastIndexOf('\n')
        if (lastNewline < 0) {
            // No complete line in the new bytes — write is mid-flight. Leave
            // offset where it was; next ingest will see the full line.
            return
        }
        this.tailOffset.set(baseName, readFrom + lastNewline + 1)

        let anyChanged = false
        for (const line of text.slice(0, lastNewline).split('\n')) {
            if (!line) continue
            let parsed: HookStatusFile
            try {
                parsed = JSON.parse(line)
            } catch {
                continue // skip a malformed line; rest of the file is fine
            }
            // Cross-check the embedded tab_id matches the file we read from
            // (a hand-written record claiming a different UUID would otherwise
            // be attributed to the wrong tab).
            if (!parsed.tab_id || parsed.tab_id !== baseName || !TAB_ID_RE.test(parsed.tab_id)) continue
            const adapter = this.registry.forTool(parsed.agent as AiTool)
            if (!adapter) continue
            if (this.processEvent(parsed, adapter)) anyChanged = true
        }

        if (anyChanged && !opts.skipEmit) this.scheduleEmit()
    }

    /** Drop every per-tab map keyed by tab_id. Returns true if any held state. */
    private dropTabState (tabId: string): boolean {
        const snapshotDropped = this.map.delete(tabId)
        const liveDropped = this.liveAgentIds.delete(tabId)
        const offsetDropped = this.tailOffset.delete(tabId)
        const bgDropped = this.pendingBgArrivals.delete(tabId)
        return snapshotDropped || liveDropped || offsetDropped || bgDropped
    }

    /**
     * Process one parsed event line. Returns true if any per-tab state
     * (snapshot or side-tracker) changed. Side-effect mutations are gated on
     * `eventAt >= startupTs` so stale lines from prior process lifetimes
     * (cold-loaded from existing logs) update the displayed snapshot but do
     * NOT mutate the subagent counter — same rationale as the pre-append-only
     * design.
     */
    private processEvent (parsed: HookStatusFile, adapter: HookAdapter): boolean {
        const eventAt = (parsed.ts || 0) * 1000
        let changed = false

        if (eventAt >= this.startupTs) {
            // Id-based live-subagent tracking. Hook events map to set ops,
            // all reduced through the pure `reduceSubagentSet`:
            //   PostToolUse(Agent) w/ tool_response.agentId → spawn (authoritative)
            //   ANY event with top-level agent_id          → spawn (passive liveness)
            //   SubagentStop w/ matching agent_id          → stop
            //   SessionStart / SessionEnd                  → reset
            //
            // The passive-liveness spawn handles the case where we missed
            // the authoritative PostToolUse(Agent) — stale cold-load,
            // future CC tweaks, etc. — by treating any tool call inside
            // the subagent's own turn (it carries top-level agent_id) as
            // proof the subagent is running. Add-set semantics make it
            // idempotent against the spawn-event path: same id → no-op.
            //
            // SubagentStop with an agent_id we don't recognize is dropped
            // on the floor — that's how we ignore the phantom SubagentStops
            // Claude Code fires for subagents we never observed.
            //
            // tool_name: Claude renamed the subagent-spawning tool from
            // `Task` to `Agent`. The spawn signal here is the agent_id
            // from tool_response, not the tool_name; tool_name only gates
            // which event we read tool_response on.
            const events: SubagentEvent[] = []
            if (
                parsed.event === 'PostToolUse'
                && (parsed.tool_name === 'Agent' || parsed.tool_name === 'Task')
                && parsed.spawn_agent_id
            ) {
                events.push({ kind: 'spawn', agentId: parsed.spawn_agent_id })
            }
            if (parsed.agent_id) {
                // Passive liveness — any hook event from inside a subagent's
                // turn carries its agent_id. Re-adding the same id is a no-op
                // in the reducer, so this is safe even when PostToolUse(Agent)
                // already added it above.
                if (parsed.event === 'SubagentStop') {
                    events.push({ kind: 'stop', agentId: parsed.agent_id })
                } else {
                    events.push({ kind: 'spawn', agentId: parsed.agent_id })
                }
            }
            if (parsed.event === 'SessionStart' || parsed.event === 'SessionEnd') {
                events.push({ kind: 'reset' })
            }
            if (events.length > 0) {
                const prev = this.liveAgentIds.get(parsed.tab_id) ?? new Set<string>()
                let next: ReadonlySet<string> = prev
                for (const ev of events) next = reduceSubagentSet(next, ev)
                if (next !== prev) {
                    if (next.size === 0) this.liveAgentIds.delete(parsed.tab_id)
                    else this.liveAgentIds.set(parsed.tab_id, next as Set<string>)
                    changed = true
                }
            }
            if (parsed.event === 'SessionStart' || parsed.event === 'SessionEnd') {
                // Same boundary reset for the bg-arrival queue — a stale
                // arrival left over from a prior session would otherwise
                // get falsely matched to the next new child of the freshly
                // launched agent.
                if (this.pendingBgArrivals.delete(parsed.tab_id)) changed = true
            }

            // Background-shell arrival anchor: enqueue a pending arrival when
            // Claude is about to spawn a backgrounded Bash. Only PreToolUse
            // with tool_name=Bash AND the handler-extracted bg=1 flag
            // qualifies; TabMonitor pops these as it observes new children
            // appear under aiPid. Doesn't touch `changed` — the subscriber
            // only repaints on TabMonitor's poll cycle anyway.
            if (parsed.event === 'PreToolUse' && parsed.tool_name === 'Bash' && parsed.bg === 1) {
                const arr = this.pendingBgArrivals.get(parsed.tab_id) ?? []
                arr.push(eventAt)
                this.pendingBgArrivals.set(parsed.tab_id, arr)
            }

        }

        const status = adapter.mapEventToStatus(parsed.event, parsed.matcher)
        if (!status) return changed

        this.map.set(parsed.tab_id, {
            tabId: parsed.tab_id,
            tool: adapter.id,
            status,
            eventAt,
            sessionId: parsed.session_id || null,
            cwd: parsed.cwd || null,
        })
        return true
    }

    private emit (): void {
        // Pass a new Map reference so downstream pure-equality checks fire.
        this.subject.next(new Map(this.map))
    }
}
