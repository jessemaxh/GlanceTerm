import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'

import type { AiTool, TabStatus as TabStatusType } from './tab-monitor'
import { TabStatus } from './tab-monitor'
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
    /** Absolute path to Claude's `<sessionId>.jsonl` transcript file —
     *  written by the handler verbatim from the raw Claude payload's
     *  `transcript_path`. Authoritative: the file lives at the directory
     *  where `claude` was launched (project root), NOT under a slug
     *  derived from the agent's current cwd if it has cd'd into a subdir.
     *  Consumed by tabby-plugin-mobile-bridge's TranscriptTailerService.
     *  Older log lines (pre-feature) lack the field. */
    transcript_path?: string
    ts: number
    /** Set to 1 by the handler when this is PreToolUse(Bash) AND
     *  tool_input.run_in_background == true — i.e. Claude is about to
     *  spawn a backgrounded shell. TabMonitor uses this as the
     *  authoritative anchor for "the next new child PID under aiPid is a
     *  bg job". Older log lines (pre-feature) lack the field; the
     *  watcher treats absent/0 as "not a bg invocation". */
    bg?: 0 | 1
    /** Set to 1 when PostToolUse payload's tool_response.interrupted is true.
     *  Claude uses this for user-interrupted Bash calls; those turns can end
     *  without a Stop hook, so this is the authoritative "no longer working"
     *  signal for that path. */
    interrupted?: 0 | 1
    /** Set by the handler on PostToolUse(Monitor) to the task id Claude
     *  returned in tool_response — the lifecycle key for the Monitor tool.
     *  Adding this id to the live-monitor set is how we mirror Claude's
     *  footer "M monitor" count: each id stays in the set until the
     *  matching PreToolUse(TaskStop) (`stop_task_id`) arrives or a
     *  SessionStart/End boundary resets it. Empty on every other event.
     *  Older log lines (pre-feature) lack the field. */
    monitor_task_id?: string
    /** Set by the handler on PostToolUse(Monitor) to the started Monitor's
     *  `tool_input.timeout_ms` — the monitor's own give-up deadline. We
     *  use it to auto-evict the task id at `eventAt + timeout_ms` because
     *  Claude fires NO hook when a monitor ends naturally (condition met
     *  or timeout); without this bound a completed monitor's id would sit
     *  in the live set until the next SessionStart/End. A monitor never
     *  runs past its timeout, so this is a safe upper bound on liveness.
     *  Absent on older log lines / older Claude builds → falls back to
     *  {@link DEFAULT_MONITOR_TTL_MS}. */
    monitor_timeout_ms?: number
    /** Set by the handler on PreToolUse(TaskStop) to the task id Claude
     *  passed in tool_input — the decrement signal for the live-monitor
     *  set. We process the stop BEFORE the monitor add in `processEvent`
     *  is irrelevant — same-second events arrive in file order and
     *  TaskStop will only ever fire for an already-added id. Empty on
     *  every other event. Older log lines (pre-feature) lack the field. */
    stop_task_id?: string
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
    /** Active model slug (e.g. `gpt-5.5`, `claude-opus-4-8`). Codex emits it
     *  on every hook event; Claude only on SessionStart; empty otherwise. The
     *  watcher keeps the last NON-EMPTY value per tab (see processEvent), so a
     *  one-shot SessionStart model persists across later model-less events. */
    model?: string
}

