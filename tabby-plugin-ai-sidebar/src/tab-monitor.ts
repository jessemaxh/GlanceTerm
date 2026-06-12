import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { execFile } from 'child_process'
import * as fsSync from 'fs'
import * as fs from 'fs/promises'
import { promisify } from 'util'

import { AppService, BaseTabComponent } from 'tabby-core'

/**
 * Promisified `execFile` — used in lieu of `execSync` throughout the
 * monitor's process-tree probes. Two reasons we switched:
 *
 *   1. `execSync` blocks the renderer thread. At 10+ tabs that's hundreds
 *      of synchronous `ps`/`pgrep`/`wmic` calls per 1.5 s tick, which
 *      manifests as visible Tabby UI jank.
 *   2. `execFile` doesn't shell-interpret its args. The caller passes argv
 *      as an array, so pid lists and other interpolated values are
 *      safe by construction — no shell-injection surface even if a
 *      probe were ever wired to attacker-controllable input.
 *
 * Wrapped in a tiny helper so the call sites stay one-liners and the
 * common error path (timeout, missing binary, non-zero exit) collapses
 * to a returned empty string. Callers parse the stdout and fall back to
 * "no info" semantics on empty — matching the pre-refactor
 * `try/catch { swallow }` behavior. */
const execFileAsync = promisify(execFile)
async function runProbe (cmd: string, args: string[], timeoutMs: number): Promise<string> {
    try {
        const { stdout } = await execFileAsync(cmd, args, {
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true,
        })
        return stdout
    } catch { return '' }
}

import { HookAdapterRegistry } from './hook-adapters/registry'
import { HookWatcherService, HookSnapshot } from './hook-watcher.service'
import { HookInstallerService } from './hook-installer.service'
import { UsageTrackerService } from './usage-tracker.service'

/** Poll cadence for process-tree scans. Hooks deliver state pushes; the poll
 * is only here to discover when an AI tool starts/stops in a tab. */
const POLL_MS = 1500

/** Max consecutive ticks the AI-tool detection hysteresis will hold a tab's
 *  last-known tool open while the process probe is in a total outage (can't
 *  confirm OR deny the agent's pid). ~3 ticks ≈ 4.5 s — long enough to ride
 *  out a transient `ps` storm, short enough that a genuinely-exited agent
 *  doesn't linger as "alive" for more than a few seconds. When the snapshot
 *  IS usable, liveness is checked directly and this grace doesn't apply. */
const AI_DETECT_GRACE_MISSES = 3

/** A direct child of the AI agent process is counted as a "background job"
 *  once it has survived at least this many ms — i.e. been observed across
 *  ≥ 2 polls (POLL_MS = 1500). Short-lived synchronous Bash invocations
 *  (Claude calling `ls`, ripgrep, etc.) typically finish well under 1 s, so
 *  the persistence filter drops them while keeping long-running
 *  backgrounded shells (Claude's `run_in_background: true`, Codex equivalents).
 *  Tradeoff: a synchronous tool call that genuinely runs >2 s will be
 *  counted as a bg job for the rest of its lifetime — an over-count, not an
 *  under-count, which we prefer because under-counting hides real work. */
const BG_PERSIST_MS = 2_000

/**
 * How long a raw `idle` must sit stable in the hook layer after a prior
 * `working` before we surface it to UI consumers. Claude (and other agents
 * we're likely to add) can fire Stop briefly between user prompts within
 * a session — a Stop that's almost immediately followed by another
 * UserPromptSubmit reads to the user as "the agent is still going", and a
 * flicker working → ready → working in the rail dot looks like a bug. We
 * hold the displayed status as `working` until the hook layer has been
 * idle for IDLE_STABILITY_MS straight; only then do we expose `idle`.
 *
 * Gate is armed ONLY by an observed `working`. Idle that follows
 * `SessionStart`, `needs_permission`, or first-observation (`awaitingFirstEvent`)
 * is exposed immediately — those aren't the noisy transition we're filtering.
 *
 * 3 s matches the threshold previously used by AttentionNotifierService for
 * its "ready" notification (now removed in favour of this single source of
 * truth). Picked to comfortably exceed the longest inter-event flutter
 * we've measured for Claude, while keeping the "agent finished" badge
 * appearing within human-reaction-latency of the actual stop.
 */
const IDLE_STABILITY_MS = 3_000

/**
 * Slow-path interrupt detector grace + throttle. The fast path
 * (EscInterruptService → HookWatcher.forceIdle) catches the user pressing
 * ESC at the keyboard. The slow path catches the rest: agent-internal
 * timeouts, `/clear` commands, pasted interrupts, anything that bypasses
 * keyboard input but still terminates the turn. Both agents we support
 * today (claude / codex) leave a marker in their transcript
 * (`[Request interrupted by user`, `turn_aborted`, `task_aborted`) — see
 * `transcriptEndedAfter`.
 *
 * GRACE_MS: how long after the latest hook event before we even start
 * looking at the transcript. Below this we assume hooks will fire on time
 * for the normal Stop / interrupted PostToolUse path. 2 s is comfortably
 * past Claude's typical PostToolUse latency.
 *
 * INTERVAL_MS: minimum gap between transcript reads per tab. Each read is
 * a tail-128KB-and-JSON.parse — cheap but not free. 1 s keeps detection
 * within human-reaction-latency while bounding disk traffic for a 50-tab
 * Working population to ~50 reads/s peak. */
const TRANSCRIPT_INTERRUPT_GRACE_MS = 2_000
const TRANSCRIPT_INTERRUPT_INTERVAL_MS = 1_000

/**
 * `Done` is render-derived, never emitted by hooks or this monitor. The sidebar
 * (and jumper) treat `Idle` as `Done` while UnreadService.isUnread() is true
 * for the tab — i.e. the agent finished a turn and the user hasn't focused the
 * tab since. The transition done → idle ("ready") happens automatically when
 * UnreadService clears the entry on focus. Keeping it in the union lets all
 * UI-facing consumers share one TabStatus type without a separate DisplayStatus.
 *
 * Pattern: `as const`-frozen object + derived type. Same shape as `NotifyKind`
 * in attention-notifier — gives every comparison site a named constant
 * (`TabStatus.Working` instead of `'working'`) while keeping function
 * signatures concise via the type alias. The runtime values are the
 * stringly-typed names the hook layer + sidebar template DOM attributes use,
 * so changing the strings here would propagate to CSS data-attribute
 * selectors and persisted snapshots.
 */
export const TabStatus = {
    Working: 'working',
    Done: 'done',
    Idle: 'idle',
    NeedsPermission: 'needs_permission',
    NoAi: 'no_ai',
} as const
export type TabStatus = typeof TabStatus[keyof typeof TabStatus]

/**
 * AI CLIs we recognise from `ps` output. Knowing WHICH tool is running tells
 * the UI which HookAdapter to consult and which tag (CLA/CDX/AID …) to draw.
 * Pure process-tree match — never screen content. To add a new tool: add the
 * regex pair here AND register the matching adapter (see hook-adapters/).
 */
export type AiTool =
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'opencode'

const AI_PATTERNS: Array<{ tool: AiTool; regexes: RegExp[] }> = [
    {
        tool: 'claude',
        regexes: [
            /\bclaude(\s|$)/,
            /\/(?:@anthropic-ai\/)?claude-code\/[^\s]+\.[mc]?js/,
        ],
    },
    {
        tool: 'codex',
        regexes: [
            /\bcodex(\s|$)/,
            /\/codex(?:-cli)?\/[^\s]+\.[mc]?js/,
        ],
    },
    {
        tool: 'gemini',
        regexes: [
            /\bgemini(\s|$)/,
            /\/(?:@google\/)?gemini(?:-cli)?\/[^\s]+\.[mc]?js/,
        ],
    },
    {
        tool: 'opencode',
        regexes: [
            /\bopencode(\s|$)/,
            /\/opencode\/[^\s]+\.[mc]?js/,
        ],
    },
]

export function detectAiToolFromCommand (command: string): AiTool | null {
    const match = AI_PATTERNS.find(p => p.regexes.some(r => r.test(command)))
    return match?.tool ?? null
}

