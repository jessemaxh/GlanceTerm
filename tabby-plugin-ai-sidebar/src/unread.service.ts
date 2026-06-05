import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subscription } from 'rxjs'

import { AppService, BaseTabComponent, HostWindowService } from 'tabby-core'

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
 * Cleared when the user focuses the tab (activeTabChange or window focus),
 * or when the tab is closed.
 */
@Injectable({ providedIn: 'root' })
export class UnreadService implements OnDestroy {
    private unread = new Set<BaseTabComponent>()
    private subject = new BehaviorSubject<number>(0)
    private subs: Subscription[] = []
    private dock: { setBadge: (s: string) => void } | null = null

    /** Latest count of unseen-ready tabs. Observable for any reactive consumer. */
    readonly count$: Observable<number> = this.subject.asObservable()

    constructor (
        private app: AppService,
        hostWindow: HostWindowService,
    ) {
        // Clearing rules — see class doc.
        this.subs.push(this.app.activeTabChange$.subscribe(tab => {
            if (tab) this.clearTabAndChildren(tab)
        }))
        this.subs.push(hostWindow.windowFocused$.subscribe(() => {
            if (this.app.activeTab) this.clearTabAndChildren(this.app.activeTab)
        }))
        // Don't leak entries for tabs the user closed before reading them.
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
     * Mark a tab's last working→ready transition as "unseen". Idempotent —
     * a second call while the tab is still unread is a no-op (no extra emit).
     * Callers should NOT mark a tab the user is currently looking at; the
     * point of the badge is to surface what they missed.
     */
    markReady (innerTab: BaseTabComponent): void {
        if (this.unread.has(innerTab)) return
        this.unread.add(innerTab)
        this.emit()
    }

    /** Sync check used by the sidebar template's red-dot binding. */
    isUnread (innerTab: BaseTabComponent): boolean {
        return this.unread.has(innerTab)
    }

    get count (): number {
        return this.subject.value
    }

    /**
     * Drop the tab AND any leaves it contains (SplitTabComponent wraps
     * multiple terminal leaves; clicking the outer should clear them all).
     * Duck-typed via `getAllTabs()` to dodge the cross-module-realm
     * `instanceof` trap that already bites tab-monitor.
     */
    private clearTabAndChildren (tab: BaseTabComponent): void {
        let changed = this.unread.delete(tab)
        const anyTab = tab as any
        if (typeof anyTab.getAllTabs === 'function') {
            for (const leaf of anyTab.getAllTabs()) {
                if (this.unread.delete(leaf)) changed = true
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