/** Per-tab snapshot the rest of the plugin consumes. */
export interface HookSnapshot {
    tabId: string
    tool: AiTool
    status: TabStatusType
    /** ms-since-epoch of the underlying event — useful for "X seconds ago". */
    eventAt: number
    sessionId: string | null
    cwd: string | null
    /** Absolute path to Claude's `<sessionId>.jsonl` transcript file, or
     *  null when no event has surfaced it yet (pre-feature log lines, or
     *  agents that don't emit a transcript_path field). Prefer this over
     *  reconstructing from cwd — see HookStatusFile.transcript_path. */
    transcriptPath: string | null
    /** Active model slug for this tab, or null until an event surfaces one.
     *  Sticky: holds the last non-empty model seen (so Claude's one-shot
     *  SessionStart value survives later model-less events). */
    model: string | null
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
 * How long a stopped subagent id sits in the per-tab tombstone before
 * being evicted. The tombstone exists because Claude Code 2026-06 fires
 * `PostToolUse(Agent)` (which carries `spawn_agent_id`) AFTER the matching
 * `SubagentStop`, by ~2 seconds. Without the tombstone, the late spawn
 * event re-adds an id that just got removed and no further `SubagentStop`
 * will ever land — the row pins to `working · 1 agent` for the rest of
 * the session.
 *
 * 60 s comfortably covers the observed 2 s stop→spawn gap with margin for
 * a slow PostToolUse(Agent) write, while being short enough that the
 * (vanishingly unlikely) case of a brand-new subagent being assigned a
 * collided random id within the window isn't permanently suppressed.
 * agent_ids look like 16-hex hashes, so the collision risk inside 60 s
 * is negligible.
 */
const SUBAGENT_TOMBSTONE_TTL_MS = 60_000

/**
 * Fallback live-window for a Monitor task whose start event carried no
 * `monitor_timeout_ms` (older Claude builds, or a future Monitor schema
 * that renames the field). A Monitor never runs past its own timeout, so
 * `start + timeout` is a hard upper bound on liveness; when we don't know
 * the timeout we assume this generous cap rather than pinning the badge
 * forever. Chosen long enough not to prematurely drop a genuinely
 * long-running monitor, short enough to bound the over-count to one
 * window instead of a whole multi-hour session.
 */
const DEFAULT_MONITOR_TTL_MS = 30 * 60_000

/**
 * Slack added to a Monitor's `timeout_ms` before we evict its id. The
 * monitor gives up AT `start + timeout_ms`; Claude then needs a beat to
 * surface the result, and our handler's `date +%s` start stamp is
 * whole-second-quantised. The grace ensures we never evict a monitor the
 * footer still counts as live — eviction only ever trails the real end,
 * never leads it.
 */
const MONITOR_TTL_GRACE_MS = 5_000

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
     * Per-tab tombstone for recently-stopped subagent ids. Inner Map is
     * `agentId → stop timestamp (ms since epoch)`.
     *
     * Purpose: rejects late `spawn` events for an id that already had its
     * `SubagentStop`. See SUBAGENT_TOMBSTONE_TTL_MS for the underlying
     * Claude Code event-ordering quirk this works around.
     *
     * Lifecycle:
     *   - Populated whenever the reducer applies a `stop` (either branch:
     *     the SubagentStop event itself, OR — defence in depth — a future
     *     code path that decides to evict an orphaned id).
     *   - Consulted before applying `spawn`: if the id is tombstoned AND
     *     within TTL, the spawn is dropped on the floor, not passed to
     *     the reducer. This is the load-bearing guard.
     *   - Cleared per-tab on SessionStart/SessionEnd, alongside
     *     `liveAgentIds` and the other session-scoped trackers.
     *   - Lazy GC of aged-out entries happens inside `processEvent` —
     *     keeps the map bounded across long sessions without a dedicated
     *     sweep timer.
     *
     * Why per-tab keying: every tab is a separate Claude session with
     * independent id space. Shared keying would (very rarely) suppress a
     * real spawn in tab B because tab A had a stop in the same TTL window.
     */
    private readonly subagentTombstones = new Map<string, Map<string, number>>()

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
     * Per-tab map of currently-live Monitor task id → eviction deadline
     * (ms-since-epoch). Mirrors Claude's footer "M monitor" count: a
     * Monitor tool call adds its task id on PostToolUse(Monitor); the
     * matching PreToolUse(TaskStop) removes it; SessionStart/SessionEnd
     * resets the whole map.
     *
     * Why a map of id→deadline, not a bare Set or counter:
     *
     *   - id keys (not a counter): Claude can interleave many Monitor
     *     invocations and only stop some by id. A bare counter would let
     *     a TaskStop for an unknown id decrement the count, drifting from
     *     the footer. Keyed semantics — add only if absent, delete by
     *     exact match — make every transition idempotent and silently
     *     drop TaskStops for ids we never saw (the same robustness shape
     *     the liveAgentIds reducer uses for phantom SubagentStops).
     *
     *   - deadline values (not a Set): Claude fires NO hook when a
     *     monitor ends naturally — condition met ("stream ended") or
     *     timeout. Only an explicit TaskStop decrements. So a completed
     *     monitor's id would otherwise sit here until the next
     *     SessionStart/End, over-counting the badge (the bug this map
     *     fixes). Each id is stamped with `start + timeout_ms + grace`;
     *     {@link getMonitorInFlight} lazily evicts ids past their
     *     deadline. TaskStop still removes early on explicit stop.
     *
     *     Safety of the bound — a non-persistent monitor ends at first
     *     match OR timeout_ms, whichever is first, so its lifetime is
     *     ≤ timeout_ms and eviction trails the real end, never leads it.
     *     Verified against a real Claude trace (2026-06-10): four monitors
     *     with timeouts 120s / 1800s ran 118.4s / 241s / 244s / 291s — all
     *     inside their timeout, the 120s one with only 1.6s to spare (the
     *     grace covers that margin comfortably). CAVEAT: persistent
     *     monitors (`persistent: true`) keep streaming past first match;
     *     none appear in observed traces, and whether timeout_ms still
     *     bounds their total lifetime is unverified. If a persistent
     *     monitor outlives timeout_ms it would under-count until the next
     *     session — revisit with a real persistent trace if that surfaces.
     */
    private readonly liveMonitorTaskIds = new Map<string, Map<string, number>>()

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