export interface TabState {
    /** Outer tab in app.tabs[]. Pass to AppService.selectTab() to focus. */
    outerTab: BaseTabComponent
    /** Inner tab (= outerTab unless it's inside a split). */
    innerTab: BaseTabComponent
    /**
     * GLANCETERM_TAB_ID for this inner tab — same value Session injects into
     * the PTY env, what the hook handler writes as `tab_id` in the per-tab
     * .log file, and the key HookWatcher uses in snapshots$. Null when the
     * tab has no Session (placeholder rows / non-terminal tabs). Routing key
     * for cross-service correlation; UI persistence should still prefer the
     * sidebar's own per-tab identity UUID since this id is regenerated on
     * fresh sessions.
     */
    tabId: string | null
    /** What the user sees in the top tab bar — used as our row label. */
    title: string
    /** The descendant AI process pid, if there is one. */
    aiPid: number | null
    /** Which AI tool we detected running, if any. */
    aiTool: AiTool | null
    /**
     * Raw command line of the AI process exactly as `ps -p <aiPid> -o command=`
     * reported it — the argv-joined string we matched against AI_PATTERNS.
     * Includes the interpreter for node-launched CLIs ("node /Users/me/.claude/
     * .../claude --resume foo") and absolute paths for shell-launched ones
     * ("/usr/local/bin/claude --resume foo"). AutoResumeService strips the
     * interpreter / path down to a re-runnable invocation before persisting
     * so flags survive a restart even though absolute paths might not be
     * portable across the user's PATH at restart time.
     */
    aiCommandLine: string | null
    /** Final state for the UI to render. */
    status: TabStatus
    /** Best-effort cwd of the shell session. Display only. */
    cwd: string | null
    /** ms since the last hook event for this tab — null if no event yet. */
    lastActiveMs: number | null
    /**
     * True when this tab has an adapter-supported tool AND no hook event has
     * fired yet. UI uses this to render "waiting for first event…" rather
     * than a stale or fabricated status.
     */
    awaitingFirstEvent: boolean
    /**
     * Number of subagents the main agent has spawned without a matching
     * SubagentStop yet. Sidebar renders `· N agents` after the status when
     * > 0. Also drives the idle→working override (see hook-watcher's
     * subagentInFlight doc).
     */
    subagentCount: number
    /**
     * Number of long-lived child processes hanging off `aiPid` — proxy for
     * "backgrounded shells / jobs the agent kicked off and walked away
     * from". Sidebar renders `· N shell` after the status when > 0
     * (Claude agents) or `· N bg` for agents without a hook adapter.
     * Agent-agnostic: any AI tool that spawns a subprocess that survives
     * across polls bumps this count, no per-agent code required. See
     * BG_PERSIST_MS for the persistence threshold and the over- vs
     * under-count tradeoff. Mirrors the "N shell" half of Claude's
     * footer pair "N shell, M monitor".
     */
    backgroundJobCount: number
    /**
     * Number of Monitor-tool tasks the agent has started without a
     * matching TaskStop yet. Claude-only today (the only adapter that
     * surfaces Monitor lifecycle via hook events); non-Claude tabs
     * always read 0. Sidebar renders `· M monitor` after the status when
     * > 0. Mirrors the "M monitor" half of Claude's footer pair.
     */
    monitorCount: number
    /**
     * Active model id for this tab's agent, if known (e.g. `claude-opus-4-8`,
     * `gpt-5.5`). Sidebar renders it next to the agent tag. Null when unknown
     * (no event yet / source unavailable).
     *
     * Freshness is per-agent, NOT uniformly live: Codex stamps `.model` on
     * every hook event (so a mid-session switch is reflected), but Claude only
     * emits the slug once at `SessionStart` — a mid-session `/model` is NOT
     * picked up until the next session (the watcher keeps it sticky within a
     * session and drops it on the next SessionStart). Source is per-agent (the
     * hook payload field where the agent provides one); see makeState and
     * HookWatcher.processEvent's sticky-model rule.
     */
    model: string | null
    /**
     * Cumulative session token usage for this tab — `in`/`out` (uncached
     * input + output). Null when unknown. Summed from the agent's transcript
     * (hook events don't carry session totals); cache-read/creation tokens are
     * deliberately excluded (they dwarf real usage and would mislead). Sidebar
     * renders `↑<in> ↓<out>` in k/M units. See the transcript usage reader.
     */
    tokensIn: number | null
    tokensOut: number | null
}

interface ChildProcessInfo { pid: number; ppid: number; command: string }

/**
 * Polls Tabby's tab list and produces a TabState per terminal tab.
 *
 * Hook-driven architecture (v0.2):
 *   1. Tabby spawns each shell with `GLANCETERM_TAB_ID=<uuid>` (see
 *      tabby-local/src/session.ts).
 *   2. On first launch the installer writes that uuid into the AI tool's
 *      settings hook entries, so the agent's hook handler calls our script
 *      with that env var inherited from the shell.
 *   3. The handler writes JSON status to ~/.glanceterm/hooks/<uuid>.json.
 *   4. HookWatcherService fs.watches that dir and exposes a sync getStatus.
 *   5. This TabMonitor stitches the two halves together: it discovers which
 *      AI tool is alive in each tab via the process tree, then looks up that
 *      tab's hook snapshot to decide working/idle/needs_permission.
 *
 * Tools with adapters but no event yet show as `idle` with awaitingFirstEvent
 * = true. Tools without adapters (opencode, until its adapter lands) show as
 * `working` for as long as the process is alive — degraded but visible. Their
 * granular state will arrive when those adapters land.
 */
