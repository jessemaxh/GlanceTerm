import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable, Subscription } from 'rxjs'
import { randomUUID } from 'crypto'

import { AppService, BaseTabComponent } from 'tabby-core'

/**
 * One snapshot row published by {@link TabIdentityService.identities$}.
 * `uuid` is the routing key (stable across reorder); `displayIndex` is the
 * human-facing #N that matches the sidebar (1-based, recomputed on every
 * tab list change); `name` is `BaseTabComponent.title` at snapshot time;
 * `cwd` mirrors the shell's last-reported working directory (OSC 7) so
 * topic titles can prefer the folder name the way the sidebar does
 * (`folderName(cwd) ?? name`) instead of falling back to stub titles like
 * "Claude Code".
 *
 * Title is a snapshot, not live — Forum Topic / 飞书卡片 titles re-sync
 * the next time the tab list changes, which is good enough for a label
 * the IM side just renders for human reading.
 */
export interface TabIdentity {
    uuid: string
    displayIndex: number
    name: string
    cwd?: string
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
    /**
     * Per-tab title subscription. Without these, `identities$` would only
     * re-emit on open/close/reorder — a user renaming a tab via the
     * context menu wouldn't propagate to TopicSyncService, leaving the
     * phone-side Forum Topic title stale until the tab list mutated for
     * any other reason. Keyed on uuid (strong) so we can dispose on
     * tabClosed$.
     */
    private titleSubs = new Map<string, Subscription>()
    /**
     * Per-tab cwd subscription. Mirrors `titleSubs` for shell-reported
     * working-directory changes (OSC 7 → `session.oscProcessor.cwdReported$`).
     * Without this, a `cd` inside the terminal wouldn't propagate the new
     * folder name into the Forum Topic title until something else
     * triggered a recompute. Keyed on uuid.
     */
    private cwdSubs = new Map<string, Subscription>()

    constructor (private app: AppService) {
        for (const tab of app.tabs) this.assign(tab)
        this.recompute()

        app.tabOpened$.subscribe(tab => {
            this.assign(tab)
            this.recompute()
        })
        app.tabClosed$.subscribe(tab => {
            const uuid = this.uuidByTab.get(tab)
            if (uuid !== undefined) {
                this.tabByUuid.delete(uuid)
                this.titleSubs.get(uuid)?.unsubscribe()
                this.titleSubs.delete(uuid)
                this.cwdSubs.get(uuid)?.unsubscribe()
                this.cwdSubs.delete(uuid)
            }
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

    /**
     * Resolve a GLANCETERM_TAB_ID (the env-injected uuid that flows into
     * hook events and ~/.glanceterm/hooks/<id>.log filenames) to a sidebar
     * identity. Used by the outbound dispatcher's transcript path, where
     * the event source (TranscriptTailerService) keys on the hook tab id
     * but bindings persist topics keyed on this service's identity uuid.
     *
     * Walks app.tabs AND each split's inner panes so that a split-pane's
     * inner session is still resolvable; always returns the OUTER tab's
     * identity since that's the granularity at which we mint identities
     * (one row per app.tabs entry). For users without split panes — the
     * common case — the inner == outer branch is the hot path.
     *
     * Returns `undefined` for unknown ids (tab closed, or pre-injection
     * shell sessions that don't carry GLANCETERM_TAB_ID in env).
     */
    byHookTabId (hookTabId: string): TabIdentity | undefined {
        for (const outer of this.app.tabs) {
            const candidates: BaseTabComponent[] = [outer]
            const splitLike = outer as unknown as { getAllTabs?: () => BaseTabComponent[] }
            if (typeof splitLike.getAllTabs === 'function') {
                for (const leaf of splitLike.getAllTabs()) candidates.push(leaf)
            }
            for (const c of candidates) {
                const session = (c as unknown as { session?: { glancetermTabId?: string } }).session
                if (session?.glancetermTabId === hookTabId) {
                    const uuid = this.uuidByTab.get(outer)
                    if (uuid) return this.identitiesSubject.value.find(i => i.uuid === uuid)
                }
            }
        }
        return undefined
    }

    private assign (tab: BaseTabComponent): void {
        if (this.uuidByTab.has(tab)) return
        const uuid = randomUUID()
        this.uuidByTab.set(tab, uuid)
        this.tabByUuid.set(uuid, tab)
        // titleChange$ is distinctUntilChanged on the BaseTabComponent
        // side, so spurious re-emissions are already filtered. recompute()
        // is cheap (rebuilds a small array + BehaviorSubject.next).
        this.titleSubs.set(uuid, tab.titleChange$.subscribe(() => this.recompute()))
        // Subscribe to every terminal session inside this tab (outer +
        // split panes) so OSC-7 cwd updates propagate to the published
        // identities. Splits added after creation are not handled — the
        // common case is a single-pane terminal tab, and a `cd` in a
        // later-added pane will sync on the next tabsChanged tick anyway.
        const cwdSub = new Subscription()
        for (const leaf of this.leavesOf(tab)) {
            const cwd$ = (leaf as unknown as { session?: { oscProcessor?: { cwdReported$?: Observable<string> } } })
                .session?.oscProcessor?.cwdReported$
            if (cwd$) cwdSub.add(cwd$.subscribe(() => this.recompute()))
        }
        this.cwdSubs.set(uuid, cwdSub)
    }

    private recompute (): void {
        const rows: TabIdentity[] = this.app.tabs.map((tab, i) => ({
            uuid: this.uuidByTab.get(tab) ?? this.lazyAssign(tab),
            displayIndex: i + 1,
            name: tab.title,
            cwd: this.readCwd(tab),
        }))
        this.identitiesSubject.next(rows)
    }

    /**
     * Best-effort: walk the outer tab and its split leaves, returning the
     * first non-empty `reportedCWD`. Matches `tab-monitor.ts` extraction
     * (no async `getWorkingDirectory()` fallback — recompute() is sync and
     * cwd events themselves trigger us).
     */
    private readCwd (tab: BaseTabComponent): string | undefined {
        for (const leaf of this.leavesOf(tab)) {
            const cwd = (leaf as unknown as { session?: { reportedCWD?: string } }).session?.reportedCWD
            if (cwd) return cwd
        }
        return undefined
    }

    private leavesOf (tab: BaseTabComponent): BaseTabComponent[] {
        const splitLike = tab as unknown as { getAllTabs?: () => BaseTabComponent[] }
        if (typeof splitLike.getAllTabs === 'function') return splitLike.getAllTabs()
        return [tab]
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