    /**
     * Synthetic Working→Idle override. The agent CLIs (claude, codex, …)
     * intercept ESC at raw-stdin level and abort in-flight LLM/tool work
     * without firing any hook event during the LLM-thinking window, so
     * without this path the row would stay stuck on `working` until the
     * next user prompt. EscInterruptService is the caller.
     *
     * No-op when:
     *   - No snapshot yet (we'd be fabricating a tool we don't know).
     *   - Already Idle (nothing to do).
     *   - NeedsPermission (a permission dialog is the user's call; ESC
     *     there cancels the dialog → next PreToolUse re-establishes
     *     status anyway, no need to race).
     *
     * `reason` is a label for future telemetry; not currently logged.
     */
    forceIdle (tabId: string, reason: string): boolean {
        void reason
        const current = this.map.get(tabId)
        if (!current) return false
        if (current.status === TabStatus.Idle) return false
        if (current.status === TabStatus.NeedsPermission) return false
        this.map.set(tabId, { ...current, status: TabStatus.Idle, eventAt: Date.now() })
        this.emit()
        return true
    }

    /** Sync lookup — how many subagents the main agent has spawned without a
     *  SubagentStop for them yet. TabMonitor uses this to keep the row
     *  green even after the main agent fires Stop. */
    getSubagentInFlight (tabId: string): number {
        return this.liveAgentIds.get(tabId)?.size ?? 0
    }

    /** Sync lookup — how many Monitor tasks are currently live. Drives the
     *  sidebar's "M monitor" badge, paired with the bg-shell count to
     *  mirror Claude's footer. Lazily evicts ids whose deadline has passed
     *  (a monitor that ended naturally without a TaskStop hook), so the
     *  badge converges to Claude's footer within one TabMonitor poll of
     *  the monitor's timeout — no dedicated sweep timer needed since this
     *  is read every poll. */
    getMonitorInFlight (tabId: string): number {
        const live = this.liveMonitorTaskIds.get(tabId)
        if (!live) return 0
        const now = this.now()
        for (const [taskId, deadline] of live) {
            if (deadline <= now) live.delete(taskId)
        }
        if (live.size === 0) {
            this.liveMonitorTaskIds.delete(tabId)
            return 0
        }
        return live.size
    }

