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
 * Subagent pairing window — when a SubagentStop fires, only the queued
 * spawns whose age (eventAt − spawnTs) sits inside this band are eligible
 * to be popped as the "completion" of that Stop. Outside the band the
 * Stop is treated as Claude noise and dropped.
 *
 * MIN_AGE = 30s: in observed Claude Code 2026-06 traces, every
 *   `PreToolUse(Agent)` is followed by a SubagentStop within ~16s, even
 *   when the spawned subagent goes on to do minutes of work. Treat that
 *   first close-on-the-heels Stop as an instant-ACK on the spawn and
 *   drop it; the next real Stop will pair correctly once age > MIN.
 * MAX_AGE = 4min: SubagentStops fired more than 4 minutes after the
 *   oldest unpaired spawn are kept as "spawn is still long-running, this
 *   Stop is probably main-agent noise" rather than paired. Looking at
 *   real traces, fast subagents finish within 3-4 minutes and we want to
 *   pair those; backgrounded reviewers commonly run 10+ minutes and we'd
 *   rather over-display "1 agent" (FP) for one we can't tell is done
 *   than under-display "0 agents" (FN) for one that's still chewing.
 *   Stale queue entries clear at SessionStart/End.
 *
 * Picked over MAX=5min because under that wider band, real traces showed
 * spurious Stops slipping through and decrementing real backgrounded
 * agents to 0 — re-creating the bug we set out to fix.
 */
export const SUBAGENT_PAIR_MIN_AGE_MS = 30_000
export const SUBAGENT_PAIR_MAX_AGE_MS = 4 * 60_000

/**
 * Single subagent-event tagged union that `reduceSubagentQueue` operates on.
 * Crosses the boundary between hook-event parsing (which knows about
 * `PreToolUse`, `SubagentStop`, etc.) and the pairing reducer (which only
 * cares about spawn / stop / reset). Decoupled this way so the reducer
 * stays a pure function and can be exhaustively unit-tested without a hook
 * event JSON harness.
 */
export type SubagentEvent =
    | { kind: 'spawn'; at: number }
    | { kind: 'stop'; at: number }
    | { kind: 'reset' }

/**
 * Pure-function reduction over the per-tab subagent in-flight queue.
 *
 * Returns the next queue state. Caller owns persistence; we never mutate
 * the input. Extracted from `HookWatcherService.processEvent` so the
 * pairing semantics can be unit-tested without standing up the DI graph
 * and so a future tweak to the pairing window can be locked behind tests.
 *
 * Semantics:
 *   - `spawn`: append `at` to the queue.
 *   - `stop`: pop the oldest queued spawn IFF its age (now - oldest) is
 *     in the closed band [SUBAGENT_PAIR_MIN_AGE_MS, SUBAGENT_PAIR_MAX_AGE_MS].
 *     Outside the band → no change. See `subagentInFlight` doc on the
 *     class for the empirical rationale on these numbers.
 *   - `reset`: clear the queue (used on SessionStart / SessionEnd to
 *     prevent stale spawns from a prior session pinning the row).
 *
 * Identity-preserving on no-op: returns the same array reference when
 * the event doesn't change state, so callers can cheaply detect "no
 * change" via reference equality if they care.
 */
