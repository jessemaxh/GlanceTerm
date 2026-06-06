import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { ConfigService, BaseTabComponent } from 'tabby-core'

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
 *   3. REPLAY — for the first RESUME_WINDOW_MS after this service starts,
 *      any TabState we see with (cwd ∈ map, !aiTool) is a freshly-
 *      restored tab whose previous command we should respawn. We
 *      sendInput(`${command}\r`) into the tab after RESUME_DELAY_MS so
 *      the restored shell has time to render its prompt. Each outerTab
 *      is resumed at most once per service lifetime — the WeakSet guard
 *      prevents re-firing if the agent quits and we then see
 *      (cwd ∈ map, !aiTool) again.
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
 *   - 30 s wall-clock replay window. Slow boots that take longer to
 *     finish session restore would miss it. Alternative (no window,
 *     fire on every new tab open) would surprise users who manually
 *     `cd` into a previously-pinned cwd.
 *   - If the user is actively typing in the just-restored tab in the
 *     2-second delay window, our `claude\r` appends to their input.
 *     Narrow race; flagging for v1.1 fix if anyone notices.
 */
@Injectable()
export class AutoResumeService implements OnDestroy {
    /** How long after service construction we're willing to fire the replay
     *  path. Long enough for Tabby's session restore to walk all tabs and
     *  have each report a cwd, short enough that a tab the user opens
     *  manually a minute later doesn't get a surprise auto-launch. */
    private static readonly RESUME_WINDOW_MS = 30_000
    /** Delay between detecting a restorable tab and actually typing the
     *  launch command, so the shell has time to render its prompt and the
     *  echoed command doesn't appear before the `$ `. */
    private static readonly RESUME_DELAY_MS = 2_000

    private readonly startupTs = Date.now()
    /** Outer tabs we've already auto-resumed this service lifetime. WeakSet
     *  so closed tabs drop out automatically. */
    private readonly attempted = new WeakSet<BaseTabComponent>()
    /** Per-tab "we observed an agent running here at some point during
     *  this service's lifetime" — gate for the cleanup path. Without it,
     *  the freshly-restored bare shell (no agent yet) would itself look
     *  like "user just quit the agent" and we'd wipe the entry before
     *  the replay timer fired. */
    private readonly hadAgentThisSession = new WeakMap<BaseTabComponent, AiTool>()
    /** Pending replay timers, keyed by outer tab so we can cancel cleanly
     *  on tab close. */
    private readonly pendingTimers = new WeakMap<BaseTabComponent, ReturnType<typeof setTimeout>>()

    private sub: Subscription | null = null

    constructor (
        private config: ConfigService,
        monitor: TabMonitor,
    ) {
        // States stream fires on every TabMonitor tick AND when a hook
        // event arrives — both moments are useful here. Subscribing to a
        // dedicated tabOpened$ doesn't help: cwd isn't known at open time
        // (the shell hasn't reported it yet), so we'd have to wait for
        // the next states tick anyway.
        this.sub = monitor.states$.subscribe(states => this.onStates(states))
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
        const inStartupWindow = Date.now() - this.startupTs < AutoResumeService.RESUME_WINDOW_MS
        const persisted = this.persistedMap

        for (const s of states) {
            // CAPTURE: agent is alive here, remember the (cwd → command)
            // for next restart. Also arm the cleanup gate for this tab.
            if (s.aiTool && s.cwd && s.aiCommandLine) {
                const command = toRunnableCommand(s.aiCommandLine, s.aiTool)
                void this.setPersisted(s.cwd, command)
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

            // REPLAY: in startup window, freshly-restored tab with a cwd
            // that matches a persisted entry, agent not running yet,
            // haven't tried this tab before — schedule the relaunch.
            if (
                inStartupWindow
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
