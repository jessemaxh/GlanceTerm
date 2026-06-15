import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'

import { AppService, ConfigService, BaseTabComponent } from 'tabby-core'

import { TabMonitor, TabState, AiTool } from './tab-monitor'

/**
 * Diagnostic trace for the auto-resume pipeline. The happy path is otherwise
 * completely silent, and renderer `console.*` is NOT forwarded to Tabby's
 * on-disk `log.txt` (only main-process logs land there) — so after an app
 * restart there is no artifact recording whether REPLAY fired or which gate
 * blocked it. This appends one timestamped line per decision to
 * `~/.glanceterm/auto-resume.log` (same dir as `auto-approve.log`), which
 * survives the restart for post-hoc inspection.
 *
 * Flip DIAG_LOG to false (or delete this block + its call sites) once a
 * resume issue has been diagnosed. Writes are best-effort and synchronous-
 * append only; a failed write never disturbs the feature.
 */
const DIAG_LOG = false
const DIAG_PATH = path.join(os.homedir(), '.glanceterm', 'auto-resume.log')
function diag (msg: string): void {
    if (!DIAG_LOG) {
        return
    }
    try {
        fsSync.appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${msg}\n`)
    } catch {
        /* best-effort; never break auto-resume for a log write */
    }
}

/**
 * "When I restart GlanceTerm, the tab comes back but my Claude session is
 *  gone — re-run it for me, with the same flags I had."
 *
 * Per-tab, keyed off Tabby's own recovery token
 * ─────────────────────────────────────────────
 * The agent command is stored ON THE TAB, not in a global cwd map. Tabby
 * already serializes every terminal tab to disk via `getRecoveryToken()`
 * and rebuilds each one from its own token on restart — that token IS a
 * stable per-tab identity across an app restart (it's how the tab's cwd,
 * scrollback, and profile survive). We piggyback on it: tabby-local's
 * `TerminalTabComponent.glancetermResumeCommand` field is written here on
 * capture, persisted inside the token (gated on `includeState`), and
 * restored onto the recovered instance by `RecoveryProvider.recover`.
 *
 * Why per-tab instead of the old `cwd → { command, count }` map:
 * cwd is NOT a unique key. Two tabs open in the same directory running
 * different agents (one `claude`, one `codex`), or the same agent with
 * different flags (`claude --resume A` vs `--resume B`), collapsed onto a
 * single cwd entry — last write won the command, a count tried to track
 * "how many", and on restart every restored tab at that cwd got the SAME
 * single command. The reported bug: same path, two tabs, two different
 * agents → both came back as one. Keying on the tab's own recovery token
 * removes the collision entirely; each tab carries its own command (or
 * none) and replays exactly that.
 *
 * Three-phase loop driven by TabMonitor.states$:
 *
 *   1. CAPTURE — every tick, for each tab with (aiTool, aiCommandLine)
 *      known, distil the raw `ps` command line into a re-runnable
 *      invocation (via toRunnableCommand) and stash it on the inner
 *      terminal tab as `glancetermResumeCommand`. Refreshed every tick so
 *      it tracks flag changes; whatever it holds at quit time is what the
 *      recovery token serializes.
 *
 *   2. CLEANUP — a tab that earlier had an agent and now doesn't (user
 *      typed exit / quit / Ctrl-D) clears its own `glancetermResumeCommand`.
 *      That's the user signalling "next time, don't auto-launch here" for
 *      THIS tab — and only this tab. If the user instead quits the whole
 *      app without exiting the agent, the command is still on the tab and
 *      rides the token to next launch's replay path.
 *
 *   3. REPLAY — for any restored tab (present at construction OR opened via
 *      tabOpened$ within RESTORED_CAPTURE_MS of startup) that has been
 *      focused at least once this lifetime, the first tick we see with
 *      (cwd known, no aiTool, a restored `glancetermResumeCommand`) is the
 *      moment the lazy-initialized shell came alive and is ready for input.
 *      We sendInput(`${command}\r`) after RESUME_DELAY_MS. Each inner tab
 *      is resumed at most once per service lifetime (the `attempted`
 *      WeakSet), so a later agent-quit-then-reappear doesn't re-fire.
 *
 *      Why focus-gated AND restored-gated:
 *      - restored gate: a fresh shell the user opens after boot — or a
 *        reopened-closed-tab whose token happens to carry a command — must
 *        NOT auto-launch. Only tabs Tabby recovered on this launch are
 *        eligible.
 *      - focus gate: Tabby lazy-initializes terminal sessions on first
 *        focus (terminalTab `onFrontendReady` → `initializeSession`, gated
 *        on `frontend.attach` which only runs on first focus). cwd usually
 *        becomes known only after focus. We gate on `app.activeTabChange$`
 *        having fired for the outer tab, seeded with `app.activeTab` at
 *        construction so the originally-active restored tab is eligible
 *        immediately (Tabby's recoverTabs() selectTab()'d it before this
 *        service existed).
 *
 *      Startup warm-up (the "restore all my agents on launch" path):
 *      Users expect EVERY recovered tab to get its agent back at startup,
 *      not just the focused one. The constructor synthesises a focus+blur
 *      pair on each non-active restored tab after WARMUP_DELAY_MS —
 *      `emitFocused()` triggers the lazy `frontend.attach` (session starts
 *      → cwd lands), `emitBlurred()` immediately reverts `hasFocus` so the
 *      user's visible focus and split-tab hotkey routing are unchanged.
 *
 * Keying convention
 * ─────────────────
 *   - The command and per-tab agent-lifecycle state (`attempted`,
 *     `hadAgentThisSession`, `warnedUnsafeCapture`, `pendingTimers`) are
 *     keyed by the INNER terminal tab — so a split with two panes each
 *     running an agent resumes both panes independently.
 *   - Restore/focus/warm-up state (`restoredOuterTabs`, `focusedOuterTabs`,
 *     `warmedUp`) is keyed by the OUTER tab — a split is recovered and
 *     focused as one unit.
 *
 * Master toggle: `ai.autoResumeAgents` (default true). When off, no capture,
 * no replay, no cleanup, no warm-up.
 *
 * Why we persist the COMMAND and not just the tool name:
 *   capturing the cmdline that TabMonitor already runs through `ps` is
 *   essentially free and preserves the user's flags (`claude --resume`,
 *   `codex --model gpt-5`). toRunnableCommand handles the node-launched
 *   case (`node /…/@anthropic-ai/claude-code/cli.js --resume foo` →
 *   `claude --resume foo`).
 *
 * Known limitations:
 *   - Args with spaces / special chars get re-quoted as plain
 *     space-separated tokens because `ps` already lost the quoting after
 *     argv-joining. AI CLIs rarely take such args.
 *   - "Restored tab" is tagged at tabOpened$ time within RESTORED_CAPTURE_MS
 *     of construction. A tab the user hand-opens INSIDE that window (rare —
 *     boot is busy) would also be tagged; but it would only auto-launch if
 *     its recovered token actually carried a command, which a brand-new
 *     tab never does.
 *   - The command is captured into the recovery token by Tabby's own save
 *     path (debounced after recovery hints + on app close), same as cwd /
 *     scrollback. A hard crash with no save since the agent started loses
 *     it — no worse than Tabby's native tab recovery.
 *   - If the user is actively typing in the just-restored tab during the
 *     2-second delay window, our `command\r` appends to their input.
 *     Narrow race; flagged for a future fix if anyone notices.
 */
@Injectable()
export class AutoResumeService implements OnDestroy {
    /** Window during which a tabOpened$ emission counts as "this was a
     *  session-restore tab, not a tab the user just opened". The restore
     *  path (AppService.recoverTabs → openNewTabRaw → tabOpened.next) walks
     *  every recovered tab on boot; anything that fires inside this window
     *  is tagged as restored and stays eligible for auto-resume regardless
     *  of how long the user takes to focus it. After this window, new tabs
     *  the user opens manually are NOT eligible. */
    private static readonly RESTORED_CAPTURE_MS = 30_000
    /** Delay between detecting a restorable tab and actually typing the
     *  launch command, so the shell has time to render its prompt and the
     *  echoed command doesn't appear before the `$ `. */
    private static readonly RESUME_DELAY_MS = 2_000
    /** Delay before firing the startup warm-up `emitFocused()` on each
     *  non-active restored tab. Long enough that each tab's `ngOnInit` has
     *  fired (and queued the lazy `frontend.attach` subscription on
     *  `focused$.pipe(first())`) — otherwise the focus event we emit lands
     *  before there's any subscriber to handle it and the session never
     *  inits. 250 ms is conservative for Angular CD + the inner
     *  `setImmediate` chain to settle. */
    private static readonly WARMUP_DELAY_MS = 250

    private readonly startupTs = Date.now()
    /** Inner terminal tabs we've already auto-resumed this service lifetime.
     *  WeakSet so closed tabs drop out automatically. Keyed by inner tab so
     *  each pane of a split resumes independently. */
    private readonly attempted = new WeakSet<BaseTabComponent>()
    /** Outer tabs Tabby recovered from disk this launch — already in
     *  app.tabs at construction OR opened via tabOpened$ within the
     *  RESTORED_CAPTURE_MS startup window. A restored tab stays eligible for
     *  the lifetime of the service (Tabby lazy-initializes sessions, so a
     *  non-focused recovered tab has no live shell — and no cwd — until
     *  clicked, possibly minutes after boot). */
    private readonly restoredOuterTabs = new WeakSet<BaseTabComponent>()
    /** Outer tabs that have been the active tab at least once since this
     *  service started. Drives the REPLAY focus gate. Seeded with
     *  `app.activeTab` at construction so the originally-active restored tab
     *  (already selectTab()'d by recoverTabs() before this service existed)
     *  is eligible immediately. */
    private readonly focusedOuterTabs = new WeakSet<BaseTabComponent>()
    /** Per inner tab: "we observed an agent running here at some point this
     *  service lifetime" — the gate for the CLEANUP path. Without it, a
     *  freshly-restored bare shell (no agent yet) would itself look like
     *  "user just quit the agent" and we'd wipe the command before the
     *  replay timer fired. */
    private readonly hadAgentThisSession = new WeakMap<BaseTabComponent, AiTool>()
    /** Per inner tab "we already warned about an unsafe-looking cmdline here
     *  this service lifetime" — prevents the shell-safety reject path from
     *  re-logging on every poll for the same offending process. */
    private readonly warnedUnsafeCapture = new WeakSet<BaseTabComponent>()
    /** Pending replay timers, keyed by inner tab so we can cancel cleanly on
     *  tab close and so split panes don't clobber each other's timers. */
    private readonly pendingTimers = new WeakMap<BaseTabComponent, ReturnType<typeof setTimeout>>()
    /** Outer tabs we've already kicked through the startup warm-up dance
     *  (`emitFocused()` → `emitBlurred()` to force Tabby's lazy
     *  `frontend.attach` to fire on a non-active recovered tab). WeakSet so
     *  closed tabs drop out. Idempotency guard: we never want to emit a
     *  second synthetic focus/blur pair on a tab the user has since actually
     *  focused, since that would briefly flip `hasFocus` off under their
     *  feet. */
    private readonly warmedUp = new WeakSet<BaseTabComponent>()

    /** DIAG-only dedup: last CAPTUREd command logged per inner tab, and last
     *  REPLAY gate-state string logged per inner tab. Prevents the per-1.5 s
     *  poll from flooding `auto-resume.log` with identical lines — we only
     *  emit when something actually changed. */
    private readonly lastCaptureLog = new WeakMap<BaseTabComponent, string>()
    private readonly lastGateLog = new WeakMap<BaseTabComponent, string>()

    private sub: Subscription | null = null

    /** DIAG-only: short human label for a tab in the trace. */
    private label (tab: BaseTabComponent | null | undefined): string {
        const t = tab as unknown as { title?: string, customTitle?: string }
        return (t && (t.customTitle || t.title)) ? String(t.customTitle || t.title) : '(untitled)'
    }

    /** DIAG-only: log the REPLAY gate evaluation for a restored tab, but only
     *  when the gate string differs from the last one logged for this tab. */
    private logReplayGate (inner: BaseTabComponent, label: string, gate: string): void {
        if (this.lastGateLog.get(inner) === gate) {
            return
        }
        this.lastGateLog.set(inner, gate)
        diag(`replay-gate ${label}: ${gate}`)
    }

    constructor (
        private config: ConfigService,
        app: AppService,
        monitor: TabMonitor,
    ) {
        // Tag every tab Tabby restored from disk on this launch. Two paths:
        //   1. Tabs already in app.tabs at construction — covers the race
        //      where recoverTabs() finished before our singleton instantiated.
        //   2. Tabs that open via tabOpened$ within RESTORED_CAPTURE_MS —
        //      AppService.recoverTabs walks the persisted list and calls
        //      openNewTabRaw for each, so all restored tabs flow through here.
        // After the capture window closes, new tabs the user opens manually
        // are NOT tagged, so a fresh shell (or a reopened-closed-tab whose
        // token happens to carry a command) does not auto-launch unexpectedly.
        diag(`═══════ AutoResumeService construct ═══════ enabled=${this.enabled} tabsAtConstruct=${app.tabs.length} activeTab=${app.activeTab ? this.label(app.activeTab) : 'none'}`)
        for (const tab of app.tabs) this.restoredOuterTabs.add(tab)
        diag(`restored-tagged@construct: [${app.tabs.map(t => this.label(t)).join(' | ')}]`)
        const captureUntil = this.startupTs + AutoResumeService.RESTORED_CAPTURE_MS
        const openedSub = app.tabOpened$.subscribe(tab => {
            if (Date.now() < captureUntil) {
                this.restoredOuterTabs.add(tab)
                diag(`restored-tag(tabOpened): ${this.label(tab)}`)
                this.scheduleWarmup(tab, app, monitor)
            }
        })

        // Startup warm-up. Tabby lazy-initializes terminal sessions on first
        // focus, so every recovered tab other than the originally-active one
        // sits dormant — no shell, no cwd, no REPLAY — until clicked. We
        // synthesise the first-focus event ourselves on every non-active
        // restored tab so all of them kick their sessions in parallel.
        // `emitFocused()` fires `focused$` (lazy attach runs → session
        // starts); `emitBlurred()` reverts `hasFocus` so the user's visible
        // focus state and split-tab hotkey routing are unchanged.
        for (const tab of app.tabs) this.scheduleWarmup(tab, app, monitor)

        // Seed the focus tracker with whichever tab is active right now —
        // recoverTabs() selectTab()'d the originally-active restored tab
        // BEFORE this constructor ran, so its activeTabChange$ event predates
        // our subscription. Without this seed the user's "active when I quit"
        // tab — the most important one — would never auto-resume.
        if (app.activeTab) this.focusedOuterTabs.add(app.activeTab)
        const focusSub = app.activeTabChange$.subscribe(tab => {
            if (!tab) return
            const firstFocus = !this.focusedOuterTabs.has(tab)
            this.focusedOuterTabs.add(tab)
            // First focus for a previously-unfocused tab — re-evaluate states
            // immediately so REPLAY can fire without waiting for the next
            // 1.5 s poll. Idempotent: a no-op if cwd isn't yet known or the
            // tab carries no command.
            if (firstFocus) {
                diag(`focus(first): ${this.label(tab)}`)
                this.onStates(monitor.current)
            }
        })

        // States stream fires on every TabMonitor tick AND when a hook event
        // arrives. It catches the moment cwd lands (for restored non-focused
        // tabs the shell hasn't even spawned until first focus), whenever
        // that is — a dedicated tabOpened$ wouldn't help because cwd isn't
        // known at open time.
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

    /** Sub-toggle: resume the agent's exact prior session via `--resume <id>`
     *  rather than re-launching a fresh conversation. Default on. */
    private get resumeSession (): boolean {
        return this.config.store?.ai?.autoResumeSession !== false
    }

    /** The pending resume command stashed on an inner terminal tab, or null
     *  if absent / not a non-empty string. */
    private getResumeCommand (inner: BaseTabComponent): string | null {
        const v = (inner as unknown as { glancetermResumeCommand?: unknown }).glancetermResumeCommand
        return typeof v === 'string' && v.length > 0 ? v : null
    }

    private setResumeCommand (inner: BaseTabComponent, command: string): void {
        (inner as unknown as { glancetermResumeCommand?: string }).glancetermResumeCommand = command
    }

    private clearResumeCommand (inner: BaseTabComponent): void {
        (inner as unknown as { glancetermResumeCommand?: string }).glancetermResumeCommand = undefined
    }

    private onStates (states: TabState[]): void {
        if (!this.enabled) return

        for (const s of states) {
            // CAPTURE: an agent is alive here — stash the re-runnable command
            // on the inner tab so the recovery token carries it to next
            // launch, and arm the cleanup gate for this tab.
            //
            // Shell-safety gate: if the reduced command contains shell
            // metacharacters (`;`, backtick, `$(`, redirections, quotes, …)
            // we refuse to stash it. See `isShellSafe` for the threat model —
            // short version, a process whose argv passes AI_PATTERNS but
            // contains shell metacharacters would otherwise get typed verbatim
            // into a fresh shell on next launch and execute the payload.
            // Falling through to "no auto-resume for this tab" is strictly
            // safer. The cleanup gate STILL arms — the agent is observably
            // alive here regardless of the cmdline's shape.
            if (s.aiTool && s.aiCommandLine) {
                let command = toRunnableCommand(s.aiCommandLine, s.aiTool)
                // Upgrade a fresh-launch command into one that RESUMES this
                // tab's exact prior session, when enabled and we know the
                // session id. Per-tab id (not cwd) means two tabs in the same
                // directory each resume their OWN conversation. Agents without
                // resume-by-id (Gemini) or without a captured id yet return
                // null here and keep the fresh command. The result still goes
                // through isShellSafe below.
                if (this.resumeSession && s.sessionId) {
                    const resumeCmd = buildResumeCommand(s.aiTool, s.sessionId, command)
                    if (resumeCmd) command = resumeCmd
                }
                if (isShellSafe(command)) {
                    this.setResumeCommand(s.innerTab, command)
                    if (this.lastCaptureLog.get(s.innerTab) !== command) {
                        this.lastCaptureLog.set(s.innerTab, command)
                        diag(`CAPTURE ${this.label(s.outerTab)}: ${JSON.stringify(command)}`)
                    }
                } else if (!this.warnedUnsafeCapture.has(s.innerTab)) {
                    this.warnedUnsafeCapture.add(s.innerTab)
                    // eslint-disable-next-line no-console
                    console.warn('[glanceterm] auto-resume: refusing to persist cmdline containing shell metacharacters for tab', s.title)
                }
                this.hadAgentThisSession.set(s.innerTab, s.aiTool)
                continue
            }

            // CLEANUP: tab had an agent earlier this session and now doesn't
            // (shell still alive — cwd known) → user typed exit/quit/Ctrl-D.
            // Clear the command so this tab won't auto-launch next restart,
            // and disarm the gate so we don't re-clear on every later tick.
            // Gated on hadAgentThisSession so a freshly-restored bare shell
            // (which legitimately carries a restored command but has not yet
            // run its agent THIS session) keeps its command for REPLAY.
            if (s.cwd && !s.aiTool && this.hadAgentThisSession.has(s.innerTab)) {
                this.clearResumeCommand(s.innerTab)
                this.hadAgentThisSession.delete(s.innerTab)
                diag(`CLEANUP ${this.label(s.outerTab)}: agent exited this session → command cleared (won't auto-resume)`)
                continue
            }

            // REPLAY: a Tabby-restored tab whose shell has just become live
            // (cwd known, no agent yet, never attempted), the user has
            // focused at least once this lifetime, and the recovered token
            // gave it a command — type it in after the settle delay. Each
            // inner tab fires at most once (the `attempted` guard), so an
            // agent that quits and reappears doesn't re-trigger.
            if (this.restoredOuterTabs.has(s.outerTab) && !this.attempted.has(s.innerTab)) {
                const command = this.getResumeCommand(s.innerTab)
                // DIAG: log exactly which gate is (un)satisfied, deduped so a
                // tab that's simply waiting doesn't flood the log. This is the
                // line that tells us WHY a restored tab didn't auto-resume.
                this.logReplayGate(
                    s.innerTab,
                    this.label(s.outerTab),
                    `restored=1 focused=${this.focusedOuterTabs.has(s.outerTab) ? 1 : 0} cwd=${s.cwd ? 1 : 0} noAgent=${!s.aiTool ? 1 : 0} cmd=${command ? JSON.stringify(command) : '∅'}`,
                )
                if (
                    this.focusedOuterTabs.has(s.outerTab)
                    && s.cwd && !s.aiTool
                    && command
                ) {
                    this.attempted.add(s.innerTab)
                    diag(`REPLAY fire ${this.label(s.outerTab)}: ${JSON.stringify(command)}`)
                    this.scheduleResume(s, command)
                }
            }
        }
    }

    /** Force Tabby's lazy `frontend.attach` to fire on a non-active restored
     *  tab so its terminal session starts (and its cwd becomes observable)
     *  without waiting for the user to click it. See the block comment in the
     *  constructor for the full rationale; this is the bottom-half that runs
     *  after WARMUP_DELAY_MS has let ngOnInit set up the focus subscription.
     *
     *  Skip cases:
     *    - master toggle off — honour `ai.autoResumeAgents`
     *    - tab no longer in app.tabs (closed during the delay)
     *    - tab is the active tab — Tabby already focused it during restore
     *    - tab not restored (user opened a fresh shell after the 30 s window)
     *    - already warmed up — idempotent guard
     *
     *  Side effect: marks `focusedOuterTabs` so the REPLAY focus gate accepts
     *  this tab — for restored tabs we treat "we synthetically focused it on
     *  the user's behalf" as satisfying the same intent (the user told us
     *  once, at quit time, that they wanted this agent here).
     */
    private scheduleWarmup (tab: BaseTabComponent, app: AppService, monitor: TabMonitor): void {
        setTimeout(() => {
            if (!this.enabled) { diag(`warmup skip ${this.label(tab)}: feature disabled`); return }
            if (!app.tabs.includes(tab)) { diag(`warmup skip ${this.label(tab)}: tab closed during delay`); return }
            if (tab === app.activeTab) return
            if (!this.restoredOuterTabs.has(tab)) { diag(`warmup skip ${this.label(tab)}: not a restored tab`); return }
            if (this.warmedUp.has(tab)) return
            this.warmedUp.add(tab)
            this.focusedOuterTabs.add(tab)
            diag(`warmup fire ${this.label(tab)}: emitFocused/emitBlurred → kick lazy session`)
            // Best-effort: in production these trigger Tabby's lazy
            // `frontend.attach` on a non-active recovered tab (focus) and then
            // revert `hasFocus` (blur). In unit tests the FakeTab's stubs are
            // no-ops; we still want to fire `onStates` below, so we swallow
            // rather than bail.
            try { tab.emitFocused() } catch (e: any) {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] auto-resume warmup emitFocused threw:', e?.message ?? e)
            }
            try { tab.emitBlurred() } catch (e: any) {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] auto-resume warmup emitBlurred threw:', e?.message ?? e)
            }
            // Re-evaluate REPLAY against the current snapshot so a tab whose
            // cwd was ALREADY known by the time warmup runs doesn't wait for
            // the next 1.5 s poll. When cwd ISN'T known yet (the common case —
            // `frontend.attach` only just started the session), this is a
            // no-op and the next `states$` tick handles REPLAY.
            this.onStates(monitor.current)
        }, AutoResumeService.WARMUP_DELAY_MS)
    }

    private scheduleResume (s: TabState, command: string): void {
        // Defense in depth: capture-side already rejects unsafe commands
        // before stashing, and a token from a clean install can't hold one.
        // But a token hand-edited in localStorage (or written by a pre-fix
        // build that lacked this gate) could, so re-check here. Lossless
        // skip — worst case is a missed auto-resume until the user relaunches.
        if (!isShellSafe(command)) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] auto-resume: refusing to send cmdline containing shell metacharacters')
            return
        }

        // Cancel any previous pending timer for the same inner tab.
        const existing = this.pendingTimers.get(s.innerTab)
        if (existing) clearTimeout(existing)

        const label = this.label(s.outerTab)
        diag(`scheduleResume ${label}: will type ${JSON.stringify(command)} in ${AutoResumeService.RESUME_DELAY_MS}ms`)
        const tab = s.innerTab as unknown as { sendInput?: (s: string) => void }
        const t = setTimeout(() => {
            this.pendingTimers.delete(s.innerTab)
            try {
                tab.sendInput?.(`${command}\r`)
                diag(`SENT ${label}: typed ${JSON.stringify(command)}\\r into the shell`)
            } catch (e: any) {
                diag(`SENT-FAIL ${label}: ${e?.message ?? e}`)
                // eslint-disable-next-line no-console
                console.error('[glanceterm] auto-resume sendInput failed:', e?.message ?? e)
            }
        }, AutoResumeService.RESUME_DELAY_MS)
        this.pendingTimers.set(s.innerTab, t)
    }
}

