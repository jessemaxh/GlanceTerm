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
 * — out of reach for vitest's node environment. But the service only
 * consumes a small slice of each: a couple of getters, a couple of Subjects,
 * a `.save()`. We hand-roll fakes of exactly that surface and construct
 * the real `AutoResumeService` against them, so the production state machine
 * (CAPTURE / CLEANUP / REPLAY paths, focus gate, per-cwd quota) is what's
 * under test — not a re-implementation.
 *
 * What this harness lets a test do:
 *
 *   1. Build the service with master switch on/off.
 *   2. `addTab({restored, active})` — create fake BaseTabComponents that
 *      stand in for terminal tabs. `restored:true` either pre-populates
 *      `app.tabs` (the "Tabby finished recoverTabs before our service
 *      instantiated" race) OR emits via `tabOpened$` (the "open during
 *      the 30 s capture window" path) — both routes tag the tab as
 *      restored just like production.
 *   3. `focus(tab)` — emit `activeTabChange$` so focusedOuterTabs picks
 *      up the tab and the immediate re-tick fires.
 *   4. `emitTick(states)` — push a TabState[] snapshot through
 *      `monitor.states$`. The harness mirrors the snapshot into
 *      `monitor.current` so the focus-triggered re-tick reads the same
 *      states the test just supplied.
 *   5. Inspect `getPersisted()` / `tab.sentInputs` / `config.saveCount` to
 *      assert the resulting persistent + transient side effects.
 *
 * Timers: scheduleResume waits 2 s before sendInput. Tests opt into
 * `vi.useFakeTimers()` at the top of the file and call
 * `harness.advance(2000)` to flush.
 */

export interface FakeTab {
    /** Test-side stable id. Production code uses object identity; the id
     *  is here so test assertions can refer to a tab by name. */
    id: string
    /** Strings passed to `innerTab.sendInput()` from scheduleResume's
     *  setTimeout callback. Production uses `${command}\r`; tests assert
     *  on the full string including the carriage return. */
    sentInputs: string[]
    customTitle: string | null
    title: string
    sendInput (s: string): void
    /** Stubs for AutoResumeService.scheduleWarmup, which emits the pair
     *  to trigger Tabby's lazy `frontend.attach` in production. Tests
     *  don't exercise the real focus side effects (no Angular tree),
     *  so these are no-ops; their presence just keeps the service's
     *  try/catch from logging "is not a function" on every warm-up. */
    emitFocused (): void
    emitBlurred (): void
}

export interface FakeStateOverrides {
    aiTool?: AiTool | null
    aiCommandLine?: string | null
    cwd?: string | null
}

/** Build a partial TabState with the fields AutoResumeService reads. Other
 *  fields (status, lastActiveMs, …) are present so the cast to TabState
 *  is type-safe; the service never touches them. */
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
    }
}

export interface AddTabOpts {
    /** Mark as a Tabby-restored tab. `'preexisting'` puts it in `app.tabs`
     *  before the service constructs (covers the recoverTabs-finished-first
     *  race); `'opened'` emits `tabOpened$` within the 30 s capture window
     *  (the normal restore path). Both tag the tab as restored in
     *  `restoredOuterTabs`. */
    restored?: 'preexisting' | 'opened' | false
    /** Become `app.activeTab` immediately and fire `activeTabChange$`.
     *  Used to seed the originally-active restored tab so its focus event
     *  is observable from the service's subscription. */
    active?: boolean
    title?: string
}

export class AutoResumeHarness {
    readonly config = {
        store: {
            ai: {
                autoResumeAgents: true as boolean,
                autoResumeCommandByCwd: {} as Record<string, string | { command: string; count: number }>,
            },
        },
        saveCount: 0,
        save: vi.fn(async () => { /* counted via saveCount in the closure below */ }),
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

    /** Optional pre-seeded persisted entries — applied to
     *  `config.store.ai.autoResumeCommandByCwd` before construction so the
     *  service sees them on its first state emission. Mirrors what
     *  `ConfigService` would expose after Tabby loaded the on-disk config. */
    constructor (opts: {
        autoResumeAgents?: boolean
        persisted?: Record<string, string | { command: string; count: number }>
        preexistingTabs?: AddTabOpts[]
    } = {}) {
        if (opts.autoResumeAgents !== undefined) {
            this.config.store.ai.autoResumeAgents = opts.autoResumeAgents
        }
        if (opts.persisted) {
            this.config.store.ai.autoResumeCommandByCwd = { ...opts.persisted }
        }
        // Bump saveCount on each save so tests can assert "we wrote the
        // config N times" without dragging the mock through vi.fn's
        // calls.length API. Replaces the bare placeholder above.
        this.config.save = vi.fn(async () => {
            this.config.saveCount++
        })
        // Pre-add tabs BEFORE construction so they end up in
        // `restoredOuterTabs` via the "already in app.tabs" path. The
        // active flag is honoured here so the seed of `app.activeTab`
        // catches it.
        if (opts.preexistingTabs) {
            for (const t of opts.preexistingTabs) {
                const tab = this.makeTab(t.title)
                this.app.tabs.push(tab)
                if (t.active) this.app.activeTab = tab
            }
        }
    }

    /** Construct the service. Call after the optional pre-existing-tab
     *  setup but before exercising any state transitions. */
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
     *  before or after — the harness emits `tabOpened$` in both cases so
     *  the service subscription picks it up. */
    addTab (opts: AddTabOpts = {}): FakeTab {
        const tab = this.makeTab(opts.title)
        if (opts.restored === 'preexisting') {
            // Caller is using the pre-construction path; just append.
            // The constructor will sweep `app.tabs` into `restoredOuterTabs`.
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

    /** Push a snapshot through `monitor.states$` and update
     *  `monitor.current` to match — so the focus-triggered immediate
     *  re-tick reads the same states. */
    emitTick (states: TabState[]): void {
        this.monitor.current = states
        this.monitor.states$.next(states)
    }

    /** Fast-forward the fake timer past RESUME_DELAY_MS. Tests opting in
     *  to fake timers call this after scheduling a replay. */
    advance (ms: number): void {
        vi.advanceTimersByTime(ms)
    }

    /** Snapshot of `config.store.ai.autoResumeCommandByCwd` after parsing
     *  each entry. Hides the legacy-string/object union from assertions. */
    getPersisted (): Record<string, { command: string; count: number } | string> {
        return { ...this.config.store.ai.autoResumeCommandByCwd }
    }

    private makeTab (title?: string): FakeTab {
        const id = `tab-${++this.nextId}`
        const tab: FakeTab = {
            id,
            sentInputs: [],
            customTitle: null,
            title: title ?? id,
            sendInput (s: string) { this.sentInputs.push(s) },
            emitFocused () { /* no-op stub — see FakeTab docstring */ },
            emitBlurred () { /* no-op stub — see FakeTab docstring */ },
        }
        return tab
    }
}