@Injectable({ providedIn: 'root' })
export class TabMonitor implements OnDestroy {
    private subject = new BehaviorSubject<TabState[]>([])
    private timer?: NodeJS.Timeout
    private busy = false
    /**
     * Coalescing flag for `tick()` requests that arrive while a tick is in
     * flight. Without it, the 50-200 ms async window of one tick swallows
     * any `tabsChanged$` / `hooks.snapshots$` event that fires during it,
     * and the next refresh has to wait POLL_MS — re-introducing the lag
     * the event subscription was added to fix. The boot-recovery path is
     * the worst offender: AppService's `for (const tab of tabs) openNewTabRaw`
     * fires N synchronous `tabsChanged.next()`s while the first tick is
     * still awaiting `buildProcessTreeSnapshot()`, so N-1 of them get
     * dropped and the sidebar briefly shows only one of the recovered tabs.
     * With this flag, the in-flight tick re-fires exactly once at the end
     * regardless of how many events piled up — full state restored within
     * one extra tick instead of waiting up to 1.5 s for the timer.
     */
    private pendingTick = false
    /** Cache so we don't re-stat per tick when nothing has changed. */
    private shellPidCache = new WeakMap<BaseTabComponent, number>()
    /**
     * Last successful AI-tool detection per tab — the hysteresis anchor that
     * stops a single failed `ps -p … -o command=` read from collapsing a live
     * agent row to `no_ai` for one tick (visible flicker: agent → no-agent →
     * agent). The command-read probe is the SOLE source of command text
     * (candidates carry `command: ''`), is capped at 500 ms, and — since the
     * async-exec refactor — competes with a busy event loop, so it misses
     * often enough to flap. We retain this tool while its pid is still present
     * in the per-tick process snapshot; see `makeState`.
     */
    private aiDetectCache = new WeakMap<BaseTabComponent, { tool: AiTool, pid: number, cmd: string }>()
    /** Consecutive ticks we've held `aiDetectCache` open during a whole-tick
     *  process-probe outage (snapshot empty AND command-read empty). Bounds the
     *  hold so a permanently wedged `ps` can't pin a dead agent forever. */
    private aiDetectMisses = new WeakMap<BaseTabComponent, number>()
    /**
     * Per-tab cache of the REAL `GLANCETERM_TAB_ID` read from the running
     * PTY process's environment block. Authoritative over `sess.glancetermTabId`
     * because any path that attaches a NEW Session instance to a PRE-EXISTING
     * pty produces a fresh field-initializer UUID on the Session while the
     * live pty's env block still holds the UUID injected at the original
     * spawn. The hook handler writes JSON named after the env-block UUID, so
     * we must match THAT one or every row stays "awaitingFirstEvent" forever.
     *
     * Paths that trigger the mismatch:
     *   - Renderer reload (dev hot-reload, or Cmd+R when TABBY_DEV adds the
     *     `role: 'reload'` menu — see app/lib/app.ts). Main process keeps the
     *     PTYManager alive, so PTYs survive while the renderer reconstructs
     *     all Sessions from scratch.
     *   - "Duplicate tab while keeping state" / split-tab recovery within a
     *     running app — `terminalTab.component.ts` calls back into
     *     `Session.start` with `restoreFromPTYID`, reattaching to a live pty.
     *     (Available in release builds — user-triggered, but it exists.)
     *   - Renderer-only crash recovery (rare): renderer dies and Electron
     *     reloads it; main process and PTYs untouched.
     *
     * NOT a problem: cold app relaunch. Main process death takes PTYManager
     * with it, all PTYs are killed, the next launch spawns fresh PTYs whose
     * env block and Session UUID are generated together.
     *
     * Once captured, the value never changes — env blocks are immutable post-exec.
     */
    private envTabIdCache = new WeakMap<BaseTabComponent, string>()
    /**
     * Per-tool flag — true once we've kicked off `installer.installFor(tool)`
     * in response to detecting that tool running. Covers the "installed
     * Claude AFTER GlanceTerm was already up" case: startup-time install
     * was gated off (no ~/.claude/ yet), then user installs Claude and runs
     * it, we see the process, fire a one-shot install. Idempotent so the
     * worst case is one redundant lockfile probe.
     */
    private installTriggered = new Set<AiTool>()
    /**
     * Per-tab "the last non-idle hook status we saw was `working`" flag.
     * Set to true the first time a tab's raw hook status is observed as
     * `working`; cleared when raw goes to `needs_permission` or `no_ai`,
     * or when an idle has been stable long enough to release the gate
     * (see IDLE_STABILITY_MS). The flag drives the idle-stability gate:
     * only an armed tab's idle gets held back. A SessionStart-fresh idle,
     * or a permission → idle sequence, surfaces immediately.
     */
    private idleGateArmed = new WeakMap<BaseTabComponent, boolean>()
    /**
     * Per-tab "re-tick at gate release" timer. POLL_MS is 1.5 s, so without
     * an explicit timer the user would see the rail dot stay on "working"
     * for up to (3 s gate + 1.5 s poll = 4.5 s) instead of 3 s flat. The
     * timer fires a single tick at the moment the gate is due to release;
     * the tick re-reads snap.eventAt and exposes idle if still stable.
     * Always reset, never accumulated — each new gate engagement replaces
     * the previous timer.
     */
    private idleGateTimers = new WeakMap<BaseTabComponent, ReturnType<typeof setTimeout>>()
    /**
     * Strong references to every pending idle-gate timer handle. The WeakMap
     * above is keyed by inner tab (so entries vanish with the tab), but its
     * VALUES — the setTimeout handles — aren't iterable, so ngOnDestroy can't
     * cancel them through it. This Set lets teardown clear all outstanding
     * timers; kept in lockstep with the WeakMap by scheduleGateRelease /
     * clearGateTimer / the fire callback.
     */
    private idleGateTimerHandles = new Set<ReturnType<typeof setTimeout>>()
    /**
     * Per-tab "we entered effective `working` at this wall-clock ms" anchor.
     * Set on the first tick that surfaces status=working after a non-working
     * tick; cleared when status leaves working. Drives `lastActiveMs` for
     * working tabs so the sidebar age cell shows turn-duration (matching the
     * AI tool's own spinner — e.g. Claude's "Propagating… 9m 16s") instead
     * of "ms since the last hook event", which resets to ~0 on every
     * PreToolUse / PostToolUse and made an actively-chewing agent display
     * "0s" indefinitely.
     *
     * Why anchor to NOW and not snap.eventAt: the working-triggering hook
     * has already fired, so NOW under-reports by at most one poll interval
     * (POLL_MS = 1.5 s) while snap.eventAt would over-report after a
     * SessionStart-style event whose timestamp lives in the past. A
     * one-poll undercount is the gentler error.
     *
     * Idle flicker is already absorbed by applyIdleGate (a brief raw idle
     * inside IDLE_STABILITY_MS stays effective=working), so a working
     * stretch peppered with PostToolUse → SessionStart pings does NOT
     * cause the timer to restart — workingSince only clears when the
     * effective status actually leaves working.
     */
    private workingSince = new WeakMap<BaseTabComponent, number>()
    /**
     * Per-tab map of `child pid → first-seen wall-clock ms` for the immediate
     * descendants of the tab's `aiPid`. Entries age in by being observed on
     * a tick; entries age out when the pid is no longer in the current child
     * list. Counted toward `backgroundJobCount` once the entry is at least
     * BG_PERSIST_MS old. Inner map is reused across ticks so persistence
     * survives — see makeState for the update protocol.
     */
    private bgChildrenFirstSeen = new WeakMap<BaseTabComponent, Map<number, number>>()
    /**
     * Per-tab set of child pids that have been **definitively** confirmed as
     * background jobs via a Claude hook signal (PreToolUse(Bash,
     * run_in_background:true) → claimed against a newly-appeared child on
     * a subsequent poll tick). Confirmed pids are counted immediately,
     * bypassing the BG_PERSIST_MS persistence threshold that the unhooked
     * heuristic relies on. Pids in this set are removed when they exit
     * (no longer appear in `pgrep -P aiPid`).
     *
     * Why a separate set from bgChildrenFirstSeen: pids in firstSeen are
     * still "auditioning" for bg-job status (the heuristic needs them to
     * persist past the threshold). Pids in bgConfirmedPids have already
     * earned the badge — no audition needed. Keeping the two sets
     * disjoint means the count is `confirmed.size +
     * (firstSeen entries past threshold).size`, no double counting.
     */
    private bgConfirmedPids = new WeakMap<BaseTabComponent, Set<number>>()
    /**
     * Per-tab last-time we ran the transcript interrupt probe. Throttles the
     * slow-path check to TRANSCRIPT_INTERRUPT_INTERVAL_MS so a stuck-Working
     * tab doesn't trigger a transcript read on every poll tick. Reset (entry
     * dropped) when the tab's effective status leaves Working — the next
     * Working entry starts a fresh probe schedule.
     */
    private lastTranscriptProbeAt = new WeakMap<BaseTabComponent, number>()

    readonly states$: Observable<TabState[]> = this.subject.asObservable()

    /** Snapshot of the most recent tick's states — useful for one-shot
     *  consumers (e.g. the screenshot paste service) that need a value
     *  without subscribing. */
    get current (): TabState[] {
        return this.subject.getValue()
    }

    constructor (
        private app: AppService,
        private registry: HookAdapterRegistry,
        private hooks: HookWatcherService,
        private installer: HookInstallerService,
        private usage: UsageTrackerService,
    ) {
        void this.tick()
        this.timer = setInterval(() => { void this.tick() }, POLL_MS)
        // A fresh hook event should refresh the UI within the next render
        // cycle even if no poll has fired since — re-emit our last states.
        this.hooks.snapshots$.subscribe(() => { void this.tick() })
        // Tab open / close / split-pane add+remove / tab-adoption all funnel
        // through AppService.tabsChanged$ (see app.service.ts addTabRaw + the
        // SplitTabComponent hookup). Without this the sidebar list only
        // refreshes on the next POLL_MS tick, so a fresh ⌘T sits invisible
        // for up to 1.5 s and a closed tab lingers as a ghost row just as
        // long. One extra tick per tab event is cheap compared to that lag.
        this.app.tabsChanged$.subscribe(() => { void this.tick() })
    }

    ngOnDestroy (): void {
        if (this.timer) clearInterval(this.timer)
        // Cancel any pending idle-gate re-tick timers so they don't fire into
        // a torn-down monitor after the poll loop has stopped.
        for (const t of this.idleGateTimerHandles) clearTimeout(t)
        this.idleGateTimerHandles.clear()
    }

    private async tick (): Promise<void> {
        if (this.busy) {
            // Record that someone wanted a tick — finally-block re-fires once
            // after the in-flight tick completes. Idempotent: N events during
            // one tick still collapse to one re-fire.
            this.pendingTick = true
            return
        }
        this.busy = true
        try {
            const tabs = this.collectTerminalTabs()
            // Build the process-tree snapshot ONCE per tick. All per-tab
            // ancestor walks become memory lookups against this map instead
            // of one synchronous `ps -p` per step. See ProcessTreeSnapshot
            // doc for the perf rationale.
            const snapshot = await buildProcessTreeSnapshot()
            const out: TabState[] = []
            const CHUNK = 8
            for (let i = 0; i < tabs.length; i += CHUNK) {
                const chunk = tabs.slice(i, i + CHUNK)
                const results = await Promise.all(chunk.map(t => this.safeMakeState(t, snapshot)))
                for (const r of results) if (r) out.push(r)
            }
            this.subject.next(out)

            // GC HookWatcher's per-tab state for tabs closed since the last
            // sweep — the on-disk handler never unlinks a tab's log, so the
            // watcher's own ENOENT cleanup never fires (it'd otherwise leak one
            // entry per tab UUID ever seen). We own the tab↔UUID mapping, so we
            // hand it the live UUID set; it evicts the rest. Skipped on an
            // empty scan (shutdown / transient) so we never nuke live state.
            if (tabs.length > 0) {
                const liveTabIds = new Set<string>()
                for (const { inner } of tabs) {
                    const s = (inner as unknown as { session?: { glancetermTabId?: string } }).session
                    if (s?.glancetermTabId) liveTabIds.add(s.glancetermTabId)
                    const env = this.envTabIdCache.get(inner)
                    if (env) liveTabIds.add(env)
                }
                this.hooks.retainOnly(liveTabIds)
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] tick failed:', e)
        } finally {
            this.busy = false
            if (this.pendingTick) {
                this.pendingTick = false
                void this.tick()
            }
        }
    }

