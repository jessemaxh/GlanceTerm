import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { AppService, ConfigService, BaseTabComponent } from 'tabby-core'

import { TabMonitor, TabState, AiTool } from './tab-monitor'

/**
 * "When I restart GlanceTerm, the tab comes back but my Claude session is
 *  gone — re-run it for me, with the same flags I had."
 *
 * Three-phase loop driven by TabMonitor.states$:
 *
 *   1. CAPTURE — every tick, for each tab with (aiTool, cwd, aiCommandLine)
 *      all known, distil the raw `ps` command line into a re-runnable
 *      invocation (via toRunnableCommand) and persist it as
 *      `ai.autoResumeCommandByCwd[cwd] = { command, count }` where
 *      `count` is the number of distinct outer tabs CURRENTLY observed
 *      running this tool at this cwd this session. Cwd is the only
 *      identifier stable across an app restart — PTYs die,
 *      GLANCETERM_TAB_ID regenerates, tab indices shuffle. The count
 *      lets us tell "3 tabs in /repo each had claude" apart from
 *      "1 tab in /repo had claude, the other 2 were bare shells" —
 *      pre-fix the second case still triggered claude in all 3
 *      restored tabs because the map was just `cwd → command`.
 *
 *   2. CLEANUP — same tab subsequently transitioning had-agent →
 *      no-agent (user typed exit / quit / Ctrl-D out of the agent)
 *      drops THIS tab from the cwd's in-memory set. When the set
 *      empties the persisted entry is deleted; otherwise it's
 *      re-persisted with the lower count. That's the user signalling
 *      "next time, don't auto-launch here for THIS tab" without
 *      losing the other tabs' entitlement. If the user just quits
 *      the whole app without exiting the agent first, the entries
 *      sit in config and trigger the replay path next launch.
 *
 *   3. REPLAY — for any TabState whose outerTab was tagged as "restored
 *      from disk" (present at construction OR opened via tabOpened$
 *      within RESTORED_CAPTURE_MS of startup) AND that has been
 *      focused at least once this service lifetime, the first tick we
 *      see with (cwd ∈ map, !aiTool) is the moment the lazy-initialized
 *      shell finally came alive. We sendInput(`${command}\r`) into the
 *      tab after RESUME_DELAY_MS so the restored shell has time to
 *      render its prompt. Each outerTab is resumed at most once per
 *      service lifetime — the WeakSet guard prevents re-firing if the
 *      agent quits and we then see (cwd ∈ map, !aiTool) again.
 *
 *      Per-cwd quota: when multiple restored tabs share a cwd, only
 *      the first N (where N = persisted count) get the replay. Quota
 *      decrements on each successful schedule; further tabs at that
 *      cwd are marked attempted and skipped. Without this, 3 restored
 *      tabs sharing a cwd whose persisted entry was 1 agent would all
 *      have claude typed into them.
 *
 *      Why focus-gated AND tab-eligibility-gated:
 *      Tabby lazy-initializes terminal sessions (terminalTab.component
 *      .ts onFrontendReady → initializeSession, gated on
 *      frontend.attach which only runs on first focus). In practice
 *      cwd usually becomes known only after the user clicks the tab,
 *      but a few paths (the originally-active tab being auto-focused
 *      on restore, an eagerly-warmed pty in dev mode) can surface
 *      cwd without a user-visible focus moment. We additionally gate
 *      on `app.activeTabChange$` having fired for this outer tab.
 *
 *      Startup warm-up (the "restore all my agents on launch" path):
 *      User expectation is that every recovered tab gets its agent
 *      back at startup, not just the originally-active one. To
 *      satisfy that without waiting for clicks, the constructor
 *      synthesises a focus+blur pair on each non-active restored tab
 *      after WARMUP_DELAY_MS — `emitFocused()` triggers the lazy
 *      `frontend.attach` subscription (session starts → cwd lands),
 *      `emitBlurred()` immediately reverts `hasFocus` so the user's
 *      visible focus state and split-tab hotkey routing are
 *      unchanged. The focus gate is left in place as a defense for
 *      non-restored tabs but is satisfied automatically for restored
 *      ones via the warm-up.
 *
 * Master toggle: `ai.autoResumeAgents` (default true). When off, no
 * capture, no replay, no cleanup — config is untouched.
 *
 * Why we persist the COMMAND and not just the tool name:
 *
 *   v1 of this feature persisted just `cwd → 'claude'` and replayed
 *   bare `claude`, losing flags the user originally typed
 *   (`claude --resume`, `codex --model gpt-5`). Capturing the cmdline
 *   that TabMonitor already runs through `ps` is essentially free, and
 *   toRunnableCommand handles the awkward node-launched case
 *   (`node /Users/me/.../@anthropic-ai/claude-code/cli.js --resume foo`
 *   → `claude --resume foo`).
 *
 * Persisted shape — backward-compatible:
 *
 *   New writes always use the `{ command, count }` object shape.
 *   Reads accept either a string (legacy — interpreted as
 *   `{ command, count: 1 }`) or the object. After one CAPTURE pass
 *   the format upgrades in place. See `parsePersistedEntry`.
 *
 * Known limitations:
 *
 *   - Args with spaces or special chars (e.g. `--prompt "hello world"`)
 *     get re-quoted as plain space-separated tokens because we lose the
 *     quoting after argv-joining in `ps`. AI CLIs rarely take such
 *     args; if a user hits this, the worst case is the replayed
 *     command parses the args differently than intended and the user
 *     re-types it once.
 *   - "Restored tab" is tagged at tabOpened$ time within a 30 s
 *     window of service construction. A user who hand-opens a tab
 *     INSIDE that window (rare — boot is busy) would also be tagged
 *     and get an auto-launch if their cwd happens to match a pinned
 *     entry. Outside the window, user-opened tabs are correctly
 *     ineligible regardless of cwd.
 *   - Per-tab identity isn't persisted, so "3 tabs at cwd C, of which
 *     2 had agents" can't tell us WHICH 2 should be resumed on
 *     restart — whichever 2 of the 3 the user focuses first get
 *     them. Acceptable: Tabby exposes no stable per-tab token across
 *     restarts, and at the cwd granularity this matches user intent
 *     (they typed claude IN /repo, restart restores claude IN /repo).
 *   - If the user is actively typing in the just-restored tab in the
 *     2-second delay window, our `claude\r` appends to their input.
 *     Narrow race; flagging for v1.1 fix if anyone notices.
 */
