import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { BaseTabComponent, NotificationsService, TabRecoveryService } from 'tabby-core'

import { WorktreeService, WorktreeSet } from './worktree.service'

/** A tracked worktree tab. */
interface TrackedTab {
    set: WorktreeSet
    /** The inner BaseTerminalTabComponent whose session owns the isolated cwd. */
    inner: BaseTabComponent
    /** destroyed$ subscription on `inner` — the universal close signal. */
    sub: Subscription
}

/**
 * Owns the live tab → worktree-set map for this session and the anti-sprawl
 * cleanup: when a worktree-backed tab closes, the set is removed IF it's safe
 * (clean working tree + no unmerged commits), otherwise kept with a toast. So
 * reflexive open/close leaves zero worktrees, but work is never silently
 * dropped. See `internal/todo-worktree-isolation.md` (lifecycle).
 *
 * KEYED BY THE TOP-LEVEL (outer) tab so `branchForTab(TabState.outerTab)` lights
 * the sidebar badge, but cleanup is driven by the INNER terminal leaf's
 * `destroyed$` — NOT `AppService.tabRemoved$`. tabRemoved$ only emits when a
 * TOP-LEVEL tab goes away, so closing a single worktree pane inside a still-open
 * split would never fire it and the worktree would leak. The inner leaf's
 * `destroyed$` fires in EVERY teardown path (whole-tab close, inner-pane close,
 * move-to-new-window, app quit), so it's the one universal signal.
 *
 * Timing: the inner's `destroyed$` fires from `super.destroy()` BEFORE
 * `destroy()` reaches `await session.destroy()`, so `session.open` is still true
 * at the synchronous instant of the event. We defer one microtask — by then the
 * synchronous continuation of `destroy()` has run `session.destroy()`, which
 * sets `open = false` synchronously (tabby-terminal/src/session.ts:85) before
 * its first await. So at decision time:
 *  - GENUINE CLOSE — `session.destroy()` ran → `open === false` → remove if safe.
 *  - MOVE TO NEW WINDOW — `releaseSession()` set `sessionReused`, so `destroy()`
 *    SKIPS `session.destroy()` and the PTY keeps running for the new window →
 *    `open === true` → KEEP (never delete a worktree a live tab is using).
 *  - APP QUIT — `closeWindow()` set `TabRecoveryService.enabled = false` before
 *    destroying tabs → KEEP so the tab resumes next launch (the on-disk worktree
 *    survives any app death; Tabby's recovery token carries the isolated cwd).
 * The bias is safe: only a clean (no-data) close is ever removed.
 *
 * Scope (P1): the map is in-memory, so it tracks only tabs opened this session.
 * A worktree tab recovered from a previous launch is not tracked — its badge is
 * absent and closing it won't auto-clean; the startup reaper (P2) sweeps those
 * (and anything this keeps).
 */
@Injectable()
export class WorktreeLifecycleService {
    private tracked = new Map<BaseTabComponent, TrackedTab>()

    constructor (
        private worktree: WorktreeService,
        private notifications: NotificationsService,
        private tabRecovery: TabRecoveryService,
    ) { }

    /**
     * Associate a freshly-opened worktree tab with its set.
     * @param outer the TOP-LEVEL tab (the badge reads `TabState.outerTab`)
     * @param inner the inner terminal leaf whose session owns the isolated cwd
     */
    register (outer: BaseTabComponent, set: WorktreeSet, inner: BaseTabComponent): void {
        // Idempotent: the startup reaper may re-attach a tab already tracked this
        // session — tear down the old subscription so we never double-subscribe.
        this.tracked.get(outer)?.sub.unsubscribe()
        const sub = inner.destroyed$.subscribe(() => { void this.onTabGone(outer) })
        this.tracked.set(outer, { set, inner, sub })
    }

    /** Branch name for a tab's worktree set, for the sidebar badge — else null. */
    branchForTab (tab: BaseTabComponent): string | null {
        return this.tracked.get(tab)?.set.branch ?? null
    }

    private async onTabGone (outer: BaseTabComponent): Promise<void> {
        const entry = this.tracked.get(outer)
        if (!entry) {
            return
        }
        // Drop tracking + the badge immediately (the tab is gone either way).
        this.tracked.delete(outer)
        entry.sub.unsubscribe()

        // Let destroy()'s synchronous continuation run session.destroy() (which
        // sets session.open=false before its first await) before we read it.
        await Promise.resolve()

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
            // Never let cleanup throw out of the destroyed$ subscription; on any
            // error the worktree simply stays on disk for the reaper to reconcile.
        }
    }
}
