import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { randomUUID } from 'crypto'

import { AppService, BaseTabComponent } from 'tabby-core'

/**
 * One snapshot row published by {@link TabIdentityService.identities$}.
 * `uuid` is the routing key (stable across reorder); `displayIndex` is the
 * human-facing #N that matches the sidebar (1-based, recomputed on every
 * tab list change); `name` is `BaseTabComponent.title` at snapshot time.
 *
 * Title is a snapshot, not live — Forum Topic / 飞书卡片 titles re-sync
 * the next time the tab list changes, which is good enough for a label
 * the IM side just renders for human reading.
 */
export interface TabIdentity {
    uuid: string
    displayIndex: number
    name: string
}

/**
 * Session-stable UUID per tab. Routing keys for the mobile bridge MUST
 * use these, not `AppService.tabs.indexOf(tab)` — the latter shifts on
 * any drag/reorder, which would silently misroute IM replies to the
 * wrong tab.
 *
 * Lifecycle: UUID is assigned when a tab first appears (constructor sweep
 * for tabs already open at startup, plus `tabOpened$` going forward), and
 * forgotten when `tabClosed$` fires. A reopened "same" tab gets a NEW
 * UUID — the IM side will create a new Forum Topic / card for it.
 *
 * WeakMap for `uuidByTab` lets the tab instance be GC'd cleanly when
 * closed; `tabByUuid` is a strong Map and is explicitly cleared on close.
 */
@Injectable()
export class TabIdentityService {
    private uuidByTab = new WeakMap<BaseTabComponent, string>()
    private tabByUuid = new Map<string, BaseTabComponent>()
    private identitiesSubject = new BehaviorSubject<TabIdentity[]>([])

    constructor (private app: AppService) {
        for (const tab of app.tabs) this.assign(tab)
        this.recompute()

        app.tabOpened$.subscribe(tab => {
            this.assign(tab)
            this.recompute()
        })
        app.tabClosed$.subscribe(tab => {
            const uuid = this.uuidByTab.get(tab)
            if (uuid !== undefined) this.tabByUuid.delete(uuid)
            this.recompute()
        })
        // Reorder doesn't fire tabOpened/tabClosed — only tabsChanged. Without
        // this subscription `displayIndex` would freeze at the first-seen order.
        app.tabsChanged$.subscribe(() => this.recompute())
    }

    /** Identities for every currently-open tab, in sidebar order. */
    get identities$ (): Observable<TabIdentity[]> { return this.identitiesSubject }

    /** Snapshot of the current identities — for one-shot lookups. */
    get current (): TabIdentity[] { return this.identitiesSubject.value }

    /** UUID → tab. Returns `undefined` if the tab has been closed. */
    tabOf (uuid: string): BaseTabComponent | undefined {
        return this.tabByUuid.get(uuid)
    }

    /** Tab → UUID. Returns `undefined` for tabs not yet seen (race window). */
    uuidOf (tab: BaseTabComponent): string | undefined {
        return this.uuidByTab.get(tab)
    }

    private assign (tab: BaseTabComponent): void {
        if (this.uuidByTab.has(tab)) return
        const uuid = randomUUID()
        this.uuidByTab.set(tab, uuid)
        this.tabByUuid.set(uuid, tab)
    }

    private recompute (): void {
        const rows: TabIdentity[] = this.app.tabs.map((tab, i) => ({
            uuid: this.uuidByTab.get(tab) ?? this.lazyAssign(tab),
            displayIndex: i + 1,
            name: tab.title,
        }))
        this.identitiesSubject.next(rows)
    }

    /**
     * Defensive fallback for the rare race where a tab is reachable via
     * `app.tabs` but neither tabOpened$ nor the constructor sweep has
     * touched it yet. Caller of recompute() can't tell the difference
     * between "missed an emission" and "we haven't seen this one yet" —
     * lazy-assign on the way out keeps the published identities consistent.
     */
    private lazyAssign (tab: BaseTabComponent): string {
        this.assign(tab)
        return this.uuidByTab.get(tab)!
    }
}