@Injectable()
export class AutoResumeService implements OnDestroy {
    /** Window during which a tabOpened$ emission counts as "this was a
     *  session-restore tab, not a tab the user just opened". The restore
     *  path (AppService.recoverTabs → openNewTabRaw → tabOpened.next) walks
     *  every recovered tab on boot; anything that fires inside this window
     *  is tagged as restored and stays eligible for auto-resume regardless
     *  of how long the user takes to focus it. After this window, new tabs
     *  the user opens manually are NOT eligible — auto-resuming a hand-
     *  opened tab whose cwd happens to match a persisted entry would be a
     *  surprise. */
    private static readonly RESTORED_CAPTURE_MS = 30_000
    /** Delay between detecting a restorable tab and actually typing the
     *  launch command, so the shell has time to render its prompt and the
     *  echoed command doesn't appear before the `$ `. */
    private static readonly RESUME_DELAY_MS = 2_000
    /** Delay before firing the startup warm-up `emitFocused()` on each
     *  non-active restored tab. Needs to be long enough that each tab's
     *  `ngOnInit` has fired (and queued the lazy `frontend.attach`
     *  subscription on `focused$.pipe(first())`) — otherwise the focus
     *  event we emit lands before there's any subscriber to handle it
     *  and the session never inits. 250 ms is conservative for Angular
     *  CD + the inner `setImmediate` chain to settle; the user only sees
     *  it as part of normal app-startup latency. */
    private static readonly WARMUP_DELAY_MS = 250

