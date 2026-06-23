import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, NotificationsService, TabRecoveryService } from 'tabby-core'

import { WorktreeService, WorktreeSet } from './worktree.service'

/** A tracked worktree tab: the set plus the inner terminal leaf (for the
 *  still-alive-session move guard — see onTabRemoved). */
interface TrackedTab {
    set: WorktreeSet
    /** The inner BaseTerminalTabComponent whose session owns the isolated cwd. */
    inner: BaseTabComponent
}

/**
 * Owns the live tab → worktree-set map for this session and the anti-sprawl
 * cleanup: when the user closes a worktree-backed tab, the set is removed IF
 * it's safe (clean working tree + no unmerged commits), otherwise kept with a
 * toast. So reflexive open/close leaves zero worktrees, but work is never
 * silently dropped. See `internal/todo-worktree-isolation.md` (lifecycle).
 *
 * KEYED BY THE TOP-LEVEL (outer) tab. `TerminalService.openTab()` returns the
 * inner leaf, but `AppService.tabRemoved$` emits the wrapping SplitTabComponent
 * and the sidebar badge reads `TabState.outerTab` (also the split) — so the
 * opener registers `getParentTab(inner) ?? inner` and we key on that. Keying on
 * the inner leaf would make BOTH the badge and this cleanup silently miss.
 *
 * Three ways a tab leaves, three outcomes:
 *  - APP QUIT — `AppService.closeWindow()` sets `TabRecoveryService.enabled =
 *    false` immediately before destroying every tab, and tab destruction is
 *    what fires `tabRemoved$`. `enabled === false` ⇒ quitting ⇒ KEEP (the tab
 *    resumes next launch; Tabby's recovery token carries the isolated cwd and
 *    the on-disk worktree survives any app death).
 *  - MOVE TO NEW WINDOW — `moveTabToNewWindow()` calls `releaseSession()` (which
 *    sets `sessionReused`, so `destroy()` SKIPS `session.destroy()` and the PTY
 *    keeps running for the new window to adopt) and then destroys the source
 *    tab with `enabled === true`. For our always-wrapped tabs the split tears
 *    down its terminal child before emitting its own `destroyed$`, so by
 *    `tabRemoved$` a GENUINE close has already run `session.destroy()` →
 *    `session.open === false`, whereas a moved/released session is still
 *    `open === true`. So `inner.session.open` truthy ⇒ KEEP. The bias is safe:
 *    a move always keeps; only a clean (no-data) close can ever be removed.
 *  - USER CLOSE — app still running, session torn down → remove IF safe.
 *
 * Scope (P1): the map is in-memory, so it tracks only tabs opened this session.
 * A worktree tab recovered from a previous launch is not in the map — its badge
 * is absent and closing it won't auto-clean; the startup reaper (P2) is the
 * designed sweep for those (and for anything this keeps).
 */
@Injectable()
export class WorktreeLifecycleService {
    private tracked = new Map<BaseTabComponent, TrackedTab>()

    constructor (
        app: AppService,
        private worktree: WorktreeService,
        private notifications: NotificationsService,
        private tabRecovery: TabRecoveryService,
    ) {
        app.tabRemoved$.subscribe(tab => { void this.onTabRemoved(tab) })
    }

    /**
     * Associate a freshly-opened worktree tab with its set.
     * @param outer the TOP-LEVEL tab (what tabRemoved$ emits / the badge reads)
     * @param inner the inner terminal leaf whose session owns the isolated cwd
     */
    register (outer: BaseTabComponent, set: WorktreeSet, inner: BaseTabComponent): void {
        this.tracked.set(outer, { set, inner })
    }

    /** Branch name for a tab's worktree set, for the sidebar badge — else null. */
    branchForTab (tab: BaseTabComponent): string | null {
        return this.tracked.get(tab)?.set.branch ?? null
    }

    private async onTabRemoved (tab: BaseTabComponent): Promise<void> {
        const entry = this.tracked.get(tab)
        if (!entry) {
            return
        }
        this.tracked.delete(tab)

        // App is quitting (closeWindow disabled recovery before destroying tabs)
        // → keep the worktree so the tab resumes next launch.
        if (!this.tabRecovery.enabled) {
            return
        }

        // Session still alive ⇒ released to another window (move-to-new-window),
        // not closed → keep so we never delete a worktree a live tab is using.
        const sessionStillOpen = (entry.inner as unknown as { session?: { open?: boolean } }).session?.open === true
        if (sessionStillOpen) {
            return
        }

        try {
            if (await this.worktree.isSetSafeToRemove(entry.set)) {
                await this.worktree.removeSet(entry.set) // non-force: atomic, never drops work
                this.notifications.info(`Tidied worktree ${entry.set.branch}`)
            } else {
                this.notifications.info(`Kept worktree ${entry.set.branch} — it has unsaved or unmerged work`)
            }
        } catch {
            // Never let cleanup throw out of the tabRemoved$ subscription; on any
            // error the worktree simply stays on disk for the reaper to reconcile.
        }
    }
}
