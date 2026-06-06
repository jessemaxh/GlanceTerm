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
 *      `ai.autoResumeCommandByCwd[cwd] = command`. Cwd is the only
 *      identifier stable across an app restart — PTYs die, GLANCETERM_TAB_ID
 *      regenerates, tab indices shuffle.
 *
 *   2. CLEANUP — same tab subsequently transitioning had-agent →
 *      no-agent (user typed exit / quit / Ctrl-D out of the agent)
 *      deletes the entry. That's the user signalling "next time, don't
 *      auto-launch here." If the user just quits the whole app without
 *      exiting the agent first, the entry sits in config and triggers
 *      the replay path next launch.
 *
 *   3. REPLAY — for any TabState whose outerTab was tagged as "restored
 *      from disk" (present at construction OR opened via tabOpened$
 *      within RESTORED_CAPTURE_MS of startup), the first tick we see
 *      with (cwd ∈ map, !aiTool) is the moment the lazy-initialized
 *      shell finally came alive. We sendInput(`${command}\r`) into the
 *      tab after RESUME_DELAY_MS so the restored shell has time to
 *      render its prompt. Each outerTab is resumed at most once per
 *      service lifetime — the WeakSet guard prevents re-firing if the
 *      agent quits and we then see (cwd ∈ map, !aiTool) again.
 *
 *      Why per-tab eligibility instead of a global startup window:
 *      Tabby lazy-initializes terminal sessions (terminalTab.component
 *      .ts onFrontendReady → initializeSession, gated on
 *      frontend.attach which only runs on first focus). Non-focused
 *      recovered tabs have NO shell — and therefore null cwd — at
 *      boot. A wall-clock window from service start would expire long
 *      before the user clicks each tab, leaving every non-focused tab
 *      stuck with a bare shell after restart.
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
    /** Per-tab "we observed an agent running here at some point during
     *  this service's lifetime" — gate for the cleanup path. Without it,
     *  the freshly-restored bare shell (no agent yet) would itself look
     *  like "user just quit the agent" and we'd wipe the entry before
     *  the replay timer fired. */
    private readonly hadAgentThisSession = new WeakMap<BaseTabComponent, AiTool>()
    /** Pending replay timers, keyed by outer tab so we can cancel cleanly
     *  on tab close. */
    private readonly pendingTimers = new WeakMap<BaseTabComponent, ReturnType<typeof setTimeout>>()
    /** Per-tab "we already warned about an unsafe-looking cmdline here this
     *  service lifetime" — prevents the shell-safety reject path from
     *  re-logging on every poll for the same offending process. */
    private readonly warnedUnsafeCapture = new WeakSet<BaseTabComponent>()

    private sub: Subscription | null = null

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
        // are NOT tagged, so a fresh shell that happens to land in a pinned
        // cwd does not auto-launch unexpectedly.
        for (const tab of app.tabs) this.restoredOuterTabs.add(tab)
        const captureUntil = this.startupTs + AutoResumeService.RESTORED_CAPTURE_MS
        const openedSub = app.tabOpened$.subscribe(tab => {
            if (Date.now() < captureUntil) {
                this.restoredOuterTabs.add(tab)
            }
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
        this.sub.add(statesSub)
    }

    ngOnDestroy (): void {
        this.sub?.unsubscribe()
    }

    private get enabled (): boolean {
        return this.config.store?.ai?.autoResumeAgents !== false
    }

    private get persistedMap (): Record<string, string> {
        return this.config.store?.ai?.autoResumeCommandByCwd ?? {}
    }

    /** Persist a single entry, or delete if `command === null`. No-op when
     *  nothing actually changes — avoids spurious ConfigService.changed$
     *  emits on every poll. */
    private async setPersisted (cwd: string, command: string | null): Promise<void> {
        const current = { ...this.persistedMap }
        if (command === null) {
            if (!(cwd in current)) return
            delete current[cwd]
        } else {
            if (current[cwd] === command) return
            current[cwd] = command
        }
        this.config.store.ai.autoResumeCommandByCwd = current
        await this.config.save()
    }

    private onStates (states: TabState[]): void {
        if (!this.enabled) return
        const persisted = this.persistedMap

        for (const s of states) {
            // CAPTURE: agent is alive here, remember the (cwd → command)
            // for next restart. Also arm the cleanup gate for this tab.
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
                    void this.setPersisted(s.cwd, command)
                } else if (!this.warnedUnsafeCapture.has(s.outerTab)) {
                    this.warnedUnsafeCapture.add(s.outerTab)
                    // eslint-disable-next-line no-console
                    console.warn('[glanceterm] auto-resume: refusing to persist cmdline containing shell metacharacters for tab', s.title)
                }
                this.hadAgentThisSession.set(s.outerTab, s.aiTool)
                continue
            }

            // CLEANUP: tab had an agent earlier this session and now
            // doesn't → user typed exit/quit/Ctrl-D. Drop the persisted
            // entry so next launch respects that intent. Disarm the gate
            // so we don't repeatedly re-delete on every subsequent tick.
            if (s.cwd && !s.aiTool && this.hadAgentThisSession.has(s.outerTab)) {
                void this.setPersisted(s.cwd, null)
                this.hadAgentThisSession.delete(s.outerTab)
                continue
            }

            // REPLAY: a Tabby-restored tab whose shell has just become live
            // (cwd known, no agent yet, never attempted), with a cwd that
            // matches a persisted entry — schedule the relaunch. Gated on
            // restoredOuterTabs rather than a wall-clock window because
            // Tabby lazy-initializes terminal sessions: a non-focused
            // recovered tab has no shell (and therefore no cwd) until the
            // user clicks it, which can happen well after any reasonable
            // startup window. Tagging at tabOpened$ time AND requiring the
            // tab to be in restoredOuterTabs keeps user-opened tabs out
            // of this path, so a brand-new shell that happens to land in
            // a pinned cwd is not surprise-launched.
            if (
                this.restoredOuterTabs.has(s.outerTab)
                && s.cwd && !s.aiTool
                && !this.attempted.has(s.outerTab)
            ) {
                const command = persisted[s.cwd]
                if (command) {
                    this.attempted.add(s.outerTab)
                    this.scheduleResume(s, command)
                }
            }
        }
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