    private readonly startupTs = Date.now()
    /** Outer tabs we've already auto-resumed this service lifetime. WeakSet
     *  so closed tabs drop out automatically. */
    private readonly attempted = new WeakSet<BaseTabComponent>()
    /** Outer tabs Tabby recovered from disk this launch. We tag a tab as
     *  "restored" if it was already in app.tabs at construction OR opens
     *  via tabOpened$ within the RESTORED_CAPTURE_MS startup window. A
     *  restored tab stays eligible for auto-resume for the lifetime of the
     *  service — important because Tabby lazy-initializes terminal
     *  sessions: a non-focused recovered tab has NO live shell (and
     *  therefore no cwd) until the user clicks it, which can be many
     *  minutes after boot. Pre-fix we keyed eligibility off a wall-clock
     *  window from service start and missed every non-focused restored tab. */
    private readonly restoredOuterTabs = new WeakSet<BaseTabComponent>()
    /** Outer tabs that have been the active tab at least once since this
     *  service started. Drives the focus gate on the REPLAY path: a
     *  restored tab whose cwd lands BEFORE the user actually looks at it
     *  (originally-active auto-focus on restore, eager pty warm-up in
     *  dev mode, …) sits idle until `app.activeTabChange$` fires for it.
     *  Seeded with `app.activeTab` at construction so the
     *  originally-active restored tab is still eligible immediately —
     *  Tabby's recoverTabs() flow has already called selectTab() on it
     *  before this service is even instantiated, so that one focus event
     *  predates our subscription. */
    private readonly focusedOuterTabs = new WeakSet<BaseTabComponent>()
    /** Per-tab "we observed an agent running here at some point during
     *  this service's lifetime" — gate for the cleanup path. Without it,
     *  the freshly-restored bare shell (no agent yet) would itself look
     *  like "user just quit the agent" and we'd wipe the entry before
     *  the replay timer fired. */
    private readonly hadAgentThisSession = new WeakMap<BaseTabComponent, AiTool>()
    /** Per outer tab, the cwd at which we last observed an agent running.
     *  Drives the cwd-rebalance step inside CAPTURE: when a tab `cd`s
     *  while an agent is alive, we need to remove the tab from the old
     *  cwd's tracking set before adding it to the new one — otherwise
     *  the old cwd keeps a stale count and would resume one agent too
     *  many on next launch. */
    private readonly lastAgentCwdByTab = new WeakMap<BaseTabComponent, string>()
    /** Per-cwd in-memory identity tracker: which outer tabs are
     *  CURRENTLY observed running an agent at this cwd. Used together
     *  with `cwdAgentCount` — the WeakSet answers "is THIS tab already
     *  counted under THIS cwd?" without holding strong refs that would
     *  leak closed tabs, while the parallel counter holds the size we
     *  can persist (WeakSet has no .size). The two are mutated together
     *  in addToCwdAgentSet / removeFromCwdAgentSet so they stay in sync. */
    private readonly cwdAgentTabs = new Map<string, WeakSet<BaseTabComponent>>()
    /** Live count of distinct outer tabs running an agent per cwd. The
     *  number we persist to `autoResumeCommandByCwd[cwd].count`. Counter
     *  is incremented/decremented only by explicit CAPTURE-add / CLEANUP-
     *  remove transitions — closing a tab without quitting the agent
     *  first does NOT decrement (matching the pre-fix semantic that "the
     *  agent is still 'there' from the user's perspective at restart"),
     *  so closed tabs that held strong refs would leak. The WeakSet
     *  half of the tracker side-steps the leak without losing the count. */
    private readonly cwdAgentCount = new Map<string, number>()
    /** Per-cwd "how many auto-resumes have we still got left for tabs at
     *  this cwd this lifetime". Initialised lazily on first REPLAY
     *  consideration from the persisted entry's count, decremented on
     *  each successful schedule. Once 0, further restored tabs at the
     *  same cwd are marked attempted and skipped — that's how 3 tabs
     *  sharing /repo with only 1 having had an agent stop the other two
     *  from getting a surprise `claude\r` typed in. */
    private readonly replayQuotaRemaining = new Map<string, number>()
    /** Pending replay timers, keyed by outer tab so we can cancel cleanly
     *  on tab close. */
    private readonly pendingTimers = new WeakMap<BaseTabComponent, ReturnType<typeof setTimeout>>()
    /** Per-tab "we already warned about an unsafe-looking cmdline here this
     *  service lifetime" — prevents the shell-safety reject path from
     *  re-logging on every poll for the same offending process. */
    private readonly warnedUnsafeCapture = new WeakSet<BaseTabComponent>()
    /** Outer tabs we've already kicked through the startup warm-up dance
     *  (`emitFocused()` → `emitBlurred()` to force Tabby's lazy
     *  `frontend.attach` to fire on a non-active recovered tab). WeakSet so
     *  closed tabs drop out. Idempotency guard: we never want to emit a
     *  second synthetic focus/blur pair on a tab the user has since
     *  actually focused, since that would briefly flip `hasFocus` off
     *  under their feet. */
    private readonly warmedUp = new WeakSet<BaseTabComponent>()

    private sub: Subscription | null = null
    /** Stashed AppService ref so `onStates` can read `app.activeTab` when
     *  ordering REPLAY candidates. Without the priority sort, the active
     *  tab loses contested per-cwd quota to whichever warmed-up sibling
     *  the loop visits first — the original `count=1`/`tabs=N` race that
     *  surfaced as "non-focused tabs recovered, focused tab didn't". */
    private app: AppService