    private async safeMakeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
        snapshot: ProcessTreeSnapshot,
    ): Promise<TabState | null> {
        try {
            return await this.makeState(t, snapshot)
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] makeState failed for tab:', t.outer?.title, e)
            return null
        }
    }

    private async makeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
        snapshot: ProcessTreeSnapshot,
    ): Promise<TabState | null> {
        const sess: any = (t.inner as any).session
        if (!sess || typeof sess.getChildProcesses !== 'function') {
            // Restored tab with no live session — show as no_ai so the row
            // appears (user can click to wake it) without lighting up status.
            return this.placeholderState(t)
        }

        // 1. truePID = the pty's foreground process leader. We also use it
        //    as our shell-pid cache value (informational) AND include it in
        //    the AI-tool scan — see (2) below.
        let truePid: number | null = null
        try {
            const pid = await sess.pty?.getTruePID?.()
            if (typeof pid === 'number' && pid > 0) {
                truePid = pid
                this.shellPidCache.set(t.inner, pid)
            }
        } catch { /* swallow */ }
        if (!truePid && this.shellPidCache.has(t.inner)) {
            truePid = this.shellPidCache.get(t.inner) ?? null
        }

        // 2. Process-tree AI tool detection. Tabby's `command` field lies
        //    for several tools (claude returns the version string), so
        //    re-read the real cmdline via ps.
        //
        //    IMPORTANT: scan both `children` AND `truePID` itself. When the
        //    user runs an AI CLI like `claude` from a shell, the tty's
        //    foreground process group leader becomes claude — so getTruePID
        //    returns claude's pid, and `getChildProcesses` (which filters by
        //    `ppid === truePID`) only returns claude's OWN children (zsh,
        //    caffeinate). If we only inspect children we never see claude.
        let children: ChildProcessInfo[] = []
        try {
            children = await sess.getChildProcesses() ?? []
        } catch { /* swallow */ }

        // Candidates: truePID + its ANCESTORS + its DIRECT CHILDREN.
        //
        // Why ancestors: the pty's foreground-process leader (truePID) is
        // whichever process currently holds the controlling tty. When the
        // user runs `claude`, claude may spawn helpers (zsh subshells,
        // `caffeinate`, …). Any of those can end up as the foreground
        // leader at the moment we poll, which means truePID is sometimes
        // `caffeinate` while the actual AI tool sits one level up. We walk
        // up the ppid chain a few steps to make sure we still see claude.
        //
        // Why direct children: covers the inverse case — e.g. shell is still
        // foreground and claude was just launched but hasn't taken over yet.
        //
        // Ordering: truePID first, then ancestors (closest first), then
        // children. First AI match wins, so the most "active" candidate
        // (the foreground program itself) gets priority over its parent
        // shell when both look AI-ish.
        const candidates: ChildProcessInfo[] = []
        const seenPids = new Set<number>()
        const pushCand = (pid: number) => {
            if (pid > 0 && !seenPids.has(pid)) {
                seenPids.add(pid)
                candidates.push({ pid, ppid: -1, command: '' })
            }
        }
        if (truePid !== null) {
            pushCand(truePid)
            for (const a of ancestorsOf(truePid, snapshot, 6)) pushCand(a)
        }
        for (const c of children) pushCand(c.pid)

        const realCmds = await realCommandsFor(candidates.map(c => c.pid))

        let aiTool: AiTool | null = null
        let aiPid: number | null = null
        let aiCommandLine: string | null = null
        for (const c of candidates) {
            const real = realCmds.get(c.pid) ?? c.command
            if (!real) continue
            const match = detectAiToolFromCommand(real)
            if (match) { aiTool = match; aiPid = c.pid; aiCommandLine = real; break }
        }

        // --- detection hysteresis -------------------------------------------
        // The command-read above (`realCommandsFor`) is one 500 ms-capped `ps`
        // call and the ONLY source of command text (candidates seed
        // `command: ''`). A single timeout/partial read yields no match → the
        // row would flip to `no_ai` for one tick then snap back next tick —
        // the agent ⇄ no-agent flicker. So when we fail to detect but saw a
        // tool last tick, hold that tool as long as we can't positively prove
        // the agent exited:
        //   • pid still in the snapshot  → alive, command-read just missed → hold.
        //   • snapshot itself unavailable → can't tell → hold for a bounded grace.
        //   • snapshot good but pid gone  → genuinely exited → release to no_ai.
        // A real agent exit still surfaces within one tick because the
        // `ps -A` snapshot (built separately, 800 ms cap) is far more reliable
        // than a per-pid command read and tells us the pid is gone immediately.
        const prevAi = this.aiDetectCache.get(t.inner)
        if (aiTool) {
            this.aiDetectCache.set(t.inner, { tool: aiTool, pid: aiPid!, cmd: aiCommandLine ?? '' })
            this.aiDetectMisses.delete(t.inner)
        } else if (prevAi) {
            const snapshotUsable = snapshot.pidParent.size > 0
            if (snapshot.pidParent.has(prevAi.pid)) {
                aiTool = prevAi.tool; aiPid = prevAi.pid; aiCommandLine = prevAi.cmd
                this.aiDetectMisses.delete(t.inner)
            } else if (!snapshotUsable) {
                const misses = (this.aiDetectMisses.get(t.inner) ?? 0) + 1
                if (misses <= AI_DETECT_GRACE_MISSES) {
                    aiTool = prevAi.tool; aiPid = prevAi.pid; aiCommandLine = prevAi.cmd
                    this.aiDetectMisses.set(t.inner, misses)
                } else {
                    this.aiDetectCache.delete(t.inner); this.aiDetectMisses.delete(t.inner)
                }
            } else {
                this.aiDetectCache.delete(t.inner); this.aiDetectMisses.delete(t.inner)
            }
        }

        // First-detection trigger for late hook install — if Claude (etc.)
        // appeared on the machine AFTER GlanceTerm's startup install gate
        // ran, the user would otherwise need to relaunch GlanceTerm to get
        // hooks wired. Fire installFor() the first time we see each tool;
        // the installer is idempotent + lock-protected so repeat fires are
        // cheap. Skipped for non-adapter tools (no-op anyway).
        if (aiTool && this.registry.supports(aiTool) && !this.installTriggered.has(aiTool)) {
            this.installTriggered.add(aiTool)
            void this.installer.installFor(aiTool)
        }

        // 3. CWD (display only).
        let cwd: string | null = typeof sess.reportedCWD === 'string' && sess.reportedCWD
            ? sess.reportedCWD : null
        if (!cwd && typeof sess.getWorkingDirectory === 'function') {
            try { cwd = await sess.getWorkingDirectory() } catch { /* swallow */ }
        }

        // 4. Decide status. The new pipeline pivots on whether (a) an AI tool
        //    is running at all, (b) we have an adapter for it, (c) a hook has
        //    fired yet for the shell's GLANCETERM_TAB_ID.
        let status: TabStatus
        let lastActiveMs: number | null = null
        let awaitingFirstEvent = false
        // tabId hoisted to function scope so the TabState return at the
        // bottom can read HookWatcher's subagent in-flight counter. Stays
        // undefined for tabs without an adapter-supported AI tool, which
        // short-circuits the side-channel read.
        let tabId: string | undefined
        // Active model slug for this tab, surfaced from the hook snapshot
        // (Codex every event / Claude SessionStart / opencode plugin). Null
        // for unsupported tools or before any model-bearing event.
        let model: string | null = null
        // Cumulative session token usage (uncached input/output). Summed from
        // the transcript by UsageTrackerService — see below.
        let tokensIn: number | null = null
        let tokensOut: number | null = null

        if (!aiTool) {
            status = TabStatus.NoAi
            // Agent process died (or never existed): clear any side-channel
            // counters still keyed by this tab's UUID so a crash mid-subagent /
            // mid-monitor doesn't leave a phantom "live" entry sitting in
            // memory until the tab closes (retainOnly) or a new SessionStart
            // resets it. Cheap no-op for plain (never-AI) shells.
            const sid: string | undefined = sess.glancetermTabId
            if (sid) this.hooks.clearSideChannel(sid)
            const env = this.envTabIdCache.get(t.inner)
            if (env && env !== sid) this.hooks.clearSideChannel(env)
        } else if (!this.registry.supports(aiTool)) {
            // Tool we recognise via ps but don't have a hook adapter for yet —
            // degraded "we know it's alive, can't tell working vs idle" state.
            status = TabStatus.Working
        } else {
            // Prefer the UUID actually present in the live process env block —
            // see `envTabIdCache` doc above for why this beats sess.glancetermTabId.
            //
            // Try aiPid FIRST (almost always the right pick — claude/codex
            // were spawned by Tabby's shell, so they inherit GLANCETERM_TAB_ID
            // and are readable by `ps eww`/proc), then truePID, then ancestor
            // chain. The fallback covers the case where the foreground process
            // is a SIP-protected system binary like `caffeinate` whose env
            // block macOS refuses to expose — its parent (claude) is fine.
            const envCandidates: number[] = []
            const push = (p: number | null) => { if (p && !envCandidates.includes(p)) envCandidates.push(p) }
            push(aiPid)
            push(truePid)
            if (truePid) for (const a of ancestorsOf(truePid, snapshot, 6)) push(a)
            const envId = await this.readEnvTabId(t.inner, envCandidates)
            tabId = envId ?? sess.glancetermTabId
            const snap = tabId ? this.hooks.getStatus(tabId) : null
            if (snap) {
                model = snap.model
                // Cumulative token usage from the transcript (Claude today;
                // other agents return null until their reader lands). Throttled
                // + incremental inside the tracker, so this is cheap per tick.
                const usage = await this.usage.compute(t.inner, aiTool, snap.transcriptPath)
                if (usage) { tokensIn = usage.inTok; tokensOut = usage.outTok }
                // Subagent in-flight override: when the main agent has
                // spawned a backgrounded Task subagent, the main agent's
                // response ends → Stop → raw status = idle. The subagent
                // is still chewing tokens though, so we surface it as
                // working until the matching SubagentStop arrives and
                // drops the counter back to 0. See HookWatcher's
                // `subagentInFlight` doc for the counter contract.
                let rawStatus = snap.status
                if (rawStatus === TabStatus.Idle && tabId && this.hooks.getSubagentInFlight(tabId) > 0) {
                    rawStatus = TabStatus.Working
                }
                status = this.applyIdleGate(t.inner, rawStatus, snap.eventAt)
                lastActiveMs = Math.max(0, Date.now() - snap.eventAt)
                this.maybeProbeTranscriptInterrupt(t.inner, tabId, snap, status)
            } else {
                // Adapter exists and tool is running but no hook event in our
                // state dir yet. Either (a) hook just got installed and Claude
                // hasn't restarted, (b) session predates GLANCETERM_TAB_ID
                // injection, or (c) we somehow lost the file. Show "idle" so
                // the row reads as "present but not actively working" and
                // mark awaitingFirstEvent so UI can hint that to the user.
                status = TabStatus.Idle
                awaitingFirstEvent = true
            }
        }

        // Override lastActiveMs for working tabs to show turn-duration (since
        // entering effective=working) instead of "ms since last hook event".
        // See workingSince doc for rationale. Runs AFTER applyIdleGate so a
        // brief raw-idle inside the gate window doesn't reset the anchor.
        if (status === TabStatus.Working) {
            let since = this.workingSince.get(t.inner)
            if (since === undefined) {
                since = Date.now()
                this.workingSince.set(t.inner, since)
            }
            lastActiveMs = Date.now() - since
        } else {
            this.workingSince.delete(t.inner)
            this.lastTranscriptProbeAt.delete(t.inner)
        }

        // 5. Background-job count: confirmed (hook-signaled) + heuristic
        //    (persisted ≥BG_PERSIST_MS) immediate children of aiPid. Only
        //    meaningful when there IS an aiPid — for no_ai tabs we leave
        //    the count at 0 and also drop both trackers so a tab that
        //    later revives starts fresh instead of inheriting stale pids.
        //    tabId is passed through so we can drain the hook-signaled
        //    pending-arrival queue against this tick's new children.
        let backgroundJobCount = 0
        if (aiPid !== null) {
            backgroundJobCount = await this.updateBackgroundJobCount(t.inner, aiPid, tabId, aiTool)
        } else {
            this.bgChildrenFirstSeen.delete(t.inner)
            this.bgConfirmedPids.delete(t.inner)
        }

        return {
            outerTab: t.outer,
            innerTab: t.inner,
            tabId: tabId ?? null,
            title: t.outer.customTitle || t.outer.title || `(tab ${this.shellPidCache.get(t.inner) ?? '?'})`,
            aiTool,
            aiPid,
            aiCommandLine,
            cwd,
            status,
            lastActiveMs,
            awaitingFirstEvent,
            // Side-channel read from HookWatcher — default to 0 when we
            // couldn't resolve a tabId (no env var captured yet, no hook
            // event yet, etc.), matching placeholderState.
            subagentCount: tabId ? this.hooks.getSubagentInFlight(tabId) : 0,
            backgroundJobCount,
            monitorCount: tabId ? this.hooks.getMonitorInFlight(tabId) : 0,
            model,
            tokensIn,
            tokensOut,
        }
    }

    /**
     * Update the per-tab bg-job trackers and return the total count, which
     * is `confirmed (live) + heuristic (persisted ≥BG_PERSIST_MS)`. Two
     * complementary paths:
     *
     *   1. Confirmed: Claude's PreToolUse(Bash, run_in_background:true)
     *      hook events arrive in the watcher's per-tab FIFO queue; this
     *      method claims one queue entry per newly-appeared child PID and
     *      promotes that PID to `bgConfirmedPids`, where it counts
     *      immediately (no persistence delay). Hook-anchored confirmation
     *      means a long-running synchronous Bash never gets falsely badged.
     *
     *   2. Heuristic: PIDs that don't get claimed via the hook (because
     *      the tab's agent has no adapter, or because the hook arrived
     *      mid-tick and TabMonitor saw the child before HookWatcher
     *      processed the event) fall back to "alive for ≥BG_PERSIST_MS
     *      and you're counted." Over-counts long synchronous calls but
     *      keeps bg detection working across all agents.
     *
     * Both sets evict pids that no longer appear under aiPid. The two
     * sets are disjoint (a pid is promoted out of firstSeen the moment it
     * enters confirmed), so the final count is a simple sum with no
     * double counting.
     */
    private async updateBackgroundJobCount (
        inner: BaseTabComponent,
        aiPid: number,
        tabId: string | undefined,
        aiTool: AiTool | null,
    ): Promise<number> {
        const now = Date.now()
        const live = new Set(await childrenOf(aiPid))

        // Ensure both trackers exist.
        let firstSeen = this.bgChildrenFirstSeen.get(inner)
        if (!firstSeen) {
            firstSeen = new Map<number, number>()
            this.bgChildrenFirstSeen.set(inner, firstSeen)
        }
        let confirmed = this.bgConfirmedPids.get(inner)
        if (!confirmed) {
            confirmed = new Set<number>()
            this.bgConfirmedPids.set(inner, confirmed)
        }

        // Evict pids no longer alive from BOTH trackers — `kill` /
        // graceful exit / Claude calling KillShell all converge here.
        for (const pid of Array.from(firstSeen.keys())) {
            if (!live.has(pid)) firstSeen.delete(pid)
        }
        for (const pid of Array.from(confirmed)) {
            if (!live.has(pid)) confirmed.delete(pid)
        }

        // Age newly-observed pids into firstSeen (they enter the heuristic
        // bucket by default; the hook-claim step below may promote some
        // of them into confirmed in the same tick).
        const newThisTick: number[] = []
        for (const pid of live) {
            if (!firstSeen.has(pid) && !confirmed.has(pid)) {
                newThisTick.push(pid)
                firstSeen.set(pid, now)
            }
        }

        // Claim hook-signaled arrivals against this tick's new children.
        // FIFO order on both sides: first new pid gets credited to the
        // oldest pending arrival. Promoted pids leave firstSeen so we
        // don't double-count.
        if (tabId && newThisTick.length > 0) {
            const claimed = this.hooks.claimBgArrivals(tabId, newThisTick.length)
            for (let i = 0; i < claimed; i++) {
                const pid = newThisTick[i]
                firstSeen.delete(pid)
                confirmed.add(pid)
            }
        }

        // Is the hook authoritative for THIS tab? Three conditions:
        //   (a) the adapter promises a bg classification on every Bash
        //       (adapter.signalsBgJobs() — Claude/Codex yes), AND
        //   (b) we've resolved this tab's stable GLANCETERM_TAB_ID, AND
        //   (c) EITHER we've already seen a hook event for this tab
        //       (hooks.getStatus → real first-event seen → hook pipeline
        //       proven live), OR the adapter spawns a long-lived native
        //       helper child that would otherwise be misclassified by the
        //       heuristic the moment the process-tree poll spots it
        //       (Codex true, Claude false — see adapter.spawnsNativeHelper).
        //
        // The split keeps Claude's pre-first-event window safe: real bg
        // jobs that fire before the first PreToolUse still get counted by
        // the heuristic. For Codex, the helper child appears before any
        // hook event, so the heuristic must be suppressed from t=0 — done
        // via the per-adapter spawnsNativeHelper() escape hatch.
        const adapter = this.registry.forTool(aiTool)
        const hookAuthoritative = !!(
            adapter?.signalsBgJobs()
            && tabId
            && (this.hooks.getStatus(tabId) || adapter.spawnsNativeHelper())
        )

        if (hookAuthoritative) {
            // Race-recovery: a Bash hook event can flush AFTER the child
            // PID is already in firstSeen (the newThisTick claim above
            // only matches THIS tick's new pids — by the next poll the
            // PID is no longer new). The old persistence-time heuristic
            // implicitly absorbed this lag. With the heuristic suppressed
            // we instead pair each pending arrival against an unconfirmed
            // firstSeen PID — but ONLY ones whose `seenAt >= arrival.ts`,
            // i.e. the PID was first observed AT OR AFTER the bg hook fired.
            // Without this temporal gate a long-pre-existing child (e.g.
            // a still-running synchronous xcodebuild) would be falsely
            // credited to a brand-new bg arrival, and the real bg child
            // would later sit unmatched in firstSeen and never be counted.
            // Two-pointer pair-match (arrivals FIFO by ts, candidates
            // ascending by seenAt). Stops at the first arrival that has no
            // eligible candidate; remaining arrivals stay queued for a
            // future tick when the matching child becomes visible.
            if (tabId && firstSeen.size > 0) {
                const arrivals = this.hooks.peekBgArrivals(tabId)
                if (arrivals.length > 0) {
                    const candidates = Array.from(firstSeen.entries())
                        .sort((a, b) => a[1] - b[1])
                    const toPromote: number[] = []
                    let ai = 0; let ci = 0
                    while (ai < arrivals.length && ci < candidates.length) {
                        const [pid, seenAt] = candidates[ci]
                        if (seenAt >= arrivals[ai]) {
                            toPromote.push(pid)
                            ai++; ci++
                        } else {
                            ci++
                        }
                    }
                    if (toPromote.length > 0) {
                        // claimBgArrivals pops FIFO from the same queue we
                        // peeked, so `toPromote[i]` ↔ arrival at index i.
                        const claimed = this.hooks.claimBgArrivals(tabId, toPromote.length)
                        for (let i = 0; i < claimed; i++) {
                            const pid = toPromote[i]
                            firstSeen.delete(pid)
                            confirmed.add(pid)
                        }
                    }
                }
            }
            // Heuristic suppressed: trust the hook. A long-lived child of
            // aiPid that the hook never tagged as bg=1 is a synchronous
            // Bash (xcodebuild / npm install / …), not a bg job.
            return confirmed.size
        }

        // Fallback (no adapter / non-bg-signalling adapter / hooks not yet
        // firing): confirmed pids count immediately, heuristic pids only
        // after they've persisted past the threshold. Over-counts long
        // synchronous calls but keeps bg detection working without per-
        // call hook coverage.
        let count = confirmed.size
        for (const seenAt of firstSeen.values()) {
            if (now - seenAt >= BG_PERSIST_MS) count++
        }
        return count
    }

    /**
     * Stability gate for `idle` (see IDLE_STABILITY_MS doc). Returns the
     * status we should expose, mutates the per-tab armed flag, and (re)arms
     * the gate-release timer when we hold an idle back. Pure inputs ⇒ pure
     * outputs apart from the WeakMap mutations and the timer side-effect.
     *
     * State machine:
     *   raw=working          → armed=true,  expose 'working'
     *   raw=needs_permission → armed=false, expose 'needs_permission'
     *   raw=no_ai            → armed=false, expose 'no_ai'
     *   raw=idle, armed AND eventAt within window → expose 'working' (held),
     *                                                schedule re-tick at
     *                                                release moment.
     *   raw=idle, armed AND eventAt past window   → expose 'idle',
     *                                                armed=false (released).
     *   raw=idle, not armed                       → expose 'idle' (fresh
     *                                                session, post-perm, …).
     */
    private applyIdleGate (inner: BaseTabComponent, rawStatus: TabStatus, eventAt: number): TabStatus {
        if (rawStatus === TabStatus.Working) {
            this.idleGateArmed.set(inner, true)
            this.clearGateTimer(inner)
            return TabStatus.Working
        }
        if (rawStatus === TabStatus.NeedsPermission || rawStatus === TabStatus.NoAi) {
            this.idleGateArmed.delete(inner)
            this.clearGateTimer(inner)
            return rawStatus
        }
        // rawStatus === TabStatus.Idle (and per the TabStatus union, nothing
        // else reaches here — `Done` is render-derived in the sidebar, not
        // produced by hooks).
        if (!this.idleGateArmed.get(inner)) {
            return TabStatus.Idle
        }
        const idleAgeMs = Date.now() - eventAt
        if (idleAgeMs >= IDLE_STABILITY_MS) {
            this.idleGateArmed.delete(inner)
            this.clearGateTimer(inner)
            return TabStatus.Idle
        }
        // Hold idle as working. Schedule a single follow-up tick at the
        // release moment so the UI doesn't have to wait up to POLL_MS to
        // flip. Tick is idempotent: if a fresh hook event arrives first,
        // hooks.snapshots$ already triggers a tick — we just race ourselves.
        this.scheduleGateRelease(inner, IDLE_STABILITY_MS - idleAgeMs)
        return TabStatus.Working
    }

    private scheduleGateRelease (inner: BaseTabComponent, delayMs: number): void {
        this.clearGateTimer(inner)
        // 25 ms slack so eventAt arithmetic on the re-tick is past the
        // threshold rather than equal-to (idleAgeMs >= IDLE_STABILITY_MS).
        const t = setTimeout(() => {
            this.idleGateTimers.delete(inner)
            this.idleGateTimerHandles.delete(t)
            void this.tick()
        }, delayMs + 25)
        this.idleGateTimers.set(inner, t)
        this.idleGateTimerHandles.add(t)
    }

    /**
     * Slow-path interrupt probe. The fast path (EscInterruptService) catches
     * the user pressing ESC at the keyboard. This catches the residue: agent-
     * internal timeouts, `/clear`, pasted interrupts, anything that ends the
     * turn without firing a Stop / interrupted-PostToolUse hook. Tails the
     * transcript and looks for the markers `transcriptEndedAfter` knows
     * about. Throttled per-tab; only runs after a grace window so normal
     * Stop hook traffic gets first chance to settle the row.
     *
     * Fire-and-forget: the result lands as a `hooks.forceIdle()` call which
     * re-emits HookWatcher snapshots$ and kicks another tick, surfacing
     * Idle through the normal pipeline. We deliberately don't await — the
     * tick loop is the hot path and should stay sync-ish.
     */
    private maybeProbeTranscriptInterrupt (
        inner: BaseTabComponent,
        tabId: string | undefined,
        snap: HookSnapshot,
        status: TabStatus,
    ): void {
        if (status !== TabStatus.Working) return
        if (!tabId) return
        if (!snap.transcriptPath) return
        const now = Date.now()
        if (now - snap.eventAt <= TRANSCRIPT_INTERRUPT_GRACE_MS) return
        const lastProbe = this.lastTranscriptProbeAt.get(inner) ?? 0
        if (now - lastProbe < TRANSCRIPT_INTERRUPT_INTERVAL_MS) return
        this.lastTranscriptProbeAt.set(inner, now)
        const txPath = snap.transcriptPath
        const eventAt = snap.eventAt
        const tid = tabId
        void transcriptEndedAfter(txPath, eventAt).then(ended => {
            if (ended) this.hooks.forceIdle(tid, 'transcript-interrupted')
        }).catch(() => { /* transient FS errors are non-fatal */ })
    }

    private clearGateTimer (inner: BaseTabComponent): void {
        const existing = this.idleGateTimers.get(inner)
        if (existing) {
            clearTimeout(existing)
            this.idleGateTimers.delete(inner)
            this.idleGateTimerHandles.delete(existing)
        }
    }

    /**
     * Read GLANCETERM_TAB_ID from a live process env block. Tries each pid in
     * `candidatePids` order and returns the first hit. Cached per tab — env
     * blocks don't change after exec, so a single successful read is enough
     * for the lifetime of the pty.
     */
    private async readEnvTabId (inner: BaseTabComponent, candidatePids: number[]): Promise<string | undefined> {
        if (this.envTabIdCache.has(inner)) return this.envTabIdCache.get(inner)
        for (const pid of candidatePids) {
            const id = await readGlancetermTabIdFromPid(pid)
            if (id) {
                this.envTabIdCache.set(inner, id)
                return id
            }
        }
        return undefined
    }

    private placeholderState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): TabState {
        // Session died (no_ai) — drop any working-anchor so a future revival
        // starts a fresh turn timer instead of continuing the dead one.
        // Same reasoning for the bg-children tracker.
        this.workingSince.delete(t.inner)
        this.bgChildrenFirstSeen.delete(t.inner)
        this.bgConfirmedPids.delete(t.inner)
        const sess: { glancetermTabId?: string } | undefined =
            (t.inner as unknown as { session?: { glancetermTabId?: string } }).session
        return {
            outerTab: t.outer,
            innerTab: t.inner,
            tabId: sess?.glancetermTabId ?? null,
            title: t.outer.customTitle || t.outer.title || '(tab)',
            aiTool: null,
            aiPid: null,
            aiCommandLine: null,
            cwd: null,
            status: TabStatus.NoAi,
            lastActiveMs: null,
            awaitingFirstEvent: false,
            subagentCount: 0,
            backgroundJobCount: 0,
            monitorCount: 0,
            model: null,
            tokensIn: null,
            tokensOut: null,
        }
    }

    private collectTerminalTabs (): Array<{ outer: BaseTabComponent; inner: BaseTabComponent }> {
        const out: Array<{ outer: BaseTabComponent; inner: BaseTabComponent }> = []
        for (const outer of this.app.tabs) {
            if (isSplit(outer)) {
                const leaves = outer.getAllTabs()
                if (leaves.length === 0) continue
                for (const inner of leaves) {
                    if (isTerminalTab(inner)) out.push({ outer, inner })
                }
            } else if (isTerminalTab(outer)) {
                out.push({ outer, inner: outer })
            }
        }
        return out
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isSplit (t: any): t is { getAllTabs(): BaseTabComponent[] } {
    return t && typeof t.getAllTabs === 'function'
}

function isTerminalTab (t: any): boolean {
    return t && typeof t.setSession === 'function'
}

/**
 * Cross-platform "give me the real command lines for these pids" helper.
 * Tabby's getChildProcesses().command is unreliable for several AI CLIs
 * (notably `claude`, which returns the version string), so we re-read
 * via OS-native APIs and dispatch by platform.
 */
async function realCommandsFor (pids: number[]): Promise<Map<number, string>> {
    if (pids.length === 0) return new Map()
    return process.platform === 'win32'
        ? realCommandsForWindows(pids)
        : realCommandsForPosix(pids)
}

async function realCommandsForPosix (pids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    if (pids.length === 0) return out
    const psOut = await runProbe('ps', ['-p', pids.join(','), '-o', 'pid=,command='], 500)
    for (const line of psOut.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/)
        if (m) out.set(parseInt(m[1], 10), m[2].trim())
    }
    return out
}

