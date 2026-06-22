import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { AppService, BaseTabComponent } from 'tabby-core'

import { TabMonitor, TabStatus } from './tab-monitor'
import { HookWatcherService } from './hook-watcher.service'

/**
 * Fast path for the "ESC while LLM is thinking leaves the row stuck on
 * working" bug. The agent CLIs (claude, codex, gemini, opencode) all run on
 * raw-mode stdin and treat a bare ESC as their interrupt key. They abort
 * the in-flight LLM/SSE request and the running tool subprocess locally,
 * but during the LLM-thinking window they fire no hook event at all — so
 * HookWatcher never sees the transition back to idle.
 *
 * This service sits on the same byte stream the CLI reads (pty input, via
 * Tabby's `frontend.input$`) and synthesises an Idle snapshot when it sees
 * a real ESC press. Agent-agnostic because the signal source is terminal
 * convention, not agent protocol — one sniffer fixes every adapter.
 *
 * The disambiguator (`feedEscSniffer`) is a pure function exported for
 * unit tests covering bare ESC vs Alt/arrow/F-key escape sequences vs
 * pasted-content-containing-ESC.
 */

/** xterm-line-discipline ESC timeout: bytes after `\x1b` within this
 *  window mean we're inside a Meta/Alt/CSI sequence, not a bare ESC. 50 ms
 *  matches readline / xterm / ncurses default. */
export const ESC_TIMEOUT_MS = 50

/** The single-byte ESC code. */
export const ESC_BYTE = 0x1b

/**
 * Mutable state held per-stream by the sniffer. A field, not a closure,
 * because both the timer and the in-flight arm flag must be inspectable
 * (and clearable) from outside the byte handler — see attach/detach.
 */
export interface EscSnifferState {
    /** Active arm-timer for a possibly-bare ESC. Null when not armed. */
    timer: ReturnType<typeof setTimeout> | null
}

/**
 * Pure stream-event handler. Feed every chunk that arrives on the pty
 * input stream; `onConfirmed` fires after a bare ESC stays bare for
 * `timeoutMs`. Test-friendly: pass a mocked `setTimer` for synchronous
 * scheduling, or use the default (real timers).
 */
export function feedEscSniffer (
    state: EscSnifferState,
    chunk: Uint8Array,
    onConfirmed: () => void,
    timeoutMs: number = ESC_TIMEOUT_MS,
    setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h: ReturnType<typeof setTimeout>) => void = h => clearTimeout(h),
): void {
    // Any incoming bytes cancel a pending arm — the bytes after \x1b are
    // the tail of a Meta/CSI sequence, so the original \x1b was never a
    // bare ESC press.
    if (state.timer !== null) {
        clearTimer(state.timer)
        state.timer = null
    }
    // Bare ESC = exactly one byte and it is 0x1b. We deliberately do NOT
    // try to interpret multi-byte chunks containing 0x1b — e.g. a paste
    // of `\x1b[A` arrives as one chunk and must not be misread as ESC.
    if (chunk.length === 1 && chunk[0] === ESC_BYTE) {
        state.timer = setTimer(() => {
            state.timer = null
            onConfirmed()
        }, timeoutMs)
    }
}

interface TabBinding {
    sub: Subscription
    state: EscSnifferState
}

@Injectable({ providedIn: 'root' })
export class EscInterruptService implements OnDestroy {
    private bindings = new WeakMap<BaseTabComponent, TabBinding>()
    private rootSubs: Subscription[] = []

    constructor (
        private app: AppService,
        private monitor: TabMonitor,
        private hooks: HookWatcherService,
    ) {
        for (const tab of this.app.tabs) this.attachAll(tab)
        // Tab open / split add / split remove / tab close all funnel through
        // tabsChanged$ — the same hook TabMonitor uses for refresh. We
        // re-walk the whole tab list each tick because attachOne is
        // idempotent (the WeakMap guard short-circuits already-bound tabs),
        // and detach happens lazily via tabRemoved$.
        this.rootSubs.push(this.app.tabsChanged$.subscribe(() => {
            for (const tab of this.app.tabs) this.attachAll(tab)
        }))
        this.rootSubs.push(this.app.tabRemoved$.subscribe(tab => this.detachAll(tab)))
    }

    ngOnDestroy (): void {
        for (const s of this.rootSubs) s.unsubscribe()
    }

    private attachAll (tab: BaseTabComponent): void {
        // SplitTabComponent wraps multiple leaves — each has its own
        // frontend.input$. Duck-type via getAllTabs() to dodge the cross-
        // realm instanceof trap that bites tab-monitor for the same reason.
        const anyTab = tab as any
        if (typeof anyTab.getAllTabs === 'function') {
            for (const leaf of anyTab.getAllTabs()) this.attachOne(leaf)
        } else {
            this.attachOne(tab)
        }
    }

    private attachOne (innerTab: BaseTabComponent): void {
        if (this.bindings.has(innerTab)) return
        const tabAny = innerTab as unknown as {
            frontend?: { input$?: { subscribe: (fn: (v: unknown) => void) => Subscription } }
        }
        const input$ = tabAny.frontend?.input$
        if (!input$) return
        const state: EscSnifferState = { timer: null }
        const sub = input$.subscribe(raw => {
            const chunk = toBytes(raw)
            if (!chunk) return
            feedEscSniffer(state, chunk, () => this.onConfirmedEsc(innerTab))
        })
        this.bindings.set(innerTab, { sub, state })
    }

    private detachAll (tab: BaseTabComponent): void {
        const anyTab = tab as any
        if (typeof anyTab.getAllTabs === 'function') {
            for (const leaf of anyTab.getAllTabs()) this.detachOne(leaf)
        }
        this.detachOne(tab)
    }

    private detachOne (innerTab: BaseTabComponent): void {
        const binding = this.bindings.get(innerTab)
        if (!binding) return
        if (binding.state.timer !== null) {
            clearTimeout(binding.state.timer)
            binding.state.timer = null
        }
        binding.sub.unsubscribe()
        this.bindings.delete(innerTab)
    }

    private onConfirmedEsc (innerTab: BaseTabComponent): void {
        const tabState = this.monitor.current.find(s => s.innerTab === innerTab)
        if (!tabState) return
        // Working: ESC interrupts in-flight LLM/tool work (no hook fires).
        // NeedsPermission: ESC cancels the permission prompt → agent returns to
        // idle (also no clearing hook) — without this the row stuck on
        // `needs_permission`. forceIdle self-corrects if the agent continues.
        if (tabState.status !== TabStatus.Working && tabState.status !== TabStatus.NeedsPermission) return
        if (!tabState.tabId) return
        this.hooks.forceIdle(tabState.tabId, 'user-esc')
    }
}

/**
 * Normalise whatever Tabby's `frontend.input$` emits to a byte view. Some
 * frontends emit Buffer, some emit string (xterm.js' onData). Anything
 * else (null, object) is ignored.
 */
function toBytes (raw: unknown): Uint8Array | null {
    if (raw instanceof Uint8Array) return raw
    if (typeof raw === 'string') return Buffer.from(raw, 'utf8')
    return null
}