    constructor (
        private config: ConfigService,
        app: AppService,
        monitor: TabMonitor,
    ) {
        this.app = app
        // Tag every tab Tabby restored from disk on this launch. Two paths:
        //   1. Tabs already in app.tabs at construction — covers the race
        //      where recoverTabs() finished before our singleton instantiated.
        //   2. Tabs that open via tabOpened$ within RESTORED_CAPTURE_MS —
        //      AppService.recoverTabs walks the persisted list and calls
        //      openNewTabRaw for each, so all restored tabs flow through here.
        // After the capture window closes, new tabs the user opens manually
        // are NOT tagged, so a fresh shell that happens to land in a pinned
        // cwd does not auto-launch unexpectedly.
        for (const tab of app.tabs) this.restoredOuterTabs.add(tab)
        const captureUntil = this.startupTs + AutoResumeService.RESTORED_CAPTURE_MS
        const openedSub = app.tabOpened$.subscribe(tab => {
            if (Date.now() < captureUntil) {
                this.restoredOuterTabs.add(tab)
                this.scheduleWarmup(tab, app, monitor)
            }
        })

        // Startup warm-up. Tabby lazy-initializes terminal sessions on first
        // focus (`baseTerminalTab.ngOnInit` → `setImmediate` →
        // `focused$.pipe(first()).subscribe(frontend.attach)`), so every
        // recovered tab other than the originally-active one sits dormant
        // until the user clicks it — no shell, no cwd, no REPLAY. Pre-fix
        // that meant "all my Claude sessions come back" actually meant "the
        // ONE I had focused comes back, the others wait for clicks". We
        // synthesise the first-focus event ourselves on every non-active
        // restored tab so all of them kick their sessions in parallel.
        //
        // `emitFocused()` synchronously fires `focused$`; the lazy attach
        // subscription runs and dispatches `frontend.attach()` (async, in
        // flight). We follow with `emitBlurred()` to revert `hasFocus`
        // back to false so the user's visible focus state is unchanged —
        // critical because `SplitTabComponent`'s hotkey handler keys off
        // `hasFocus`, and we don't want every restored split to start
        // eating hotkeys. The emit pair is gated behind WARMUP_DELAY_MS
        // so each tab's `ngOnInit` has had a chance to run; an emit that
        // lands before the lazy-attach subscription is set up would be a
        // no-op (Subject, not BehaviorSubject — no replay).
        for (const tab of app.tabs) this.scheduleWarmup(tab, app, monitor)

        // Seed the focus tracker with whichever tab is active right now.
        // AppService.recoverTabs flows synchronously through openNewTabRaw +
        // selectTab BEFORE this constructor runs, so the
        // originally-active restored tab is already `app.activeTab` and
        // would otherwise miss the activeTabChange$ subscription below
        // (the event fired pre-subscribe). Without this seed, the
        // user's "active when I quit" tab would never auto-resume —
        // the most important tab is the one we'd silently drop.
        if (app.activeTab) this.focusedOuterTabs.add(app.activeTab)
        const focusSub = app.activeTabChange$.subscribe(tab => {
            if (!tab) return
            const firstFocus = !this.focusedOuterTabs.has(tab)
            this.focusedOuterTabs.add(tab)
            // First focus for a previously-unfocused tab — re-evaluate
            // states immediately so REPLAY can fire without waiting for
            // the next 1.5 s poll. Idempotent: a no-op if cwd isn't yet
            // known or no persisted entry matches. `monitor` captured by
            // closure rather than via a class field — the callback is
            // the only consumer.
            if (firstFocus) this.onStates(monitor.current)
        })

        // States stream fires on every TabMonitor tick AND when a hook
        // event arrives — both moments are useful here. Subscribing to a
        // dedicated tabOpened$ doesn't help for the replay path: cwd isn't
        // known at open time (the shell hasn't reported it yet, and for
        // restored non-focused tabs the shell hasn't even spawned yet —
        // Tabby lazy-initializes sessions on first focus). The states
        // stream catches the moment cwd lands, whenever that is.
        const statesSub = monitor.states$.subscribe(states => this.onStates(states))

        this.sub = new Subscription()
        this.sub.add(openedSub)
        this.sub.add(focusSub)
        this.sub.add(statesSub)
    }

    ngOnDestroy (): void {
        this.sub?.unsubscribe()
    }

    private get enabled (): boolean {
        return this.config.store?.ai?.autoResumeAgents !== false
    }

    private get persistedMap (): Record<string, PersistedEntryRaw> {
        return this.config.store?.ai?.autoResumeCommandByCwd ?? {}
    }

    /** Persist a single entry, or delete if `entry === null`. No-op when
     *  nothing actually changes — avoids spurious ConfigService.changed$
     *  emits on every poll. */
    private async setPersisted (cwd: string, entry: PersistedEntry | null): Promise<void> {
        const current: Record<string, PersistedEntryRaw> = { ...this.persistedMap }
        if (entry === null) {
            if (!(cwd in current)) return
            delete current[cwd]
        } else {
            const existing = parsePersistedEntry(current[cwd])
            if (existing && existing.command === entry.command && existing.count === entry.count) return
            current[cwd] = { command: entry.command, count: entry.count }
        }
        this.config.store.ai.autoResumeCommandByCwd = current
        await this.config.save()
    }