/**
 * Windows: `ps` doesn't exist. Get-CimInstance Win32_Process is the modern,
 * reliable way to read full command lines. We pass the script via
 * `-EncodedCommand` (base64 UTF-16LE) to dodge cmd.exe quoting hell — the
 * pid list goes through verbatim and the JSON output round-trips cleanly.
 *
 * WQL has no `IN(…)` operator, so we client-side-filter with PowerShell's
 * `-contains`. Win32_Process enumeration is sub-second on typical machines
 * and we only fire one call per tab-monitor tick.
 *
 * Timeout is bumped vs POSIX (2 s vs 500 ms) — PowerShell cold-start adds
 * ~150–250 ms on top of the query itself.
 */
async function realCommandsForWindows (pids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    if (pids.length === 0) return out
    const script = [
        `$ids = @(${pids.join(',')})`,
        `Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2`,
    ].join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const psOut = await runProbe(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        2000,
    )

    // ConvertTo-Json emits a single object if there's one row, an array
    // otherwise. Normalise both shapes.
    const trimmed = psOut.trim()
    if (!trimmed) return out
    try {
        const parsed = JSON.parse(trimmed)
        const list: Array<{ ProcessId?: number; CommandLine?: string }> =
            Array.isArray(parsed) ? parsed : [parsed]
        for (const item of list) {
            if (typeof item.ProcessId === 'number' && typeof item.CommandLine === 'string') {
                out.set(item.ProcessId, item.CommandLine.trim())
            }
        }
    } catch { /* malformed JSON — degraded "no command info" mode is fine */ }
    return out
}

