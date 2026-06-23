import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, NotificationsService, TabRecoveryService } from 'tabby-core'

import { WorktreeService, WorktreeSet } from './worktree.service'

/** A tracked worktree tab: the set + the inner terminal leaf (for the
 *  still-alive-session move guard — see onTabRemoved). */
interface TrackedTab {
    set: WorktreeSet
    /** A terminal leaf of this worktree tab whose session owns the isolated cwd. */
    inner: BaseTabComponent
}

/**
 * Owns the live tab → worktree-set map for this session and the anti-sprawl
 * cleanup: when a worktree-backed tab closes, the set is removed IF it's safe
 * (clean working tree + no unmerged commits), otherwise kept with a toast. So
 * reflexive open/close leaves zero worktrees, but work is never silently
 * dropped. See `internal/todo-worktree-isolation.md` (lifecycle).
 *
 * KEYED BY + TRIGGERED ON THE TOP-LEVEL (outer) tab via `AppService.tabRemoved$`.
 * `tabRemoved$` fires only when a top-level tab is removed — i.e. when the WHOLE
 * worktree tab closes. A SplitTabComponent auto-destroys once its last pane
 * closes, so this still fires for the common single-pane tab. Crucially, closing
 * just ONE pane of a multi-pane worktree split does NOT fire it (the split
 * survives) → we never delete a worktree another live pane (e.g. the agent) is
 * still working in. (Earlier this triggered on the inner leaf's destroyed$ to
 * also reclaim a single-pane close, but that let a split where the reaper had
 * tracked a *shell* pane delete the worktree out from under the agent pane —
 * data loss. The safe trade-off: a closed-pane-in-a-surviving-split worktree is
 * KEPT until the split fully closes; the reaper / manager panel reclaim it.)
 *
 * Three ways a tab leaves, three outcomes:
 *  - APP QUIT — `closeWindow()` sets `TabRecoveryService.enabled = false` before
 *    destroying every tab, and destruction is what fires `tabRemoved$`. So
 *    `enabled === false` ⇒ quitting ⇒ KEEP (the tab resumes next launch; the
 *    on-disk worktree survives any app death, and Tabby's recovery token carries
 *    the isolated cwd).
 *  - MOVE TO NEW WINDOW — `moveTabToNewWindow()` calls `releaseSession()` (sets
 *    `sessionReused`, so `destroy()` SKIPS `session.destroy()` and the PTY keeps
 *    running) then destroys the source tab with `enabled === true`. The split
 *    tears down its terminal children before emitting its own `destroyed$`, so by
 *    `tabRemoved$` a genuine close has already run `session.destroy()` →
 *    `session.open === false`, whereas a released/moved session is still
 *    `open === true`. So `inner.session.open` truthy ⇒ KEEP. Bias is safe: only a
 *    clean (no-data) close is ever removed.
 *  - USER CLOSE — app running, session torn down → remove IF safe.
 *
 * Scope (P1): the map is in-memory. A worktree tab recovered from a previous
 * launch is re-registered by the startup reaper (cwd match); anything it can't
 * reclaim is left for the manager panel (P2c).
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
     * Associate a worktree tab with its set.
     * @param outer the TOP-LEVEL tab (what tabRemoved$ emits / the badge reads)
     * @param inner a terminal leaf whose session owns the isolated cwd (move guard)
     */
    register (outer: BaseTabComponent, set: WorktreeSet, inner: BaseTabComponent): void {
        this.tracked.set(outer, { set, inner })
    }

    /** Branch name for a tab's worktree set, for the sidebar badge — else null. */
    branchForTab (tab: BaseTabComponent): string | null {
        return this.tracked.get(tab)?.set.branch ?? null
    }

    private async onTabRemoved (outer: BaseTabComponent): Promise<void> {
        const entry = this.tracked.get(outer)
        if (!entry) {
            return
        }
        this.tracked.delete(outer)

        // App quitting → keep so the tab resumes next launch.
        if (!this.tabRecovery.enabled) {
            return
        }
        // Session still alive ⇒ released to another window (move), not closed → keep.
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
