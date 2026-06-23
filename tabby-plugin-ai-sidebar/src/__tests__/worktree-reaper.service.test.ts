import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Subject } from 'rxjs'
import * as path from 'path'
import * as fs from 'fs'

import { WorktreeReaperService, worktreeSetForCwd } from '../worktree-reaper.service'
import { WorktreeSet } from '../worktree.service'

// existsSync decides whether an orphan entry is forgotten (dir gone) or kept.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>()
    return { ...actual, existsSync: vi.fn(() => true) }
})

function set (isolatedRoot: string, branch = 'agent/x'): WorktreeSet {
    return {
        root: '/ws',
        isolatedRoot,
        branch,
        repos: [{ name: 'c', origPath: '/ws/c', worktreePath: path.join(isolatedRoot, 'c'), base: 'b1' }],
    }
}

describe('worktreeSetForCwd (pure)', () => {
    const a = set('/m/p-a/agent')
    const b = set('/m/p-b/agent')
    it('matches the exact isolatedRoot', () => expect(worktreeSetForCwd('/m/p-a/agent', [a, b])).toBe(a))
    it('matches a cwd INSIDE the worktree', () => expect(worktreeSetForCwd('/m/p-a/agent/client/src', [a, b])).toBe(a))
    it('returns null when nothing contains the cwd', () => expect(worktreeSetForCwd('/somewhere/else', [a, b])).toBeNull())
    it('a sibling-prefix path does NOT false-match', () => expect(worktreeSetForCwd('/m/p-a/agent-other', [a])).toBeNull())
    it('honors a symlink-resolving `resolve` so /private/var matches /var', () => {
        const s = set('/var/wt/agent')
        const resolve = (p: string) => p.replace(/^\/private\/var/, '/var') // mimic realpath on macOS
        expect(worktreeSetForCwd('/private/var/wt/agent', [s], resolve)).toBe(s)
        expect(worktreeSetForCwd('/private/var/wt/agent', [s])).toBeNull() // without it → false orphan
    })
})

describe('WorktreeReaperService.reconcile (conservative — never deletes an existing dir)', () => {
    function make (sets: WorktreeSet[], states: any[]) {
        const worktree = {
            loadPersistedSets: vi.fn().mockResolvedValue(sets),
            isSetSafeToRemove: vi.fn().mockResolvedValue(true),
            removeSet: vi.fn().mockResolvedValue(undefined),
            forgetSet: vi.fn().mockResolvedValue(undefined),
        }
        const lifecycle = { register: vi.fn() }
        const monitor = { current: states }
        const config = { ready$: new Subject() } // never completes → no scheduled timer; call reconcile() directly
        const svc = new WorktreeReaperService(config as any, monitor as any, worktree as any, lifecycle as any)
        return { svc, worktree, lifecycle }
    }

    beforeEach(() => { (fs.existsSync as any).mockReturnValue(true) })

    it('re-attaches a live tab + KEEPS an existing-dir orphan (never removeSet)', async () => {
        const a = set('/m/p-a/agent')
        const b = set('/m/p-b/agent')
        const outerA = {}; const innerA = {}
        const states = [{ cwd: '/m/p-a/agent', outerTab: outerA, innerTab: innerA }]
        const { svc, worktree, lifecycle } = make([a, b], states)
        await svc.reconcile()
        expect(lifecycle.register).toHaveBeenCalledWith(outerA, a, innerA) // claimed → re-attached
        expect(worktree.removeSet).not.toHaveBeenCalled()                  // NEVER auto-deletes
        expect(worktree.forgetSet).not.toHaveBeenCalled()                  // dirs exist → entries kept
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
    })

    it('forgets a registry entry whose dir vanished out-of-band', async () => {
        const b = set('/m/p-b/agent')
        const { svc, worktree } = make([b], [])
        ;(fs.existsSync as any).mockReturnValue(false) // dir gone
        await svc.reconcile()
        expect(worktree.forgetSet).toHaveBeenCalledWith(b)
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('no persisted sets → does nothing', async () => {
        const { svc, worktree, lifecycle } = make([], [])
        await svc.reconcile()
        expect(lifecycle.register).not.toHaveBeenCalled()
        expect(worktree.forgetSet).not.toHaveBeenCalled()
    })

    it('reentrancy guard: a second concurrent reconcile is a no-op', async () => {
        const b = set('/m/p-b/agent')
        const { svc, worktree } = make([b], [])
        ;(fs.existsSync as any).mockReturnValue(false)
        await Promise.all([svc.reconcile(), svc.reconcile()]) // fire two at once
        expect(worktree.loadPersistedSets).toHaveBeenCalledTimes(1) // second bailed at the guard
    })
})
