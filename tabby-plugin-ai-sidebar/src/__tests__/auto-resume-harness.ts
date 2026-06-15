import { Subject } from 'rxjs'
import { vi } from 'vitest'

import { AutoResumeService } from '../auto-resume.service'
import type { AiTool, TabState } from '../tab-monitor'
import { TabStatus } from '../tab-monitor'

/**
 * Integration-test harness for AutoResumeService.
 *
 * The service touches three Tabby singletons (ConfigService, AppService,
 * TabMonitor). At runtime they reach deep into Angular + an Electron renderer
 * — out of reach for vitest's node environment. But the service only consumes
 * a small slice of each: a couple of getters, a couple of Subjects. We
 * hand-roll fakes of exactly that surface and construct the real
 * `AutoResumeService` against them, so the production state machine
 * (CAPTURE / CLEANUP / REPLAY paths, focus gate, warm-up) is what's under
 * test — not a re-implementation.
 *
 * Per-tab model
 * -------------
 * The agent command lives ON THE TAB (`tab.glancetermResumeCommand`), mirroring
 * how production stores it on the TerminalTabComponent instance and ferries it
 * across a restart via the tab's recovery token. So:
 *   - CAPTURE writes `tab.glancetermResumeCommand` (assert on it directly).
 *   - CLEANUP clears it to undefined.
 *   - A "restored" tab is created with `resumeCommand` preset, simulating what
 *     RecoveryProvider.recover does on the recovered instance.
 *   - REPLAY reads it back off the same tab and types it in.
 * There is no config map: the fix's whole point is that nothing is keyed by
 * cwd anymore.
 *
 * What this harness lets a test do:
 *
 *   1. Build the service with master switch on/off.
 *   2. `addTab({restored, active, resumeCommand})` — create fake terminal
 *      tabs. `restored:'preexisting'` pre-populates `app.tabs`; `'opened'`
 *      emits via `tabOpened$`. `resumeCommand` seeds the per-tab command as
 *      if the recovery token had carried it.
 *   3. `focus(tab)` — emit `activeTabChange$` so focusedOuterTabs picks up the
 *      tab and the immediate re-tick fires.
 *   4. `emitTick(states)` — push a TabState[] snapshot through
 *      `monitor.states$` (mirrored into `monitor.current` so the
 *      focus-triggered re-tick reads the same states).
 *   5. Inspect `tab.glancetermResumeCommand` / `tab.sentInputs` to assert the
 *      resulting per-tab side effects.
 *
 * Timers: scheduleResume waits 2 s before sendInput. Tests opt into
 * `vi.useFakeTimers()` and call `harness.advance(2000)` to flush.
 */

export interface FakeTab {
    /** Test-side stable id. Production code uses object identity; the id is
     *  here so test assertions can refer to a tab by name. */
    id: string
    /** Strings passed to `innerTab.sendInput()` from scheduleResume's
     *  setTimeout callback. Production uses `${command}\r`; tests assert on
     *  the full string including the carriage return. */
    sentInputs: string[]
    customTitle: string | null
    title: string
    /** The per-tab AI resume command — the field AutoResumeService reads and
     *  writes. Preset on "restored" tabs (mimicking RecoveryProvider.recover),
     *  written by CAPTURE, cleared by CLEANUP. */
    glancetermResumeCommand?: string
    sendInput (s: string): void
    /** Stubs for the warm-up `emitFocused()`/`emitBlurred()` pair. Tests don't
     *  exercise the real Angular focus side effects, so these are no-ops; their
     *  presence keeps the service's try/catch from logging on every warm-up. */
    emitFocused (): void
    emitBlurred (): void
}

export interface FakeStateOverrides {
    aiTool?: AiTool | null
    aiCommandLine?: string | null
    cwd?: string | null
    /** Agent session id — drives the `--resume <id>` capture path. */
    sessionId?: string | null
}

/** Build a partial TabState with the fields AutoResumeService reads. Other
 *  fields (status, lastActiveMs, …) are present so the cast to TabState is
 *  type-safe; the service never touches them. innerTab === outerTab here —
 *  single-pane tabs — which is what the service keys the command off. */
export function makeTabState (tab: FakeTab, overrides: FakeStateOverrides = {}): TabState {
    const outerTab = tab as unknown as TabState['outerTab']
    return {
        outerTab,
        innerTab: outerTab,
        tabId: null,
        title: tab.customTitle ?? tab.title,
        aiTool: overrides.aiTool ?? null,
        aiPid: overrides.aiTool ? 1234 : null,
        aiCommandLine: overrides.aiCommandLine ?? null,
        cwd: overrides.cwd ?? null,
        status: overrides.aiTool ? TabStatus.Working : TabStatus.NoAi,
        lastActiveMs: null,
        awaitingFirstEvent: false,
        subagentCount: 0,
        backgroundJobCount: 0,
        monitorCount: 0,
        model: null,
        tokensIn: null,
        tokensCacheRead: null,
        tokensOut: null,
        sessionId: overrides.sessionId ?? null,
    }
}