/**
 * Conservative shell-safety check for the `aiCommandLine` we're about to
 * stash (and later type verbatim, with a trailing `\r`, into a freshly-
 * restored shell).
 *
 * Threat model
 * ------------
 * `aiCommandLine` is captured from a raw `ps -p <pid> -o command=` read in
 * TabMonitor — i.e. the literal argv of whatever process matched our
 * AI_PATTERNS regex. An attacker who can briefly run a process whose argv
 * looks like `claude '; rm -rf ~ #'` (the basename matches, the regex
 * fires) gets that string captured, stashed on the tab, serialized into the
 * recovery token, and typed verbatim into the user's shell on the NEXT app
 * launch. That converts an ephemeral exec into a persistent remote-code-
 * execution trigger on every subsequent restart.
 *
 * The check
 * ---------
 * Reject anything containing characters that would let the shell
 * re-interpret the captured cmdline as more than a single program
 * invocation — command separators, redirections, substitutions, quotes,
 * escapes, the comment introducer, control characters. A tight denylist of
 * known-dangerous metacharacters is the pragmatic balance (an allowlist
 * spans too widely — Unicode paths, locale identifiers, version strings).
 *
 * Reject set:
 *   ; & | `   command separators / pipes / backtick-substitution
 *   $         variable / `$()` substitution
 *   < >       redirection
 *   ' "       quoting (could close an outer quote and break out)
 *   \         escape introducer
 *   #         comment introducer (would let attacker hide tail of payload)
 *   \x00-\x1f control chars including \n \r \t \0 — \n / \r are the real
 *             concern (line separator could end input early)
 *   \x7f      DEL
 *
 * Legitimate cmdlines that pass: `claude`, `claude --resume foo`,
 * `node /Users/me/.../@anthropic-ai/claude-code/cli.js --resume foo`,
 * `claude --model=claude-opus-4-7 --max-tokens 4096`, `codex -m gpt-5`.
 *
 * Exported alongside `toRunnableCommand` for unit-testability.
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
 *           `node /path/to/claude.js` all surface a token whose basename is
 *           `claude` or starts with `claude.` — easy win.
 *   Pass 2: path-segment match. The node-launched Claude CLI shows up as
 *           `node /Users/me/.../@anthropic-ai/claude-code/cli.js …` — none
 *           of the tokens have `claude` as their basename, but one contains
 *           `/claude-` or `/claude/` as a path segment. Codex's `/codex-cli/`
 *           shape matches the same way.
 *
 * Args after the matched token are joined back with single spaces. This
 * loses quoting on args that originally contained whitespace (`ps` already
 * lost them), but AI CLI flags are almost always `--key value` or
 * `--key=value` shapes that survive the round-trip.
 *
 * Fallback: no token recognised → return the bare tool name. The user loses
 * their original flags but a fresh launch still happens.
 *
 * Exported for unit-testability.
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
    // Pass 2: token whose absolute path contains the tool name as a segment —
    // `/path/to/claude-code/cli.js`, `/path/to/codex-cli/...`.
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].includes(`/${tool}-`) || tokens[i].includes(`/${tool}/`)) {
            return argsFrom(i)
        }
    }
    return tool
}

/**
 * Session id shapes we accept before splicing one into a shell command. The id
 * is whitelisted PER TOOL (their formats differ) so a malformed/hostile hook
 * payload can't smuggle shell tokens through the `--resume <id>` splice:
 *
 *   claude / codex → UUID (8-4-4-4-12 hex). Covers Claude's UUIDv4 AND Codex's
 *     UUIDv7-style id (`019eba31-ac54-7311-…`); both are hyphenated hex.
 *   opencode       → `ses_<base62>` (e.g. `ses_3cf7dd8d4ffeUPfENpVxfFojZ2`):
 *     the literal `ses_` prefix + mixed-case alphanumerics, no hyphens. A UUID
 *     regex would (and did, pre-fix) reject every real opencode id, silently
 *     disabling opencode resume.
 *
 * Both shapes are shell-safe by construction (hex+hyphen / alnum+underscore),
 * and the caller still runs the spliced result through isShellSafe.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPENCODE_SESSION_RE = /^ses_[0-9a-zA-Z]+$/

/** Whether `id` is a valid session id for `tool` (see the regex doc above). */
function isValidSessionId (tool: string, id: string): boolean {
    if (tool === 'opencode') return OPENCODE_SESSION_RE.test(id)
    return UUID_RE.test(id)   // claude, codex
}

