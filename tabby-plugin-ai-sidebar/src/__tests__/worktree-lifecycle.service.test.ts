import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Subject } from 'rxjs'

import { WorktreeLifecycleService } from '../worktree-lifecycle.service'
import { WorktreeSet } from '../worktree.service'

/**
 * Unit-tests the anti-sprawl decision, driven by AppService.tabRemoved$ (the
 * TOP-LEVEL tab removal — so a single-pane close in a surviving split never
 * reaches here, which is what keeps us from deleting a worktree another live
 * pane still uses). WorktreeService is a spy; we assert only the branching:
 *   close + safe          → removeSet + "Tidied"
 *   close + unsafe        → keep + "Kept"
 *   app quit (recov off)  → keep, no removeSet
 *   moved (session open)  → keep, no removeSet
 *   unregistered tab      → no-op
 *
 * `session.open` is false on a genuine close (session.destroy ran before the
 * split emitted its own destroyed$/tabRemoved$) and true on a move (release kept
 * the PTY), so the inner stub carries it directly.
 */
function makeSet (branch: string): WorktreeSet {
    return { root: '/ws', isolatedRoot: '/managed/ws/' + branch, branch, repos: [] }
}
/** Inner-leaf stub: session.open at tabRemoved$ time (false=closed, true=moved). */
function inner (open: boolean): any {
    return { session: { open } }
}

const flush = () => new Promise(r => setTimeout(r, 0)) // let the async handler settle

describe('WorktreeLifecycleService', () => {
    let tabRemoved$: Subject<any>
    let worktree: { isSetSafeToRemove: ReturnType<typeof vi.fn>, removeSet: ReturnType<typeof vi.fn> }
    let notifications: { info: ReturnType<typeof vi.fn>, error: ReturnType<typeof vi.fn> }
    let recovery: { enabled: boolean }
    let svc: WorktreeLifecycleService

    beforeEach(() => {
        tabRemoved$ = new Subject()
        worktree = { isSetSafeToRemove: vi.fn(), removeSet: vi.fn().mockResolvedValue(undefined) }
        notifications = { info: vi.fn(), error: vi.fn() }
        recovery = { enabled: true } // app running (not quitting)
        svc = new WorktreeLifecycleService({ tabRemoved$ } as any, worktree as any, notifications as any, recovery as any)
    })

    it('exposes the branch for a registered (outer) tab, null otherwise', () => {
        const outer = {} as any
        expect(svc.branchForTab(outer)).toBeNull()
        svc.register(outer, makeSet('agent/x'), inner(false))
        expect(svc.branchForTab(outer)).toBe('agent/x')
    })

    it('closing a CLEAN worktree tab → removeSet + "Tidied" toast', async () => {
        const outer = {} as any
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/clean'), inner(false))
        tabRemoved$.next(outer)
        await flush()
        expect(worktree.removeSet).toHaveBeenCalledTimes(1)
        expect(notifications.info).toHaveBeenCalledWith(expect.stringMatching(/Tidied worktree agent\/clean/))
        expect(svc.branchForTab(outer)).toBeNull() // badge dropped
    })

    it('closing a DIRTY worktree tab → kept, removeSet NOT called', async () => {
        const outer = {} as any
        worktree.isSetSafeToRemove.mockResolvedValue(false)
        svc.register(outer, makeSet('agent/dirty'), inner(false))
        tabRemoved$.next(outer)
        await flush()
        expect(worktree.removeSet).not.toHaveBeenCalled()
        expect(notifications.info).toHaveBeenCalledWith(expect.stringMatching(/Kept worktree agent\/dirty/))
    })

    it('app QUITTING (recovery disabled) → keep even a clean set, never removeSet', async () => {
        const outer = {} as any
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/quit'), inner(false))
        recovery.enabled = false // closeWindow() disabled recovery before destroying tabs
        tabRemoved$.next(outer)
        await flush()
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('MOVED to a new window (session still open) → keep, never removeSet', async () => {
        const outer = {} as any
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/move'), inner(true)) // PTY kept alive by releaseSession
        tabRemoved$.next(outer)
        await flush()
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('tabRemoved$ for an UNREGISTERED tab (e.g. a non-outer pane) is a no-op', async () => {
        tabRemoved$.next({} as any)
        await flush()
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('a removeSet failure is swallowed (never throws out of the subscription)', async () => {
        const outer = {} as any
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        worktree.removeSet.mockRejectedValue(new Error('git boom'))
        svc.register(outer, makeSet('agent/boom'), inner(false))
        expect(() => { tabRemoved$.next(outer) }).not.toThrow()
        await flush()
        expect(worktree.removeSet).toHaveBeenCalled()
    })
})