export interface AddTabOpts {
    /** Mark as a Tabby-restored tab. `'preexisting'` puts it in `app.tabs`
     *  before the service constructs (covers the recoverTabs-finished-first
     *  race); `'opened'` emits `tabOpened$` within the 30 s capture window
     *  (the normal restore path). Both tag the tab as restored. */
    restored?: 'preexisting' | 'opened' | false
    /** Become `app.activeTab` immediately and fire `activeTabChange$`. */
    active?: boolean
    title?: string
    /** Seed the per-tab resume command, simulating what RecoveryProvider
     *  restores onto the recovered instance from the token. */
    resumeCommand?: string
}

export class AutoResumeHarness {
    readonly config = {
        store: {
            ai: {
                autoResumeAgents: true as boolean,
                autoResumeSession: true as boolean,
            },
        },
    }
    readonly app = {
        tabs: [] as FakeTab[],
        tabOpened$: new Subject<FakeTab>(),
        activeTab: null as FakeTab | null,
        activeTabChange$: new Subject<FakeTab | null>(),
    }
    readonly monitor = {
        states$: new Subject<TabState[]>(),
        current: [] as TabState[],
    }

    private service: AutoResumeService | null = null
    private nextId = 0

    constructor (opts: {
        autoResumeAgents?: boolean
        autoResumeSession?: boolean
        preexistingTabs?: AddTabOpts[]
    } = {}) {
        if (opts.autoResumeAgents !== undefined) {
            this.config.store.ai.autoResumeAgents = opts.autoResumeAgents
        }
        if (opts.autoResumeSession !== undefined) {
            this.config.store.ai.autoResumeSession = opts.autoResumeSession
        }
        // Pre-add tabs BEFORE construction so they end up in
        // `restoredOuterTabs` via the "already in app.tabs" path. The active
        // flag is honoured so the seed of `app.activeTab` catches it.
        if (opts.preexistingTabs) {
            for (const t of opts.preexistingTabs) {
                const tab = this.makeTab(t.title, t.resumeCommand)
                this.app.tabs.push(tab)
                if (t.active) this.app.activeTab = tab
            }
        }
    }

    /** Construct the service. Call after the optional pre-existing-tab setup
     *  but before exercising any state transitions. */
    start (): AutoResumeService {
        this.service = new AutoResumeService(
            this.config as any,
            this.app as any,
            this.monitor as any,
        )
        return this.service
    }

    /** Add a tab to the harness. With `restored: 'preexisting'` the caller
     *  must call this BEFORE `start()`; with `restored: 'opened'` either
     *  before or after — the harness emits `tabOpened$` in both cases. */
    addTab (opts: AddTabOpts = {}): FakeTab {
        const tab = this.makeTab(opts.title, opts.resumeCommand)
        if (opts.restored === 'preexisting') {
            this.app.tabs.push(tab)
        } else if (opts.restored === 'opened' || opts.restored === undefined) {
            this.app.tabs.push(tab)
            this.app.tabOpened$.next(tab)
        }
        if (opts.active) this.focus(tab)
        return tab
    }

    /** Emit `activeTabChange$` for this tab. Mirrors selectTab() side effects. */
    focus (tab: FakeTab): void {
        this.app.activeTab = tab
        this.app.activeTabChange$.next(tab)
    }

    /** Push a snapshot through `monitor.states$` and update `monitor.current`
     *  to match — so the focus-triggered immediate re-tick reads the same
     *  states. */
    emitTick (states: TabState[]): void {
        this.monitor.current = states
        this.monitor.states$.next(states)
    }

    /** Fast-forward the fake timer past RESUME_DELAY_MS / WARMUP_DELAY_MS. */
    advance (ms: number): void {
        vi.advanceTimersByTime(ms)
    }

    private makeTab (title?: string, resumeCommand?: string): FakeTab {
        const id = `tab-${++this.nextId}`
        const tab: FakeTab = {
            id,
            sentInputs: [],
            customTitle: null,
            title: title ?? id,
            glancetermResumeCommand: resumeCommand,
            sendInput (s: string) { this.sentInputs.push(s) },
            emitFocused () { /* no-op stub — see FakeTab docstring */ },
            emitBlurred () { /* no-op stub — see FakeTab docstring */ },
        }
        return tab
    }
}
