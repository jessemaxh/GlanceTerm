import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { execSync } from 'child_process'
import * as fsSync from 'fs'

import { AppService, BaseTabComponent } from 'tabby-core'

import { HookAdapterRegistry } from './hook-adapters/registry'
import { HookWatcherService } from './hook-watcher.service'
import { HookInstallerService } from './hook-installer.service'

/** Poll cadence for process-tree scans. Hooks deliver state pushes; the poll
 * is only here to discover when an AI tool starts/stops in a tab. */
const POLL_MS = 1500

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
 * `done` is render-derived, never emitted by hooks or this monitor. The sidebar
 * (and jumper) treat `idle` as `done` while UnreadService.isUnread() is true
 * for the tab — i.e. the agent finished a turn and the user hasn't focused the
 * tab since. The transition done → idle ("ready") happens automatically when
 * UnreadService clears the entry on focus. Keeping it in the union lets all
 * UI-facing consumers share one TabStatus type without a separate DisplayStatus.
 */
export type TabStatus = 'working' | 'done' | 'idle' | 'needs_permission' | 'no_ai'

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
    | 'aider'
    | 'goose'

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
    {
        tool: 'aider',
        regexes: [
            /\baider(\s|$)/,
            /python[\d.]*\s+(?:-m\s+aider|.+\/aider\/(?:__main__|main)\.py)/,
        ],
    },
    {
        tool: 'goose',
        regexes: [
            /\bgoose(\s|$)/,
        ],
    },
]

export interface TabState {
    /** Outer tab in app.tabs[]. Pass to AppService.selectTab() to focus. */
    outerTab: BaseTabComponent
    /** Inner tab (= outerTab unless it's inside a split). */
    innerTab: BaseTabComponent
    /** What the user sees in the top tab bar — used as our row label. */
    title: string
    /** The descendant AI process pid, if there is one. */
    aiPid: number | null
    /** Which AI tool we detected running, if any. */
    aiTool: AiTool | null
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
     * from". Sidebar renders `· N bg` after the status when > 0. Agent-
     * agnostic: any AI tool that spawns a subprocess that survives across
     * polls bumps this count, no per-agent code required. See BG_PERSIST_MS
     * for the persistence threshold and the over- vs under-count tradeoff.
     */
    backgroundJobCount: number
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
 * = true. Tools without adapters (aider, opencode, goose) show as `working`
 * for as long as the process is alive — degraded but visible. Their
 * granular state will arrive when those adapters land.
 */
@Injectable({ providedIn: 'root' })
export class TabMonitor implements OnDestroy {
    private subject = new BehaviorSubject<TabState[]>([])
    private timer?: NodeJS.Timeout
    private busy = false
    /** Cache so we don't re-stat per tick when nothing has changed. */
    private shellPidCache = new WeakMap<BaseTabComponent, number>()
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
    ) {
        void this.tick()
        this.timer = setInterval(() => { void this.tick() }, POLL_MS)
        // A fresh hook event should refresh the UI within the next render
        // cycle even if no poll has fired since — re-emit our last states.
        this.hooks.snapshots$.subscribe(() => { void this.tick() })
    }

    ngOnDestroy (): void {
        if (this.timer) clearInterval(this.timer)
    }

