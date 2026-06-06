import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { ConfigService, BaseTabComponent } from 'tabby-core'

import { TabMonitor, TabState, AiTool } from './tab-monitor'

/**
 * "When I restart GlanceTerm, the tab comes back but my Claude session is
 *  gone — re-run it for me."
 *
 * Two-side feature:
 *
 *   1. CAPTURE — every TabMonitor tick, for each tab where (aiTool, cwd)
 *      are both known, persist `ai.autoResumeAgentByCwd[cwd] = aiTool`.
 *      Cwd is the only identifier stable across an app restart (PTYs die,
 *      GLANCETERM_TAB_ID regenerates). When the same tab subsequently
 *      transitions had-agent → no-agent (user typed `exit` / `/quit` /
 *      Ctrl+C'd out), the entry is deleted — that's the user signalling
 *      "next time, don't auto-launch here." If the user just quits the
 *      whole app without exiting the agent first, the entry sits in
 *      config and triggers the replay path next launch.
 *
 *   2. REPLAY — for the first RESUME_WINDOW_MS after this service starts,
 *      any TabState we see with (cwd ∈ map, !aiTool) is a freshly-
 *      restored tab whose previous agent we should respawn. We
 *      sendInput(`${tool}\r`) into the tab after RESUME_DELAY_MS so the
 *      restored shell has time to render its prompt; running before the
 *      prompt would still work (most shells buffer typed-but-unread
 *      bytes) but looks ugly because the `claude` keystrokes echo before
 *      the prompt does. Each outerTab is resumed at most once per
 *      service lifetime — the WeakSet guard prevents re-firing if the
 *      agent quits and we then see (cwd ∈ map, !aiTool) again.
 *
 * Master toggle: `ai.autoResumeAgents` (default true). When off, no
 * capture, no replay, no cleanup — config is untouched.
 *
 * Known limitations:
 *
 *   - Only the tool NAME is replayed (`claude`, `codex`, …). Flags the
 *     user originally typed (`claude --model sonnet --resume`) are lost.
 *     If a user complains, we can persist the full `ps`-observed
 *     command line instead — but absolute paths like
 *     `node /Users/me/.nvm/.../claude` aren't shell-portable, so we'd
 *     also need a basename heuristic. Out of scope for v1.
 *   - The replay window is wall-clock based (30 s). Tabby's session
 *     restore normally completes well inside that, but on a very
 *     slow boot the late-arriving tabs would miss the window. Tradeoff
 *     against the alternative (no window, fire on every new tab open)
 *     which would surprise users who manually `cd` into a previously-
 *     pinned cwd and don't want a Claude landing on them.
 *   - If the user is actively typing in the restored tab in the brief
 *     2-second delay before sendInput fires, our `claude\r` appends to
 *     their input. Unlikely in practice (the tab is just-restored, the
 *     user hasn't switched to it yet) but worth flagging.
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
     *  echoed `claude` doesn't appear before the `$ `. */
    private static readonly RESUME_DELAY_MS = 2_000

    private readonly startupTs = Date.now()
    /** Outer tabs we've already auto-resumed this service lifetime. WeakSet
     *  so closed tabs drop out automatically — if the user closes a
     *  restored tab and reopens the same cwd later (outside the window),
     *  we wouldn't re-fire anyway, but the WeakSet keeps things tidy. */
    private readonly attempted = new WeakSet<BaseTabComponent>()
    /** Per-tab "we observed an agent running here at some point during
     *  this service's lifetime" — gate for the cleanup path. Without it,
     *  the freshly-restored bare shell (no agent yet) would itself look
     *  like "user just quit the agent" and we'd wipe the entry before
     *  the replay timer fired. */
    private readonly hadAgentThisSession = new WeakMap<BaseTabComponent, AiTool>()
    /** Pending replay timers, keyed by outer tab so we can cancel cleanly
     *  on tab close (the timer's tab reference would otherwise hold the
     *  closed tab alive until it fires). */
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
        return this.config.store?.ai?.autoResumeAgentByCwd ?? {}
    }

    /** Persist a single entry, or delete if `tool === null`. No-op when
     *  nothing actually changes — avoids spurious ConfigService.changed$
     *  emits on every poll (AutoApproveService's flag sync, sound chime
     *  reader, etc. all subscribe to that). */
    private async setPersisted (cwd: string, tool: AiTool | null): Promise<void> {
        const current = { ...this.persistedMap }
        if (tool === null) {
            if (!(cwd in current)) return
            delete current[cwd]
        } else {
            if (current[cwd] === tool) return
            current[cwd] = tool
        }
        this.config.store.ai.autoResumeAgentByCwd = current
        await this.config.save()
    }

    private onStates (states: TabState[]): void {
        if (!this.enabled) return
        const inStartupWindow = Date.now() - this.startupTs < AutoResumeService.RESUME_WINDOW_MS
        const persisted = this.persistedMap

        for (const s of states) {
            // CAPTURE: agent is alive here, remember the (cwd → tool) for
            // next restart. Also arm the cleanup gate for this tab.
            if (s.aiTool && s.cwd) {
                void this.setPersisted(s.cwd, s.aiTool)
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
                const tool = persisted[s.cwd]
                if (tool) {
                    this.attempted.add(s.outerTab)
                    this.scheduleResume(s, tool)
                }
            }
        }
    }

    private scheduleResume (s: TabState, tool: string): void {
        // Cancel any previous pending timer for the same outer tab. Tabby
        // can emit `tabOpened$` twice in rare race paths (split-tab
        // recovery, dev hot-reload re-attach) and a stale timer racing a
        // fresh one would type the command twice.
        const existing = this.pendingTimers.get(s.outerTab)
        if (existing) clearTimeout(existing)

        const tab = s.innerTab as unknown as { sendInput?: (s: string) => void }
        const t = setTimeout(() => {
            this.pendingTimers.delete(s.outerTab)
            try {
                tab.sendInput?.(`${tool}\r`)
            } catch (e: any) {
                // eslint-disable-next-line no-console
                console.error('[glanceterm] auto-resume sendInput failed:', e?.message ?? e)
            }
        }, AutoResumeService.RESUME_DELAY_MS)
        this.pendingTimers.set(s.outerTab, t)
    }
}