    /** Wall-clock seam — overridden by the replay harness so monitor-TTL
     *  eviction is testable against fixture timestamps instead of real
     *  time. Production reads the real clock. */
    protected now (): number {
        return Date.now()
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
        const monDropped = this.liveMonitorTaskIds.delete(tabId)
        // Tombstones are session-scoped (already reset on SessionStart/End)
        // but a tab can die WITHOUT firing SessionEnd (Tabby kill, process
        // crash). Without this we'd leak one inner Map per dead UUID across
        // the lifetime of the GlanceTerm process — small per entry but
        // unbounded in count. Mirror the same delete shape the other
        // per-tab side-trackers above use.
        const tombDropped = this.subagentTombstones.delete(tabId)
        return snapshotDropped || liveDropped || offsetDropped || bgDropped || monDropped || tombDropped
    }

    /**
     * GC entry point for TabMonitor's poll loop: drop ALL per-tab state for any
     * tracked UUID that no longer belongs to an open terminal tab.
     *
     * Why this exists: the on-disk handler only ever APPENDS to `<tab_id>.log`
     * — it never unlinks it — so the ENOENT path in {@link tail} that calls
     * {@link dropTabState} never fires for a closed tab. Without an external
     * sweep, every tab UUID ever seen leaks one `map` + `tailOffset`
     * (+ side-channel) entry for the whole process lifetime, and {@link emit}
     * copies the growing `map` on every flush. TabMonitor owns the tab↔UUID
     * mapping, so it hands us the live UUIDs each tick and we evict the rest.
     *
     * Conservative by construction: TabMonitor contributes BOTH a tab's
     * `sess.glancetermTabId` and any cached env UUID, so a tab whose log is
     * keyed by either survives. A transient under-count of live tabs only
     * costs a re-read of that tab's log on its next append (the log is
     * internally consistent — spawns balance stops, resets included — so the
     * reconstructed state is correct). Callers MUST skip this on a zero-tab
     * scan (app shutdown / transient empty collect) so we never nuke
     * everything; this method does not second-guess an empty set.
     */
    retainOnly (liveTabIds: Set<string>): void {
        const keys = new Set<string>()
        for (const k of this.map.keys()) keys.add(k)
        for (const k of this.tailOffset.keys()) keys.add(k)
        for (const k of this.liveAgentIds.keys()) keys.add(k)
        for (const k of this.liveMonitorTaskIds.keys()) keys.add(k)
        for (const k of this.pendingBgArrivals.keys()) keys.add(k)
        for (const k of this.subagentTombstones.keys()) keys.add(k)
        for (const k of keys) {
            if (!liveTabIds.has(k)) this.dropTabState(k)
        }
        // No emit(): dropped entries belong to tabs TabMonitor no longer
        // renders, and direct reads (getStatus / getSubagentInFlight) hit the
        // live maps we just pruned. Emitting here would only bounce an extra
        // tick for state nobody queries.
    }