/**
 * Per-tick process-tree snapshot. Built once at the top of `tick()` and
 * passed through to every per-tab probe so the N tabs share one ppid map
 * instead of each running their own `ps -p` per ancestor step.
 *
 * `pidParent` is the bulk lookup. On macOS one `ps -A -o pid=,ppid=` call
 * returns every process's ppid in a single ~5–10 ms invocation; cheaper
 * than the pre-refactor 6 × N synchronous `ps -p` calls (10 tabs ⇒ 60
 * blocking shell-outs every 1.5 s). On Linux we read from `/proc`
 * directly with no exec needed.
 *
 * Windows: we don't pre-build, falling through to a per-call wmic in
 * `parentPidOfFromSnapshot`. Wmic is deprecated; a batched PowerShell
 * query would help, but Windows isn't where the perf reports come from.
 */
interface ProcessTreeSnapshot {
    pidParent: Map<number, number>
}

async function buildProcessTreeSnapshot (): Promise<ProcessTreeSnapshot> {
    const pidParent = new Map<number, number>()
    if (process.platform === 'darwin') {
        const out = await runProbe('ps', ['-A', '-o', 'pid=,ppid='], 800)
        for (const line of out.split('\n')) {
            const m = line.match(/^\s*(\d+)\s+(\d+)/)
            if (m) {
                const pid = parseInt(m[1], 10)
                const ppid = parseInt(m[2], 10)
                if (Number.isFinite(pid) && Number.isFinite(ppid)) {
                    pidParent.set(pid, ppid)
                }
            }
        }
    } else if (process.platform === 'linux') {
        // Read /proc via async fs.promises + Promise.all so a 500-pid host
        // doesn't serialize 500 blocking readFileSync into the renderer
        // thread — that would have re-created the very "blocks the
        // renderer" problem this refactor is supposed to fix.
        //
        // Wall-clock budget: 800ms matches the macOS `ps -A` runProbe
        // cap. We track via `Date.now()` rather than Promise.race because
        // bailing on the race still leaves the in-flight reads pending; the
        // budget short-circuit at the top of each file's async closure is
        // cheap enough to let already-launched reads finish to completion
        // without polluting the snapshot map. If /proc itself is wedged
        // (NFS overlay), the readdir() awaits forever — we'd want a hard
        // timeout there, but Node has no built-in. Acceptable: pathological
        // NFS overlays on /proc are vanishingly rare for a desktop app.
        const deadline = Date.now() + 800
        let entries: string[] = []
        try { entries = await fs.readdir('/proc') } catch { /* swallow */ }
        const pidDirs = entries.filter(e => /^\d+$/.test(e))
        await Promise.all(pidDirs.map(async e => {
            if (Date.now() > deadline) return
            try {
                const data = await fs.readFile(`/proc/${e}/stat`, 'utf8')
                const close = data.lastIndexOf(')')
                if (close < 0) return
                const rest = data.slice(close + 1).trim().split(/\s+/)
                const ppid = parseInt(rest[1], 10)
                if (Number.isFinite(ppid)) pidParent.set(parseInt(e, 10), ppid)
            } catch { /* skip on race / perm */ }
        }))
    }
    // Windows: leave pidParent empty; ancestorsOf falls through to the
    // Windows-only sync wmic per-pid lookup. The renderer-jank cost we
    // care about is dominated by the long-tabs macOS workflow.
    return { pidParent }
}