    /** Add `tab` to the cwd's agent set if not already counted. Persists
     *  the updated `{ command, count }` entry. Idempotent — repeat calls
     *  for the same (cwd, tab) pair are no-ops. */
    private addToCwdAgentSet (cwd: string, tab: BaseTabComponent, command: string): void {
        let set = this.cwdAgentTabs.get(cwd)
        if (!set) {
            set = new WeakSet<BaseTabComponent>()
            this.cwdAgentTabs.set(cwd, set)
        }
        if (set.has(tab)) {
            // Already counted — but the command MIGHT have evolved (rare:
            // agent restarted with different flags). Re-persist to pick
            // up any drift; setPersisted is a no-op when nothing changed.
            const count = this.cwdAgentCount.get(cwd) ?? 1
            void this.setPersisted(cwd, { command, count })
            return
        }
        set.add(tab)
        const next = (this.cwdAgentCount.get(cwd) ?? 0) + 1
        this.cwdAgentCount.set(cwd, next)
        void this.setPersisted(cwd, { command, count: next })
    }

    /** Remove `tab` from the cwd's agent set. When the count drops to 0
     *  the persisted entry is deleted; otherwise it's re-persisted with
     *  the lower count (the existing command stays put — we don't have a
     *  fresher one to write). */
    private removeFromCwdAgentSet (cwd: string, tab: BaseTabComponent): void {
        const set = this.cwdAgentTabs.get(cwd)
        if (!set || !set.has(tab)) return
        set.delete(tab)
        const next = Math.max(0, (this.cwdAgentCount.get(cwd) ?? 1) - 1)
        if (next === 0) {
            this.cwdAgentCount.delete(cwd)
            this.cwdAgentTabs.delete(cwd)
            void this.setPersisted(cwd, null)
        } else {
            this.cwdAgentCount.set(cwd, next)
            const existing = parsePersistedEntry(this.persistedMap[cwd])
            if (existing) {
                void this.setPersisted(cwd, { command: existing.command, count: next })
            }
        }
    }

