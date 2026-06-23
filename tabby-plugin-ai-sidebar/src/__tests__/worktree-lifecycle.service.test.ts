import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Subject } from 'rxjs'

import { WorktreeLifecycleService } from '../worktree-lifecycle.service'
import { WorktreeSet } from '../worktree.service'

/**
 * Unit-tests the anti-sprawl decision in isolation. The git/fs engine has its
 * own real-git integration tests; here WorktreeService is a spy so we assert
 * only the lifecycle's branching, driven by the INNER tab's destroyed$:
 *   close + safe         → removeSet + "Tidied"
 *   close + unsafe       → keep + "Kept"
 *   app quit (recov off) → keep, no removeSet
 *   moved (session open) → keep, no removeSet
 *   double destroyed$    → cleanup once (idempotent)
 *
 * Keyed by the OUTER tab (badge); the inner stub carries `destroyed$` (the
 * trigger) and `session.open` (the move guard — false once destroy() killed it).
 */
function makeSet (branch: string): WorktreeSet {
    return { root: '/ws', isolatedRoot: '/managed/ws/' + branch, branch, repos: [] }
}
/** Inner-tab stub: `open` is the session liveness at decision time. */
function inner (open: boolean): any {
    return { destroyed$: new Subject<void>(), session: { open } }
}

const flush = () => new Promise(r => setTimeout(r, 0)) // drains the handler's microtask defer

describe('WorktreeLifecycleService', () => {
    let worktree: { isSetSafeToRemove: ReturnType<typeof vi.fn>, removeSet: ReturnType<typeof vi.fn> }
    let notifications: { info: ReturnType<typeof vi.fn>, error: ReturnType<typeof vi.fn> }
    let recovery: { enabled: boolean }
    let svc: WorktreeLifecycleService

    beforeEach(() => {
        worktree = { isSetSafeToRemove: vi.fn(), removeSet: vi.fn().mockResolvedValue(undefined) }
        notifications = { info: vi.fn(), error: vi.fn() }
        recovery = { enabled: true } // app running (not quitting)
        svc = new WorktreeLifecycleService(worktree as any, notifications as any, recovery as any)
    })

    it('exposes the branch for a registered (outer) tab, null otherwise', () => {
        const outer = {} as any
        expect(svc.branchForTab(outer)).toBeNull()
        svc.register(outer, makeSet('agent/x'), inner(false))
        expect(svc.branchForTab(outer)).toBe('agent/x')
    })

    it('closing a CLEAN worktree tab → removeSet + "Tidied" toast', async () => {
        const outer = {} as any; const leaf = inner(false)
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/clean'), leaf)
        leaf.destroyed$.next()
        await flush()
        expect(worktree.removeSet).toHaveBeenCalledTimes(1)
        expect(notifications.info).toHaveBeenCalledWith(expect.stringMatching(/Tidied worktree agent\/clean/))
        expect(svc.branchForTab(outer)).toBeNull() // badge dropped
    })

    it('closing a DIRTY worktree tab → kept, removeSet NOT called', async () => {
        const outer = {} as any; const leaf = inner(false)
        worktree.isSetSafeToRemove.mockResolvedValue(false)
        svc.register(outer, makeSet('agent/dirty'), leaf)
        leaf.destroyed$.next()
        await flush()
        expect(worktree.removeSet).not.toHaveBeenCalled()
        expect(notifications.info).toHaveBeenCalledWith(expect.stringMatching(/Kept worktree agent\/dirty/))
    })

    it('app QUITTING (recovery disabled) → keep even a clean set, never removeSet', async () => {
        const outer = {} as any; const leaf = inner(false)
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/quit'), leaf)
        recovery.enabled = false // closeWindow() disabled recovery before destroying tabs
        leaf.destroyed$.next()
        await flush()
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('MOVED to a new window (session still open) → keep, never removeSet', async () => {
        const outer = {} as any; const leaf = inner(true) // PTY kept alive by releaseSession
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/move'), leaf)
        leaf.destroyed$.next()
        await flush()
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('a second destroyed$ for the same tab is a no-op (idempotent)', async () => {
        const outer = {} as any; const leaf = inner(false)
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/dup'), leaf)
        leaf.destroyed$.next()
        leaf.destroyed$.next() // double fire
        await flush()
        expect(worktree.removeSet).toHaveBeenCalledTimes(1)
    })

    it('a removeSet failure is swallowed (never throws out of the subscription)', async () => {
        const outer = {} as any; const leaf = inner(false)
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        worktree.removeSet.mockRejectedValue(new Error('git boom'))
        svc.register(outer, makeSet('agent/boom'), leaf)
        expect(() => { leaf.destroyed$.next() }).not.toThrow()
        await flush()
        expect(worktree.removeSet).toHaveBeenCalled()
    })
})
