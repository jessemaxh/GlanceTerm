import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subscription } from 'rxjs'

import { AppService, BaseTabComponent } from 'tabby-core'

/**
 * Tracks "AI just finished, you haven't looked" — emitted when a tab
 * transitions `working → idle` (after the notifier's stability gate) AND the
 * user wasn't already looking at it. Drives three UI surfaces:
 *
 *   1. red dot on the sidebar row
 *   2. count badge on the AI-Tabs toolbar button (consumed by the toolbar
 *      button's `icon` getter — see index.ts)
 *   3. macOS Dock badge with the total count (best-effort, no-op on web
 *      and non-mac platforms)
 *
 * Clearing model — IM-style "content engagement", not "tab focus":
 *
 * Pre-fix the badge cleared on `activeTabChange$` and `windowFocused$` —
 * a quick "did I miss something?" sidebar click would clear the badge
 * before the user actually saw the agent's output, which is exactly the
 * surprise WeChat/iMessage avoid (opening a chat does NOT mark messages
 * read; scrolling to the content does).
 *
 * Now: a per-unread-tab listener arms on `markReady()` and clears only
 * when the user actively engages with the terminal content:
 *
 *   - `frontend.input$`         — typing into the terminal
 *   - `mouseEvent$` 'mousewheel'— scroll wheel on the terminal body
 *   - `mouseEvent$ 'mousedown'  — click inside the terminal (text
 *     selection / cursor positioning — still a real "I'm reading" signal)
 *
 * Switching to the tab from the sidebar, or returning to the GlanceTerm
 * window from another app, does NOT clear by itself — the user has to
 * actually look at the content.
 *
 * Tab close still clears (otherwise we'd leak strong refs to destroyed
 * tabs in `unread`).
 */
@Injectable({ providedIn: 'root' })
export class UnreadService implements OnDestroy {
    private unread = new Set<BaseTabComponent>()
    private subject = new BehaviorSubject<number>(0)
    private subs: Subscription[] = []
    /**
     * Per-unread-tab listener watching frontend input/scroll/click. Cleared
     * (and the entry removed) on first qualifying interaction OR on tab
     * close. WeakMap so a tab destroyed before being read doesn't leak.
     */
    private clearListeners = new WeakMap<BaseTabComponent, Subscription>()
    private dock: { setBadge: (s: string) => void } | null = null

    /** Latest count of unseen-ready tabs. Observable for any reactive consumer. */
    readonly count$: Observable<number> = this.subject.asObservable()

    constructor (
        private app: AppService,
    ) {
        // Tab close: drop any unread entry AND tear down its interaction
        // listener so we don't leak a Subscription on a destroyed frontend.
        this.subs.push(this.app.tabRemoved$.subscribe(tab => this.clearTabAndChildren(tab)))

        this.dock = resolveElectronDock()
        // Push current value through to the dock so a stale badge from a
        // previous run doesn't sit on the icon at startup.
        this.subs.push(this.count$.subscribe(n => this.writeDockBadge(n)))
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
        this.writeDockBadge(0)
    }

    /**
     * Mark a tab's last working→ready transition as "unseen" and arm the
     * interaction listener that will clear it on real engagement.
     * Idempotent — a second call while the tab is still unread is a no-op
     * (no extra emit, and the listener from the first call stays armed).
     * Callers should NOT mark a tab the user is currently looking at; the
     * point of the badge is to surface what they missed.
     */
    markReady (innerTab: BaseTabComponent): void {
        if (this.unread.has(innerTab)) return
        this.unread.add(innerTab)
        this.emit()
        this.armInteractionListener(innerTab)
    }

    /** Sync check used by the sidebar template's red-dot binding. */
    isUnread (innerTab: BaseTabComponent): boolean {
        return this.unread.has(innerTab)
    }

    get count (): number {
        return this.subject.value
    }

    /**
     * Wire a one-shot listener on the tab's terminal frontend. See the class
     * docstring for the engagement-vs-focus rationale.
     *
     * Defensive on a missing frontend: if the tab's frontend isn't attached
     * yet (rare — markReady fires after working→idle, which requires the
     * session to have been live this run, which requires the frontend to
     * have been attached on first focus), skip. The badge stays put until
     * either the user closes the tab or — if the agent fires another
     * working→idle cycle later — the next markReady call (idempotent guard
     * bails out, but we re-arm anyway via `disarm + arm`).
     */
    private armInteractionListener (innerTab: BaseTabComponent): void {
        // Drop any prior subscription first — defensive against future
        // refactors that call arm() outside markReady's idempotent guard.
        const existing = this.clearListeners.get(innerTab)
        if (existing) existing.unsubscribe()

        const tab = innerTab as unknown as {
            frontend?: {
                input$?: Observable<unknown>
                mouseEvent$?: Observable<{ type: string }>
            }
        }
        const frontend = tab.frontend
        if (!frontend?.input$ || !frontend.mouseEvent$) return

        const sub = new Subscription()
        sub.add(frontend.input$.subscribe(() => this.clearOnInteraction(innerTab)))
        sub.add(frontend.mouseEvent$.subscribe(e => {
            if (e.type === 'mousewheel' || e.type === 'mousedown') {
                this.clearOnInteraction(innerTab)
            }
        }))
        this.clearListeners.set(innerTab, sub)
    }

    private clearOnInteraction (innerTab: BaseTabComponent): void {
        if (!this.unread.has(innerTab)) return
        this.unread.delete(innerTab)
        this.disarmInteractionListener(innerTab)
        this.emit()
    }

    private disarmInteractionListener (innerTab: BaseTabComponent): void {
        const sub = this.clearListeners.get(innerTab)
        if (sub) {
            sub.unsubscribe()
            this.clearListeners.delete(innerTab)
        }
    }

    /**
     * Drop the tab AND any leaves it contains (SplitTabComponent wraps
     * multiple terminal leaves; the outer being destroyed should clear
     * them all). Duck-typed via `getAllTabs()` to dodge the cross-module-
     * realm `instanceof` trap that already bites tab-monitor.
     */
    private clearTabAndChildren (tab: BaseTabComponent): void {
        let changed = this.unread.delete(tab)
        this.disarmInteractionListener(tab)
        const anyTab = tab as any
        if (typeof anyTab.getAllTabs === 'function') {
            for (const leaf of anyTab.getAllTabs()) {
                if (this.unread.delete(leaf)) changed = true
                this.disarmInteractionListener(leaf)
            }
        }
        if (changed) this.emit()
    }

    private emit (): void {
        this.subject.next(this.unread.size)
    }

    private writeDockBadge (count: number): void {
        if (!this.dock) return
        try {
            this.dock.setBadge(count > 0 ? String(count) : '')
        } catch { /* dock APIs are macOS-only, swallow on others */ }
    }
}

/**
 * Best-effort resolver for Electron's dock-badge API. Returns null on the web
 * build, on Linux/Windows (no dock), or if @electron/remote isn't reachable.
 * We deliberately avoid an import-time dependency on @electron/remote so the
 * plugin still loads on Tabby Web.
 */
function resolveElectronDock (): { setBadge: (s: string) => void } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const remote = require('@electron/remote')
        const dock = remote?.app?.dock
        if (dock && typeof dock.setBadge === 'function') {
            return dock
        }
    } catch { /* not in electron */ }
    return null
}