/**
 * Walk up the ppid chain from `pid`, returning at most `maxDepth` ancestors
 * (closest-first). Stops at pid 1 / 0 / failure. Pure: takes the
 * pre-built snapshot.
 *
 * Used by tab detection to find AI tools that sit above the pty's
 * foreground process — e.g. truePID = caffeinate, ppid = claude, ppid =
 * zsh. We want to inspect claude even though it isn't the foreground
 * leader at this moment.
 */
function ancestorsOf (pid: number, snapshot: ProcessTreeSnapshot, maxDepth: number): number[] {
    const out: number[] = []
    let cur = pid
    for (let i = 0; i < maxDepth; i++) {
        let parent: number | null = snapshot.pidParent.get(cur) ?? null
        // Snapshot miss fallback — snapshot didn't cover this pid (race
        // where the process spawned between snapshot build and walk, or
        // worst case the snapshot itself timed out and is empty). Fall
        // back to a per-step sync probe so the ancestor walk degrades
        // gracefully instead of silently returning [] and missing the
        // "truePID = caffeinate, ppid = claude" detection path on every
        // tab for the whole tick. Pre-refactor every step was a sync
        // probe, so this is at worst the old behavior; in the common case
        // (snapshot succeeded) we never enter this branch.
        if (parent === null) {
            parent = parentPidOfSync(cur)
        }
        if (!parent || parent <= 1 || parent === cur) break
        out.push(parent)
        cur = parent
    }
    return out
}