    private onStates (states: TabState[]): void {
        if (!this.enabled) return
        const persisted = this.persistedMap

        // Priority sort: the currently-active outer tab is processed
        // first so it claims contested per-cwd quota before any sibling
        // does. Bug repro — persisted `/repo` has count=1, two restored
        // tabs A,B both at /repo, B is active. Warmup for A fires at
        // 250 ms and synthetically focuses A, then re-fires onStates on
        // the [A,B] snapshot. Without this sort the loop visits A first,
        // consumes the only quota slot, then visits B (already in
        // focusedOuterTabs from the constructor seed) and finds quota=0
        // — B is marked attempted and the user's focused tab silently
        // sits there with no claude. Stable, no-op when no tab is active.
        const active = this.app.activeTab
        const ordered = active
            ? [...states].sort((a, b) => {
                if (a.outerTab === active && b.outerTab !== active) return -1
                if (b.outerTab === active && a.outerTab !== active) return 1
                return 0
            })
            : states

        for (const s of ordered) {
            // CAPTURE: agent is alive here, remember the (cwd → command)
            // for next restart and bump the per-cwd count if this is a
            // new (cwd, tab) pairing. Also arm the cleanup gate for this
            // tab.
            //
            // Shell-safety gate: if the reduced command contains shell
            // metacharacters (`;`, backtick, `$(`, redirections, quotes,
            // control chars, etc.) we refuse to persist. See `isShellSafe`
            // docstring for the threat model — short version, a process
            // whose argv passes our AI_PATTERNS regex but contains shell
            // metacharacters would otherwise get typed verbatim into a
            // fresh shell on next launch and execute the attacker payload.
            // Falling through silently to "no auto-resume for this cwd" is
            // strictly safer than persisting an attacker-controlled string.
            // The cleanup gate STILL arms — the agent is observably alive
            // here regardless of the cmdline's shape.
            if (s.aiTool && s.cwd && s.aiCommandLine) {
                const command = toRunnableCommand(s.aiCommandLine, s.aiTool)
                if (isShellSafe(command)) {
                    // Rebalance if the tab moved cwd while its agent
                    // kept running (rare — agents typically don't
                    // survive a shell-level `cd`, but a sub-shell that
                    // chdirs without exec would surface this). Without
                    // the rebalance the old cwd keeps a stale count
                    // and would over-resume next launch.
                    const prevCwd = this.lastAgentCwdByTab.get(s.outerTab)
                    if (prevCwd && prevCwd !== s.cwd) {
                        this.removeFromCwdAgentSet(prevCwd, s.outerTab)
                    }
                    this.lastAgentCwdByTab.set(s.outerTab, s.cwd)
                    this.addToCwdAgentSet(s.cwd, s.outerTab, command)
                } else if (!this.warnedUnsafeCapture.has(s.outerTab)) {
                    this.warnedUnsafeCapture.add(s.outerTab)
                    // eslint-disable-next-line no-console
                    console.warn('[glanceterm] auto-resume: refusing to persist cmdline containing shell metacharacters for tab', s.title)
                }
                this.hadAgentThisSession.set(s.outerTab, s.aiTool)
                continue
            }

            // CLEANUP: tab had an agent earlier this session and now
            // doesn't → user typed exit/quit/Ctrl-D. Drop this tab from
            // its prior cwd's set (which decrements count and deletes the
            // persisted entry only when no other tab is still holding it).
            // Disarm the gate so we don't repeatedly re-decrement on
            // every subsequent tick.
            if (s.cwd && !s.aiTool && this.hadAgentThisSession.has(s.outerTab)) {
                const cwd = this.lastAgentCwdByTab.get(s.outerTab) ?? s.cwd
                this.removeFromCwdAgentSet(cwd, s.outerTab)
                this.lastAgentCwdByTab.delete(s.outerTab)
                this.hadAgentThisSession.delete(s.outerTab)
                continue
            }

            // REPLAY: a Tabby-restored tab whose shell has just become live
            // (cwd known, no agent yet, never attempted) AND that the user
            // has actually focused at least once this lifetime, with a
            // cwd that matches a persisted entry — schedule the relaunch
            // up to the per-cwd quota. Gated on restoredOuterTabs rather
            // than a wall-clock window because Tabby lazy-initializes
            // terminal sessions; gated on focusedOuterTabs so the
            // originally-active tab gets its agent back (we seeded the
            // set with app.activeTab at construction) while the OTHER
            // restored tabs sit idle until the user clicks them.
            if (
                this.restoredOuterTabs.has(s.outerTab)
                && this.focusedOuterTabs.has(s.outerTab)
                && s.cwd && !s.aiTool
                && !this.attempted.has(s.outerTab)
            ) {
                const entry = parsePersistedEntry(persisted[s.cwd])
                if (entry) {
                    // Initialise the quota from the persisted count on
                    // first consideration at this cwd. Subsequent tabs
                    // sharing the cwd share the same counter.
                    if (!this.replayQuotaRemaining.has(s.cwd)) {
                        this.replayQuotaRemaining.set(s.cwd, entry.count)
                    }
                    const quota = this.replayQuotaRemaining.get(s.cwd) ?? 0
                    this.attempted.add(s.outerTab)
                    if (quota > 0) {
                        this.replayQuotaRemaining.set(s.cwd, quota - 1)
                        this.scheduleResume(s, entry.command)
                    }
                    // quota === 0: tab is marked attempted but no resume
                    // fires. That's the "3 tabs sharing a cwd, only 1
                    // had an agent" case — first focused tab gets the
                    // resume, the other two are quietly skipped.
                }
            }
        }
    }