    /**
     * Clear only the session-scoped side-channel counters (live subagents,
     * live monitors, pending bg arrivals, tombstones) for one tab, leaving its
     * snapshot + tail offset intact.
     *
     * Called by TabMonitor when a tab goes `no_ai` — the agent process died
     * mid-flight without a SessionEnd. The lazy evictors
     * ({@link getMonitorInFlight}) only self-evict when queried with a resolved
     * tabId, but a `no_ai` tab resolves none, so a crash that left a subagent
     * or monitor "live" would otherwise sit in memory until the tab closes
     * (then {@link retainOnly} reaps it) or a new SessionStart resets it. This
     * closes the open-but-dead window. The snapshot is deliberately kept:
     * process-tree detection already drives the row to `no_ai`, and a revival
     * re-reads from the retained offset rather than re-scanning the whole log.
     */
    clearSideChannel (tabId: string): boolean {
        // Cheap guard so the per-tick call from every plain (never-AI) shell
        // tab is a set of has-checks, not four Map.delete misses.
        if (
            !this.liveAgentIds.has(tabId)
            && !this.liveMonitorTaskIds.has(tabId)
            && !this.pendingBgArrivals.has(tabId)
            && !this.subagentTombstones.has(tabId)
        ) return false
        this.liveAgentIds.delete(tabId)
        this.liveMonitorTaskIds.delete(tabId)
        this.pendingBgArrivals.delete(tabId)
        this.subagentTombstones.delete(tabId)
        return true
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

        // The subagent / monitor / bg-arrival side-channel below keys off fields
        // that ONLY Claude's documented hook payload defines (`agent_id`,
        // `spawn_agent_id`, `tool_name: Agent/Monitor/TaskStop/Bash`, `bg`).
        // Codex/Gemini/opencode don't emit them today, but running this block
        // for them is one field-name collision away from a phantom
        // "working · N agents" pin with NO decrement path — Codex subscribes to
        // neither StopFailure nor SessionEnd, so it could never recover. Gate
        // the whole block on the Claude adapter, the only agent whose contract
        // includes these fields. (opencode's plugin is structurally safe; this
        // makes codex/gemini safe by construction, not by payload luck.) When
        // another agent's subagent contract is verified e2e, promote this to a
        // per-adapter capability flag rather than a hard-coded id.
        if (eventAt >= this.startupTs && adapter.id === 'claude') {
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
                // A subagent's turn ends with EITHER `SubagentStop` (normal) or
                // `StopFailure` (abnormal — interrupt / stream timeout / error),
                // both carrying the subagent's agent_id. Treat BOTH as a stop.
                //
                // Everything else carrying an agent_id (PreToolUse/PostToolUse
                // from inside the subagent's turn) is passive liveness — re-add
                // the id (a no-op in the reducer if already tracked).
                //
                // Bug this fixes: when `StopFailure` was added (commit a4bf2448)
                // for the MAIN agent's idle, a subagent that ended via
                // StopFailure fell into the `else` and was re-added as a SPAWN —
                // so it never left liveAgentIds, the in-flight counter stuck at
                // ≥1, and TabMonitor's idle→working override pinned the row to
                // "working · N agents" forever. Any interrupted/timed-out
                // subagent reproduced it.
                if (parsed.event === 'SubagentStop' || parsed.event === 'StopFailure') {
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
                // Tombstone-aware application. `stop` events seed the
                // tombstone; `spawn` events are dropped if the id is
                // tombstoned within TTL (load-bearing guard against the
                // ~2s SubagentStop → PostToolUse(Agent) ordering quirk in
                // Claude Code 2026-06 — see SUBAGENT_TOMBSTONE_TTL_MS).
                // `reset` clears the per-tab tombstone alongside the live
                // set, since SessionStart/End drops all prior state.
                const tomb = this.subagentTombstones.get(parsed.tab_id)
                for (const ev of events) {
                    if (ev.kind === 'reset') {
                        this.subagentTombstones.delete(parsed.tab_id)
                        next = reduceSubagentSet(next, ev)
                        continue
                    }
                    if (ev.kind === 'stop') {
                        const t = tomb ?? new Map<string, number>()
                        t.set(ev.agentId, eventAt)
                        // Lazy GC: opportunistically drop aged-out entries
                        // so the map doesn't grow unbounded across long
                        // sessions. Bounded effort per stop (~O(entries)).
                        for (const [id, ts] of t) {
                            if (eventAt - ts > SUBAGENT_TOMBSTONE_TTL_MS) t.delete(id)
                        }
                        this.subagentTombstones.set(parsed.tab_id, t)
                        next = reduceSubagentSet(next, ev)
                        continue
                    }
                    // ev.kind === 'spawn'
                    const stopTs = tomb?.get(ev.agentId)
                    if (stopTs !== undefined && eventAt - stopTs <= SUBAGENT_TOMBSTONE_TTL_MS) {
                        // Late spawn after stop — drop on the floor. Don't
                        // hand to reducer. This is the actual bug fix.
                        //
                        // Edge: a same-line `[stop, spawn]` pair for the
                        // SAME id (`eventAt - stopTs === 0`) also gets
                        // suppressed here. Intentional — Claude doesn't
                        // reuse an id within a single hook line today, so
                        // the realistic case this represents IS the
                        // 2s-late `PostToolUse(Agent)` carrying its
                        // already-stopped subagent's id. If a future
                        // Claude version genuinely fires stop+respawn in
                        // the same line, this guard will need a strict
                        // `< TTL` check OR an explicit allowlist.
                        continue
                    }
                    next = reduceSubagentSet(next, ev)
                }
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
                // And for the live-monitor set: a Claude crash that left
                // monitors "live" with no matching TaskStop would otherwise
                // carry the count into the next session as a phantom badge.
                if (this.liveMonitorTaskIds.delete(parsed.tab_id)) changed = true
                // Tombstones are session-scoped too — keeping them across a
                // SessionStart would suppress a brand-new spawn that
                // legitimately reused an id from a crashed prior session.
                // Belt-and-braces with the per-event reset inside the
                // reducer loop above: this catches the case where reset is
                // the only event in the line (e.g. a bare SessionStart with
                // no agent_id) and the reducer loop's reset branch already
                // ran but we want the delete to be idempotent.
                this.subagentTombstones.delete(parsed.tab_id)
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

            // Monitor task lifecycle. PostToolUse(Monitor) carries the id of
            // the freshly-started Monitor in monitor_task_id; PreToolUse(TaskStop)
            // carries the id of the task being stopped in stop_task_id.
            // Mutations bump `changed` so the sidebar repaints immediately
            // (the bg-Bash path above relies on TabMonitor's process-tree
            // poll for its visible update — Monitor has no process-tree
            // signal, so the hook IS the signal).
            //
            // SessionStart / SessionEnd reset is handled by the
            // boundary-reset block below — kept together with the other
            // session-scoped trackers so the boundary semantics stay in
            // one place.
            if (parsed.event === 'PostToolUse' && parsed.tool_name === 'Monitor' && parsed.monitor_task_id) {
                const live = this.liveMonitorTaskIds.get(parsed.tab_id) ?? new Map<string, number>()
                if (!live.has(parsed.monitor_task_id)) {
                    // Stamp the id with its give-up deadline so it self-evicts
                    // even though Claude fires no end-of-monitor hook. A
                    // non-positive / absent timeout falls back to the cap.
                    const timeout = parsed.monitor_timeout_ms && parsed.monitor_timeout_ms > 0
                        ? parsed.monitor_timeout_ms
                        : DEFAULT_MONITOR_TTL_MS
                    live.set(parsed.monitor_task_id, eventAt + timeout + MONITOR_TTL_GRACE_MS)
                    this.liveMonitorTaskIds.set(parsed.tab_id, live)
                    changed = true
                }
            }
            if (parsed.event === 'PreToolUse' && parsed.tool_name === 'TaskStop' && parsed.stop_task_id) {
                const live = this.liveMonitorTaskIds.get(parsed.tab_id)
                // TaskStop also targets backgrounded Bash shells (same tool,
                // different task-id domain). Stop ids for non-monitor tasks
                // simply fall through with no map match — silently ignored
                // exactly like phantom SubagentStops, no over-decrement risk.
                if (live?.delete(parsed.stop_task_id)) {
                    if (live.size === 0) this.liveMonitorTaskIds.delete(parsed.tab_id)
                    changed = true
                }
            }

        }

        let status = adapter.mapEventToStatus(parsed.event, parsed.matcher)
        if (parsed.event === 'PostToolUse' && parsed.interrupted === 1) {
            status = TabStatus.Idle
        }
        if (!status) return changed

        const prev = this.map.get(parsed.tab_id)
        this.map.set(parsed.tab_id, {
            tabId: parsed.tab_id,
            tool: adapter.id,
            status,
            eventAt,
            sessionId: parsed.session_id || null,
            cwd: parsed.cwd || null,
            transcriptPath: parsed.transcript_path || null,
            // Sticky: keep the last non-empty model so Claude's one-shot
            // SessionStart slug survives later model-less events — EXCEPT on a
            // fresh SessionStart, which begins a new session and must NOT
            // inherit the prior session's slug. A model-less SessionStart drops
            // the sticky to null rather than carrying a stale model forward
            // (same tab, reused after the prior agent exited).
            model: parsed.model || (parsed.event === 'SessionStart' ? null : prev?.model ?? null),
        })
        return true
    }

    private emit (): void {
        // Pass a new Map reference so downstream pure-equality checks fire.
        this.subject.next(new Map(this.map))
    }
}