/**
 * Rewrite a fresh-launch invocation into one that RESUMES a specific agent
 * session, per that agent's CLI. Returns null when the tool can't resume by id
 * (caller keeps the fresh command):
 *
 *   claude    → `claude --resume <id> [other flags]`   — drops any prior
 *               `--resume`/`-r`/`--resume=…` and `--continue`/`-c` so we don't
 *               double-resume; keeps the rest (`--model`, `--permission-mode`…).
 *   codex     → `codex resume <id>`                     — `resume` is a
 *               subcommand and the resumed session restores its own
 *               model/config, so we don't thread the original flags through.
 *   opencode  → `opencode --session <id> [other flags]` — drops prior
 *               `--session`/`-s`/`--session=…` and `--continue`/`-c`.
 *   gemini    → null                                    — the Gemini CLI has no
 *               launch-time resume-by-id flag.
 *
 * `runnable` is the output of toRunnableCommand ("claude", "claude --model
 * opus", …); its first token is always the bare tool name. The session id is
 * validated per tool (bad id → null). The caller still runs the result through
 * isShellSafe.
 *
 * Exported for unit-testability.
 */
export function buildResumeCommand (tool: string, sessionId: string, runnable: string): string | null {
    if (!isValidSessionId(tool, sessionId)) return null

    // Tokens after the leading tool name (toRunnableCommand always emits the
    // bare tool first).
    const args = runnable.split(/\s+/).filter(Boolean).slice(1)

    // Drop occurrences of value-taking flags (the flag AND its following value,
    // plus the `--flag=value` single-token form) and bare boolean flags.
    const strip = (xs: string[], valueFlags: string[], bareFlags: string[]): string[] => {
        const out: string[] = []
        for (let i = 0; i < xs.length; i++) {
            const x = xs[i]
            if (valueFlags.includes(x)) { i++; continue }                 // flag + value
            if (valueFlags.some(f => x.startsWith(`${f}=`))) continue      // --flag=value
            if (bareFlags.includes(x)) continue
            out.push(x)
        }
        return out
    }

    if (tool === 'claude') {
        const rest = strip(args, ['--resume', '-r'], ['--continue', '-c'])
        return ['claude', '--resume', sessionId, ...rest].join(' ')
    }
    if (tool === 'codex') {
        return `codex resume ${sessionId}`
    }
    if (tool === 'opencode') {
        const rest = strip(args, ['--session', '-s'], ['--continue', '-c'])
        return ['opencode', '--session', sessionId, ...rest].join(' ')
    }
    return null   // gemini & anything unknown — no resume-by-id
}