    /** Force Tabby's lazy `frontend.attach` to fire on a non-active
     *  restored tab so its terminal session starts (and its cwd becomes
     *  observable) without waiting for the user to click it. See the
     *  block comment in the constructor for the full rationale; this is
     *  the bottom-half that runs after WARMUP_DELAY_MS has let ngOnInit
     *  set up the focus subscription.
     *
     *  Skip cases:
     *    - master toggle off — caller's job is to honour `ai.autoResumeAgents`
     *    - tab no longer in app.tabs (closed during the delay)
     *    - tab is the active tab — Tabby already focused it during restore
     *    - tab not restored (e.g. user opened a fresh shell after the
     *      30 s capture window) — warmup is only for recovered tabs
     *    - already warmed up — idempotent guard
     *
     *  Side effect: marks `focusedOuterTabs` so the REPLAY focus gate in
     *  `onStates` accepts this tab. That gate was originally a "user
     *  actually looked at this tab" hard requirement; for restored tabs
     *  we now treat "we synthetically focused it on the user's behalf"
     *  as satisfying the same intent (the user told us once, at quit
     *  time, that they wanted this agent here, and "restore everything"
     *  is the universal expectation).
     */
    private scheduleWarmup (tab: BaseTabComponent, app: AppService, monitor: TabMonitor): void {
        setTimeout(() => {
            if (!this.enabled) return
            if (!app.tabs.includes(tab)) return
            if (tab === app.activeTab) return
            if (!this.restoredOuterTabs.has(tab)) return
            if (this.warmedUp.has(tab)) return
            this.warmedUp.add(tab)
            this.focusedOuterTabs.add(tab)
            // The two emits are best-effort: in production they trigger
            // Tabby's lazy `frontend.attach` on a non-active recovered tab
            // (focus) and then revert `hasFocus` (blur). In unit tests the
            // FakeTab doesn't implement them and they throw — we still
            // want to fire `onStates` below, so we swallow rather than
            // bail. Real-Tabby errors are vanishingly unlikely (Subject
            // .next() doesn't throw) but worth logging if they happen.
            try { tab.emitFocused() } catch (e: any) {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] auto-resume warmup emitFocused threw:', e?.message ?? e)
            }
            try { tab.emitBlurred() } catch (e: any) {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] auto-resume warmup emitBlurred threw:', e?.message ?? e)
            }
            // Re-evaluate REPLAY against the current snapshot so a tab
            // whose cwd was ALREADY known by the time warmup runs (e.g.
            // an eagerly-warmed pty in dev mode, or a snapshot the harness
            // pre-populated) doesn't wait for the next 1.5 s poll. Mirrors
            // the same call `activeTabChange$` makes when a tab gains
            // focus for the first time. When cwd ISN'T known yet (the
            // common production case — `frontend.attach` only just
            // started the session), this is a no-op and the next
            // `states$` tick after the shell reports cwd handles REPLAY.
            this.onStates(monitor.current)
        }, AutoResumeService.WARMUP_DELAY_MS)
    }

    private scheduleResume (s: TabState, command: string): void {
        // Defense in depth: capture-side already rejects unsafe commands
        // before persistence, so the persisted map SHOULDN'T have any to
        // begin with. But config can be edited externally (or by a prior
        // pre-fix install of GlanceTerm), so re-check here. Lossless skip
        // — the worst case is a missed auto-resume for one cwd until the
        // user manually re-launches.
        if (!isShellSafe(command)) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] auto-resume: refusing to send cmdline containing shell metacharacters')
            return
        }

        // Cancel any previous pending timer for the same outer tab.
        const existing = this.pendingTimers.get(s.outerTab)
        if (existing) clearTimeout(existing)

        const tab = s.innerTab as unknown as { sendInput?: (s: string) => void }
        const t = setTimeout(() => {
            this.pendingTimers.delete(s.outerTab)
            try {
                tab.sendInput?.(`${command}\r`)
            } catch (e: any) {
                // eslint-disable-next-line no-console
                console.error('[glanceterm] auto-resume sendInput failed:', e?.message ?? e)
            }
        }, AutoResumeService.RESUME_DELAY_MS)
        this.pendingTimers.set(s.outerTab, t)
    }
}

/**
 * Persisted shape per cwd: `{ command, count }`. Count is the number of
 * distinct outer tabs at this cwd that had an agent alive at quit time —
 * REPLAY uses it as a quota so 3 restored tabs sharing /repo only get
 * their agents back if 3 of them originally had agents. Stored verbatim
 * for new writes; reads also accept the legacy bare-string shape from
 * pre-fix builds (interpreted as `{ command, count: 1 }`).
 */
export type PersistedEntry = { command: string; count: number }
/** What might come back from `config.store.ai.autoResumeCommandByCwd[cwd]` —
 *  unknown until parsed because old GlanceTerm installs wrote a bare string
 *  and the user's config may even have hand-edited garbage. */
export type PersistedEntryRaw = string | PersistedEntry | undefined

/**
 * Normalise a raw persisted entry into the new `{ command, count }` shape,
 * or return null if the entry is missing / malformed.
 *
 *   - Legacy string  `"claude --resume foo"`  → `{ command, count: 1 }`
 *   - Full object    `{ command, count: 3 }`  → preserved
 *   - Object missing count or with a non-positive / non-finite count →
 *     defaulted to 1. We never persist count 0 (the entry would be
 *     deleted instead), so any 0 we read is config drift from a manual
 *     edit and is treated as "at least one tab had an agent here".
 *   - Empty string, non-object, non-string, undefined → null.
 *
 * Pure. Exported for unit-testability.
 */
export function parsePersistedEntry (raw: PersistedEntryRaw | unknown): PersistedEntry | null {
    if (typeof raw === 'string') {
        return raw.length > 0 ? { command: raw, count: 1 } : null
    }
    if (raw && typeof raw === 'object') {
        const cmd = (raw as { command?: unknown }).command
        const cnt = (raw as { count?: unknown }).count
        if (typeof cmd !== 'string' || cmd.length === 0) return null
        const count = typeof cnt === 'number' && Number.isFinite(cnt) && cnt > 0
            ? Math.floor(cnt)
            : 1
        return { command: cmd, count }
    }
    return null
}

