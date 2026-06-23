import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Subject } from 'rxjs'

import { WorktreeLifecycleService } from '../worktree-lifecycle.service'
import { WorktreeSet } from '../worktree.service'

/**
 * Unit-tests the anti-sprawl decision, driven by the INNER tab's destroyed$.
 *
 * The leaf stub FAITHFULLY models the production timing so the test actually
 * guards the one-microtask defer: it starts `open=true`, and `session.destroy()`
 * flips it `false` SYNCHRONOUSLY. `close()` emits `destroyed$` and THEN calls
 * `session.destroy()` in one synchronous turn — mirroring
 * baseTerminalTab.destroy() (`super.destroy()` → `await session.destroy()`,
 * which sets `open=false` before its first await). So a handler that reads
 * `session.open` synchronously (no defer) would see `open===true` on a genuine
 * close → keep → the "clean → remove" assertions FAIL. With the defer, the
 * microtask runs after `open=false` → remove. `move()` skips `session.destroy()`
 * (releaseSession → sessionReused), so `open` stays true → keep.
 */
function makeSet (branch: string): WorktreeSet {
    return { root: '/ws', isolatedRoot: '/managed/ws/' + branch, branch, repos: [] }
}
function inner (): any {
    const session = { open: true, destroy () { this.open = false } }
    return { destroyed$: new Subject<void>(), session }
}
/** Genuine close: destroyed$ then a synchronous session.destroy() (open→false). */
function close (leaf: any): void {
    leaf.destroyed$.next()
    leaf.session.destroy()
}
/** Move to new window: destroyed$ only; releaseSession kept the PTY (open stays true). */
function move (leaf: any): void {
    leaf.destroyed$.next()
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
        svc.register(outer, makeSet('agent/x'), inner())
        expect(svc.branchForTab(outer)).toBe('agent/x')
    })

    it('closing a CLEAN worktree tab → removeSet + "Tidied" (also guards the defer)', async () => {
        const outer = {} as any; const leaf = inner()
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/clean'), leaf)
        close(leaf) // open is still true at the synchronous emit; flips false right after
        await flush()
        expect(worktree.removeSet).toHaveBeenCalledTimes(1)
        expect(notifications.info).toHaveBeenCalledWith(expect.stringMatching(/Tidied worktree agent\/clean/))
        expect(svc.branchForTab(outer)).toBeNull() // badge dropped
    })

    it('closing a DIRTY worktree tab → kept, removeSet NOT called', async () => {
        const outer = {} as any; const leaf = inner()
        worktree.isSetSafeToRemove.mockResolvedValue(false)
        svc.register(outer, makeSet('agent/dirty'), leaf)
        close(leaf)
        await flush()
        expect(worktree.removeSet).not.toHaveBeenCalled()
        expect(notifications.info).toHaveBeenCalledWith(expect.stringMatching(/Kept worktree agent\/dirty/))
    })

    it('app QUITTING (recovery disabled) → keep even a clean set, never removeSet', async () => {
        const outer = {} as any; const leaf = inner()
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/quit'), leaf)
        recovery.enabled = false // closeWindow() disabled recovery before destroying tabs
        close(leaf)
        await flush()
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('MOVED to a new window (session still open) → keep, never removeSet', async () => {
        const outer = {} as any; const leaf = inner()
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/move'), leaf)
        move(leaf) // releaseSession kept the PTY → session.open stays true
        await flush()
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('a second destroyed$ for the same tab is a no-op (idempotent)', async () => {
        const outer = {} as any; const leaf = inner()
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        svc.register(outer, makeSet('agent/dup'), leaf)
        leaf.destroyed$.next()
        leaf.destroyed$.next() // double fire
        leaf.session.destroy()
        await flush()
        expect(worktree.removeSet).toHaveBeenCalledTimes(1)
    })

    it('a removeSet failure is swallowed (never throws out of the subscription)', async () => {
        const outer = {} as any; const leaf = inner()
        worktree.isSetSafeToRemove.mockResolvedValue(true)
        worktree.removeSet.mockRejectedValue(new Error('git boom'))
        svc.register(outer, makeSet('agent/boom'), leaf)
        expect(() => close(leaf)).not.toThrow()
        await flush()
        expect(worktree.removeSet).toHaveBeenCalled()
    })
})