    private async tick (): Promise<void> {
        if (this.busy) return
        this.busy = true
        try {
            const tabs = this.collectTerminalTabs()
            const out: TabState[] = []
            const CHUNK = 8
            for (let i = 0; i < tabs.length; i += CHUNK) {
                const chunk = tabs.slice(i, i + CHUNK)
                const results = await Promise.all(chunk.map(t => this.safeMakeState(t)))
                for (const r of results) if (r) out.push(r)
            }
            this.subject.next(out)
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] tick failed:', e)
        } finally {
            this.busy = false
        }
    }

    private async safeMakeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): Promise<TabState | null> {
        try {
            return await this.makeState(t)
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] makeState failed for tab:', t.outer?.title, e)
            return null
        }
    }

    private async makeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
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
            for (const a of ancestorsOf(truePid, 6)) pushCand(a)
        }
        for (const c of children) pushCand(c.pid)

        const realCmds = realCommandsFor(candidates.map(c => c.pid))

        let aiTool: AiTool | null = null
        let aiPid: number | null = null
        for (const c of candidates) {
            const real = realCmds.get(c.pid) ?? c.command
            if (!real) continue
            const match = AI_PATTERNS.find(p => p.regexes.some(r => r.test(real)))
            if (match) { aiTool = match.tool; aiPid = c.pid; break }
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

        if (!aiTool) {
            status = 'no_ai'
        } else if (!this.registry.supports(aiTool)) {
            // Tool we recognise via ps but don't have a hook adapter for yet —
            // degraded "we know it's alive, can't tell working vs idle" state.
            status = 'working'
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
            if (truePid) for (const a of ancestorsOf(truePid, 6)) push(a)
            const envId = this.readEnvTabId(t.inner, envCandidates)
            tabId = envId ?? sess.glancetermTabId
            const snap = tabId ? this.hooks.getStatus(tabId) : null
            if (snap) {
                // Subagent in-flight override: when the main agent has
                // spawned a backgrounded Task subagent, the main agent's
                // response ends → Stop → raw status = idle. The subagent
                // is still chewing tokens though, so we surface it as
                // working until the matching SubagentStop arrives and
                // drops the counter back to 0. See HookWatcher's
                // `subagentInFlight` doc for the counter contract.
                let rawStatus = snap.status
                if (rawStatus === 'idle' && tabId && this.hooks.getSubagentInFlight(tabId) > 0) {
                    rawStatus = 'working'
                }
                status = this.applyIdleGate(t.inner, rawStatus, snap.eventAt)
                lastActiveMs = Math.max(0, Date.now() - snap.eventAt)
            } else {
                // Adapter exists and tool is running but no hook event in our
                // state dir yet. Either (a) hook just got installed and Claude
                // hasn't restarted, (b) session predates GLANCETERM_TAB_ID
                // injection, or (c) we somehow lost the file. Show "idle" so
                // the row reads as "present but not actively working" and
                // mark awaitingFirstEvent so UI can hint that to the user.
                status = 'idle'
                awaitingFirstEvent = true
            }
        }

        // Override lastActiveMs for working tabs to show turn-duration (since
        // entering effective=working) instead of "ms since last hook event".
        // See workingSince doc for rationale. Runs AFTER applyIdleGate so a
        // brief raw-idle inside the gate window doesn't reset the anchor.
        if (status === 'working') {
            let since = this.workingSince.get(t.inner)
            if (since === undefined) {
                since = Date.now()
                this.workingSince.set(t.inner, since)
            }
            lastActiveMs = Date.now() - since
        } else {
            this.workingSince.delete(t.inner)
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
            backgroundJobCount = this.updateBackgroundJobCount(t.inner, aiPid, tabId)
        } else {
            this.bgChildrenFirstSeen.delete(t.inner)
            this.bgConfirmedPids.delete(t.inner)
        }

        return {
            outerTab: t.outer,
            innerTab: t.inner,
            title: t.outer.customTitle || t.outer.title || `(tab ${this.shellPidCache.get(t.inner) ?? '?'})`,
            aiTool,
            aiPid,
            cwd,
            status,
            lastActiveMs,
            awaitingFirstEvent,
            // Side-channel read from HookWatcher — default to 0 when we
            // couldn't resolve a tabId (no env var captured yet, no hook
            // event yet, etc.), matching placeholderState.
            subagentCount: tabId ? this.hooks.getSubagentInFlight(tabId) : 0,
            backgroundJobCount,
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
    private updateBackgroundJobCount (
        inner: BaseTabComponent,
        aiPid: number,
        tabId: string | undefined,
    ): number {
        const now = Date.now()
        const live = new Set(childrenOf(aiPid))

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

        // Final count: confirmed pids are counted immediately; heuristic
        // pids only after they've persisted past the threshold.
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
        if (rawStatus === 'working') {
            this.idleGateArmed.set(inner, true)
            this.clearGateTimer(inner)
            return 'working'
        }
        if (rawStatus === 'needs_permission' || rawStatus === 'no_ai') {
            this.idleGateArmed.delete(inner)
            this.clearGateTimer(inner)
            return rawStatus
        }
        // rawStatus === 'idle' (and per the TabStatus union, nothing else
        // reaches here — `done` is render-derived in the sidebar, not
        // produced by hooks).
        if (!this.idleGateArmed.get(inner)) {
            return 'idle'
        }
        const idleAgeMs = Date.now() - eventAt
        if (idleAgeMs >= IDLE_STABILITY_MS) {
            this.idleGateArmed.delete(inner)
            this.clearGateTimer(inner)
            return 'idle'
        }
        // Hold idle as working. Schedule a single follow-up tick at the
        // release moment so the UI doesn't have to wait up to POLL_MS to
        // flip. Tick is idempotent: if a fresh hook event arrives first,
        // hooks.snapshots$ already triggers a tick — we just race ourselves.
        this.scheduleGateRelease(inner, IDLE_STABILITY_MS - idleAgeMs)
        return 'working'
    }

    private scheduleGateRelease (inner: BaseTabComponent, delayMs: number): void {
        this.clearGateTimer(inner)
        // 25 ms slack so eventAt arithmetic on the re-tick is past the
        // threshold rather than equal-to (idleAgeMs >= IDLE_STABILITY_MS).
        const t = setTimeout(() => {
            this.idleGateTimers.delete(inner)
            void this.tick()
        }, delayMs + 25)
        this.idleGateTimers.set(inner, t)
    }

    private clearGateTimer (inner: BaseTabComponent): void {
        const existing = this.idleGateTimers.get(inner)
        if (existing) {
            clearTimeout(existing)
            this.idleGateTimers.delete(inner)
        }
    }

    /**
     * Read GLANCETERM_TAB_ID from a live process env block. Tries each pid in
     * `candidatePids` order and returns the first hit. Cached per tab — env
     * blocks don't change after exec, so a single successful read is enough
     * for the lifetime of the pty.
     */
    private readEnvTabId (inner: BaseTabComponent, candidatePids: number[]): string | undefined {
        if (this.envTabIdCache.has(inner)) return this.envTabIdCache.get(inner)
        for (const pid of candidatePids) {
            const id = readGlancetermTabIdFromPid(pid)
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
        return {
            outerTab: t.outer,
            innerTab: t.inner,
            title: t.outer.customTitle || t.outer.title || '(tab)',
            aiTool: null,
            aiPid: null,
            cwd: null,
            status: 'no_ai',
            lastActiveMs: null,
            awaitingFirstEvent: false,
            subagentCount: 0,
            backgroundJobCount: 0,
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
function realCommandsFor (pids: number[]): Map<number, string> {
    if (pids.length === 0) return new Map()
    return process.platform === 'win32'
        ? realCommandsForWindows(pids)
        : realCommandsForPosix(pids)
}

function realCommandsForPosix (pids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    try {
        const psOut = execSync(`ps -p ${pids.join(',')} -o pid=,command=`, {
            encoding: 'utf8',
            timeout: 500,
        })
        for (const line of psOut.split('\n')) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/)
            if (m) out.set(parseInt(m[1], 10), m[2].trim())
        }
    } catch { /* swallow */ }
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
function realCommandsForWindows (pids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    try {
        const script = [
            `$ids = @(${pids.join(',')})`,
            `Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2`,
        ].join('; ')
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        const psOut = execSync(
            `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
            { encoding: 'utf8', timeout: 2000, windowsHide: true },
        )

        // ConvertTo-Json emits a single object if there's one row, an array
        // otherwise. Normalise both shapes.
        const trimmed = psOut.trim()
        if (!trimmed) return out
        const parsed = JSON.parse(trimmed)
        const list: Array<{ ProcessId?: number; CommandLine?: string }> =
            Array.isArray(parsed) ? parsed : [parsed]
        for (const item of list) {
            if (typeof item.ProcessId === 'number' && typeof item.CommandLine === 'string') {
                out.set(item.ProcessId, item.CommandLine.trim())
            }
        }
    } catch { /* swallow — degraded "no command info" mode is fine */ }
    return out
}

/**
 * Walk up the ppid chain from `pid`, returning at most `maxDepth` ancestors
 * (closest-first). Stops at pid 1 / 0 / failure. Cross-platform.
 *
 * Used by tab detection to find AI tools that sit above the pty's
 * foreground process — e.g. truePID = caffeinate, ppid = claude, ppid =
 * zsh. We want to inspect claude even though it isn't the foreground
 * leader at this moment.
 */
function ancestorsOf (pid: number, maxDepth: number): number[] {
    const out: number[] = []
    let cur = pid
    for (let i = 0; i < maxDepth; i++) {
        const parent = parentPidOf(cur)
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
 * macOS / Linux: `pgrep -P <pid>` matches by parent pid. pgrep is shipped
 *   with both BSD utils (macOS) and procps-ng (Linux). Exit code 1 when
 *   nothing matches; execSync throws on non-zero, which we swallow.
 * Windows: wmic ParentProcessId filter. wmic is deprecated in modern
 *   Windows but still present in 10/11; if it's missing the catch returns
 *   empty and the bg-count badge just stays at 0.
 */
function childrenOf (pid: number): number[] {
    if (process.platform === 'win32') {
        try {
            const out = execSync(
                `wmic process where ParentProcessId=${pid} get ProcessId /format:value`,
                { encoding: 'utf8', timeout: 1_500, windowsHide: true },
            )
            const pids: number[] = []
            for (const m of out.matchAll(/ProcessId=(\d+)/g)) {
                const n = parseInt(m[1], 10)
                if (Number.isFinite(n) && n > 0) pids.push(n)
            }
            return pids
        } catch { return [] }
    }
    try {
        const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8', timeout: 300 })
        return out.trim().split(/\s+/)
            .map(s => parseInt(s, 10))
            .filter(n => Number.isFinite(n) && n > 0)
    } catch { return [] }
}

function parentPidOf (pid: number): number | null {
    if (process.platform === 'linux') {
        try {
            const data = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8')
            // /proc/<pid>/stat: pid (comm) state ppid …
            // `comm` may contain whitespace/parens, so anchor on the LAST ')'.
            const close = data.lastIndexOf(')')
            if (close < 0) return null
            const rest = data.slice(close + 1).trim().split(/\s+/)
            // After ')' the fields are: state, ppid, …
            const ppid = parseInt(rest[1], 10)
            return Number.isFinite(ppid) ? ppid : null
        } catch { return null }
    }
    if (process.platform === 'darwin') {
        try {
            const out = execSync(`ps -p ${pid} -o ppid=`, { encoding: 'utf8', timeout: 300 })
            const ppid = parseInt(out.trim(), 10)
            return Number.isFinite(ppid) ? ppid : null
        } catch { return null }
    }
    if (process.platform === 'win32') {
        // Single-shot wmic is fast enough for the 6-deep walk; we accept
        // the per-call cost vs setting up a batched PowerShell query that
        // would only pay off for very deep trees.
        try {
            const out = execSync(`wmic process where ProcessId=${pid} get ParentProcessId /format:value`, {
                encoding: 'utf8', timeout: 1500, windowsHide: true,
            })
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
function readGlancetermTabIdFromPid (pid: number): string | null {
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
        try {
            const out = execSync(`ps eww -p ${pid} -o command=`, {
                encoding: 'utf8',
                timeout: 500,
            })
            const m = out.match(/\bGLANCETERM_TAB_ID=([0-9a-fA-F-]{36})\b/)
            return m ? m[1] : null
        } catch { /* swallow */ }
        return null
    }
    // Windows: reading another process's env block requires NtQueryInformation
    // -Process gymnastics that aren't worth the bundle weight. We fall back
    // to sess.glancetermTabId here; the mismatch only surfaces on
    // session-restore which is rarer on Windows (no native session restore).
    return null
}