/**
 * Conservative shell-safety check for the `aiCommandLine` we're about to
 * persist (and later type verbatim, with a trailing `\r`, into a freshly-
 * restored shell).
 *
 * Threat model
 * ------------
 * `aiCommandLine` is captured from a raw `ps -p <pid> -o command=` read in
 * TabMonitor — i.e. the literal argv of whatever process matched our
 * AI_PATTERNS regex. An attacker who can briefly run a process whose argv
 * looks like `claude '; rm -rf ~ #'` (the basename matches, the regex
 * fires) gets that string captured, persisted to
 * `ai.autoResumeCommandByCwd`, and typed verbatim into the user's shell on
 * the NEXT app launch. That converts an ephemeral exec into a persistent
 * remote-code-execution trigger on every subsequent restart.
 *
 * The check
 * ---------
 * Reject anything containing characters that would let the shell
 * re-interpret the captured cmdline as more than a single program
 * invocation — command separators, redirections, substitutions, quotes,
 * escapes, the comment introducer, control characters. Allowlist would be
 * cleaner but the legitimate character set spans too widely (paths with
 * Unicode, locale-specific identifiers, version strings); a tight denylist
 * of known-dangerous metacharacters is the pragmatic balance.
 *
 * Reject set:
 *   ; & | `   command separators / pipes / backtick-substitution
 *   $         variable / `$()` substitution
 *   < >       redirection
 *   ' "       quoting (could close an outer quote and break out)
 *   \         escape introducer
 *   #         comment introducer (would let attacker hide tail of payload)
 *   \x00-\x1f control chars including \n \r \t \0 — \n / \r are the
 *             real concern (line separator could end input early), but
 *             nothing legitimate has control chars in an AI CLI argv.
 *   \x7f      DEL
 *
 * Legitimate cmdlines that pass: `claude`, `claude --resume foo`,
 * `node /Users/me/.../@anthropic-ai/claude-code/cli.js --resume foo`,
 * `claude --model=claude-opus-4-7 --max-tokens 4096`, `codex -m gpt-5`.
 *
 * Exported alongside `toRunnableCommand` so it can be unit-tested.
 */
const SHELL_UNSAFE_RE = /[;&|`$<>'"\\#\x00-\x1f\x7f]/
export function isShellSafe (s: string): boolean {
    return !SHELL_UNSAFE_RE.test(s)
}

/**
 * Reduce a raw `ps`-observed command line to a re-runnable invocation by
 * stripping interpreter prefixes and absolute paths down to the bare tool
 * name, while preserving every argument that came after it.
 *
 * Two-pass match against the cmdline tokens:
 *
 *   Pass 1: exact basename match. `claude`, `/usr/local/bin/claude`,
 *           `node /path/to/claude.js` all surface a token whose
 *           basename is `claude` or starts with `claude.` — easy win.
 *   Pass 2: path-segment match. The node-launched Claude CLI shows up
 *           as `node /Users/me/.../@anthropic-ai/claude-code/cli.js …`
 *           — none of the tokens have `claude` as their basename, but
 *           one of them contains `/claude-` or `/claude/` as a path
 *           segment. Codex's `/codex-cli/` shape matches the same way.
 *
 * Args after the matched token are joined back with single spaces. This
 * loses quoting on args that originally contained whitespace (`ps`
 * already lost them), but AI CLI flags are almost always
 * `--key value` or `--key=value` shapes that survive the round-trip.
 *
 * Fallback: no token recognised → return the bare tool name. The user
 * loses their original flags but a fresh launch still happens.
 *
 * Exported for unit-testability if we add tests later — for now it's
 * only consumed inside this module.
 */
export function toRunnableCommand (cmdline: string, tool: string): string {
    const tokens = cmdline.split(/\s+/).filter(Boolean)
    const argsFrom = (i: number): string => {
        const args = tokens.slice(i + 1).join(' ')
        return args ? `${tool} ${args}` : tool
    }
    // Pass 1: exact basename match (claude / claude.js / claude.mjs / …).
    for (let i = 0; i < tokens.length; i++) {
        const basename = tokens[i].split('/').pop() ?? ''
        if (basename === tool || basename.startsWith(`${tool}.`)) {
            return argsFrom(i)
        }
    }
    // Pass 2: token whose absolute path contains the tool name as a
    // segment — `/path/to/claude-code/cli.js`, `/path/to/codex-cli/...`.
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].includes(`/${tool}-`) || tokens[i].includes(`/${tool}/`)) {
            return argsFrom(i)
        }
    }
    return tool
}