/**
 * Cross-platform "list immediate children of this pid". Returns an empty
 * array on any failure (process exited, ps not available, permission
 * denied) — callers treat that as "no bg jobs", which is the safe default.
 *
 * macOS / Linux: `pgrep -P <pid>`.
 * Windows: wmic ParentProcessId filter (deprecated in modern Windows but
 *   still present in 10/11; if missing, catch returns empty and the
 *   bg-count badge just stays at 0).
 */
async function childrenOf (pid: number): Promise<number[]> {
    if (process.platform === 'win32') {
        const out = await runProbe(
            'wmic',
            ['process', 'where', `ParentProcessId=${pid}`, 'get', 'ProcessId', '/format:value'],
            1_500,
        )
        const pids: number[] = []
        for (const m of out.matchAll(/ProcessId=(\d+)/g)) {
            const n = parseInt(m[1], 10)
            if (Number.isFinite(n) && n > 0) pids.push(n)
        }
        return pids
    }
    const out = await runProbe('pgrep', ['-P', String(pid)], 300)
    return out.trim().split(/\s+/)
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n) && n > 0)
}

/**
 * Per-step parent lookup, sync. Called from `ancestorsOf` ONLY when the
 * per-tick snapshot doesn't cover the requested pid — either the snapshot
 * itself timed out / failed, or this pid was spawned between snapshot
 * build and walk. Three platform-specific paths:
 *
 *   Linux: single `/proc/<pid>/stat` read. Sub-millisecond. Same shape as
 *     the snapshot builder, just for one pid.
 *   macOS: `ps -p <pid> -o ppid=`. ~5ms cold. Matches the pre-refactor
 *     `parentPidOf` exactly so the graceful-degradation path keeps the
 *     old "60 ps calls per tick" cost — not great, but no worse than
 *     pre-refactor for the rare-but-real "snapshot failed" case.
 *   Windows: `wmic process where ProcessId=<pid>`. ~50ms+ but wmic is
 *     the only convenient path; PowerShell cold start is worse.
 *
 * Returns null on any failure so the caller's `parent === null` exits the
 * walk loop cleanly. execFileSync (not execSync) keeps the no-shell-
 * interp safety: pid is internal-controlled, but defense in depth.
 */
function parentPidOfSync (pid: number): number | null {
    if (process.platform === 'linux') {
        try {
            const data = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8')
            const close = data.lastIndexOf(')')
            if (close < 0) return null
            const rest = data.slice(close + 1).trim().split(/\s+/)
            const ppid = parseInt(rest[1], 10)
            return Number.isFinite(ppid) ? ppid : null
        } catch { return null }
    }
    if (process.platform === 'darwin') {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { execFileSync } = require('child_process') as typeof import('child_process')
            const out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], {
                encoding: 'utf8', timeout: 300,
            })
            const ppid = parseInt(out.trim(), 10)
            return Number.isFinite(ppid) ? ppid : null
        } catch { return null }
    }
    if (process.platform === 'win32') {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { execFileSync } = require('child_process') as typeof import('child_process')
            const out = execFileSync('wmic', [
                'process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/format:value',
            ], { encoding: 'utf8', timeout: 1500, windowsHide: true })
            const m = out.match(/ParentProcessId=(\d+)/)
            return m ? parseInt(m[1], 10) : null
        } catch { return null }
    }
    return null
}

/**
 * Cross-platform "read GLANCETERM_TAB_ID from this pid's env block."
 * Returns null when:
 *   - the platform reader isn't implemented (Windows fallback today),
 *   - the process exited / we lack permission to read its env,
 *   - the env var isn't set (a non-Tabby-spawned process).
 *
 * Callers must treat null as "fall back to sess.glancetermTabId" rather
 * than as a hard failure.
 */
async function readGlancetermTabIdFromPid (pid: number): Promise<string | null> {
    if (process.platform === 'linux') {
        try {
            const buf = fsSync.readFileSync(`/proc/${pid}/environ`)
            for (const entry of buf.toString('utf8').split('\0')) {
                if (entry.startsWith('GLANCETERM_TAB_ID=')) {
                    return entry.slice('GLANCETERM_TAB_ID='.length)
                }
            }
        } catch { /* swallow */ }
        return null
    }
    if (process.platform === 'darwin') {
        // `ps eww -p <pid> -o command=` prints argv followed by KEY=VAL pairs
        // separated by single spaces. We can't disambiguate spaces in argv
        // from the env-pair separator, but GLANCETERM_TAB_ID values are
        // UUIDv4 — fixed shape — so a focused regex is enough.
        const out = await runProbe('ps', ['eww', '-p', String(pid), '-o', 'command='], 500)
        const m = out.match(/\bGLANCETERM_TAB_ID=([0-9a-fA-F-]{36})\b/)
        return m ? m[1] : null
    }
    // Windows: reading another process's env block requires NtQueryInformation
    // -Process gymnastics that aren't worth the bundle weight. We fall back
    // to sess.glancetermTabId here; the mismatch only surfaces on
    // session-restore which is rarer on Windows (no native session restore).
    return null
}

export async function codexTranscriptCompletedAfter (transcriptPath: string, eventAt: number): Promise<boolean> {
    return transcriptEndedAfter(transcriptPath, eventAt)
}

export async function transcriptEndedAfter (transcriptPath: string, eventAt: number): Promise<boolean> {
    let stat: fsSync.Stats
    try {
        stat = await fs.stat(transcriptPath)
    } catch {
        return false
    }
    const maxBytes = 128 * 1024
    const start = Math.max(0, stat.size - maxBytes)
    let buf: Buffer
    try {
        const fd = await fs.open(transcriptPath, 'r')
        try {
            buf = Buffer.alloc(stat.size - start)
            await fd.read(buf, 0, buf.length, start)
        } finally {
            await fd.close()
        }
    } catch {
        return false
    }

    const terminalPayloads = new Set(['task_complete', 'turn_aborted', 'task_aborted'])
    for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (
            !line.includes('"task_complete"')
            && !line.includes('"turn_aborted"')
            && !line.includes('"task_aborted"')
            && !line.includes('"interrupted":true')
            && !line.includes('[Request interrupted by user')
        ) continue
        try {
            const parsed = JSON.parse(line)
            let endedAt: number
            if (parsed?.type === 'event_msg' && terminalPayloads.has(parsed?.payload?.type)) {
                endedAt = typeof parsed.payload.completed_at === 'number'
                    ? parsed.payload.completed_at * 1000
                    : typeof parsed.payload.aborted_at === 'number'
                        ? parsed.payload.aborted_at * 1000
                    : Date.parse(parsed.timestamp ?? '')
            } else if (parsed?.toolUseResult?.interrupted === true) {
                endedAt = Date.parse(parsed.timestamp ?? '')
            } else if (isClaudeInterruptedUserRecord(parsed)) {
                endedAt = Date.parse(parsed.timestamp ?? '')
            } else {
                continue
            }
            return Number.isFinite(endedAt) && endedAt >= eventAt
        } catch {
            continue
        }
    }
    return false
}

function isClaudeInterruptedUserRecord (parsed: any): boolean {
    if (parsed?.type !== 'user' || parsed?.message?.role !== 'user') return false
    const content = parsed.message.content
    if (typeof content === 'string') {
        return content.startsWith('[Request interrupted by user')
    }
    if (!Array.isArray(content)) return false
    return content.some((part: any) => (
        part?.type === 'text'
        && typeof part.text === 'string'
        && part.text.startsWith('[Request interrupted by user')
    ))
}