export function reduceSubagentQueue (
    queue: readonly number[],
    ev: SubagentEvent,
): readonly number[] {
    if (ev.kind === 'reset') return queue.length === 0 ? queue : []
    if (ev.kind === 'spawn') return [...queue, ev.at]
    // ev.kind === 'stop'
    if (queue.length === 0) return queue
    const ageMs = ev.at - queue[0]
    if (ageMs >= SUBAGENT_PAIR_MIN_AGE_MS && ageMs <= SUBAGENT_PAIR_MAX_AGE_MS) {
        return queue.slice(1)
    }
    return queue
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
     * Per-tab queue of in-flight subagent spawn timestamps (ms since epoch).
     * Array length = how many subagents we believe are currently running.
     * TabMonitor consults this length to override raw `idle` to `working`
     * while > 0, which fixes the "main agent's Stop fired but a backgrounded
     * subagent is still chewing tokens" case where the row would otherwise
     * read as ready.
     *
     * Why an array of timestamps instead of a plain count:
     *
     *   Claude Code (as of June 2026) fires `SubagentStop` LIBERALLY —
     *   in observed traces we counted as many as 15 SubagentStop events
     *   for 4 PreToolUse(Agent) spawns in a single session, AND tabs with
     *   0 Agent spawns receiving 4 SubagentStops in the same session.
     *   Many SubagentStops fire shortly after every `Stop` event (3-180s
     *   after) regardless of whether a real subagent was spawned. The
     *   pre-fix plain count `--` on every SubagentStop floored the
     *   counter to 0 even while real subagents were still running, so
     *   "backgrounded reviewer in progress" tabs displayed as ready.
     *
     *   Storing per-spawn timestamps lets us reject obviously-spurious
     *   SubagentStops on age:
     *
     *     SUBAGENT_PAIR_MIN_AGE_MS  — Stops that fire <30s after a spawn
     *       are usually Claude's immediate-ACK on the spawn, not a real
     *       completion (real subagents do at least one Bash/Read/etc.,
     *       which takes >>30s for any non-trivial task).
     *     SUBAGENT_PAIR_MAX_AGE_MS  — Stops that fire >5min after a
     *       spawn that's still queued are more likely spurious noise
     *       from later main-agent Stop events than a real completion of
     *       that long-running spawn. Trade-off: a genuinely long-running
     *       backgrounded agent's eventual real Stop is missed, so the
     *       counter stays inflated until SessionStart/End resets it.
     *
     * FP/FN trade-off picked here is FP > FN: better to occasionally
     * show "1 agent" after the agent finished than to show "ready" while
     * a real backgrounded agent is still running (which is what users
     * actually noticed and reported).
     *
     * Reset on SessionStart/SessionEnd so stale spawns from a prior
     * Claude session (crashed before Stop, or older than the FP-tolerable
     * window) don't pin the row to working forever.
     *
     * KNOWN LIMITATIONS:
     *
     *   - Long-running backgrounded agents (>SUBAGENT_PAIR_MAX_AGE_MS in
     *     uptime) won't have their real completion paired; counter stays
     *     elevated until SessionStart/End.
     *   - Some Claude background-agent UX flows (the `/agents` slash
     *     command, named agents in ~/.claude/agents/) may not fire
     *     PreToolUse(Agent) at all — in which case we cannot detect
     *     them via hooks. Process-tree detection doesn't help: Claude's
     *     background agents run in the same process, not as child PIDs.
     */
    private readonly subagentInFlight = new Map<string, number[]>()

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
        return this.subagentInFlight.get(tabId)?.length ?? 0
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
        const counterDropped = this.subagentInFlight.delete(tabId)
        const offsetDropped = this.tailOffset.delete(tabId)
        const bgDropped = this.pendingBgArrivals.delete(tabId)
        return snapshotDropped || counterDropped || offsetDropped || bgDropped
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
            // Subagent in-flight queue. Three hook events map to three queue
            // ops, all reduced through the pure `reduceSubagentQueue`:
            //   PreToolUse(tool_name=Task|Agent) → spawn
            //   SubagentStop                     → stop (conditional pop)
            //   SessionStart / SessionEnd        → reset
            //
            // Pairing semantics — when a `stop` actually pops, when it gets
            // dropped on the floor — live entirely in the reducer; see
            // `reduceSubagentQueue` JSDoc for the band [MIN, MAX] rationale
            // and `subagentInFlight` field-doc for why we don't blindly 1:1
            // pair against this Claude Code version's liberal SubagentStop
            // emission.
            //
            // tool_name: Claude renamed the subagent-spawning tool from
            // `Task` to `Agent`. Match both so older installs keep working;
            // if Anthropic adds a third name we'll need a registry, but two
            // strings doesn't earn one.
            const queueEvent: SubagentEvent | null =
                parsed.event === 'PreToolUse' && (parsed.tool_name === 'Task' || parsed.tool_name === 'Agent')
                    ? { kind: 'spawn', at: eventAt }
                    : parsed.event === 'SubagentStop'
                        ? { kind: 'stop', at: eventAt }
                        : (parsed.event === 'SessionStart' || parsed.event === 'SessionEnd')
                            ? { kind: 'reset' }
                            : null
            if (queueEvent) {
                const prev = this.subagentInFlight.get(parsed.tab_id) ?? []
                const next = reduceSubagentQueue(prev, queueEvent)
                if (next !== prev) {
                    if (next.length === 0) this.subagentInFlight.delete(parsed.tab_id)
                    else this.subagentInFlight.set(parsed.tab_id, next.slice())
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
