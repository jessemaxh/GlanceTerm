import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Subject } from 'rxjs'
import * as path from 'path'
import * as fs from 'fs'

import { WorktreeReaperService, worktreeSetForCwd, partitionClaimed } from '../worktree-reaper.service'
import { WorktreeSet } from '../worktree.service'

// existsSync decides reap-vs-forget for an orphan; control it per test.
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
})

describe('partitionClaimed (pure)', () => {
    it('splits by whether a live cwd sits inside the set', () => {
        const a = set('/m/p-a/agent')
        const b = set('/m/p-b/agent')
        const { claimed, orphans } = partitionClaimed([a, b], ['/m/p-a/agent/x'])
        expect(claimed).toEqual([a])
        expect(orphans).toEqual([b])
    })
    it('no live cwds → everything is an orphan', () => {
        const a = set('/m/p-a/agent')
        expect(partitionClaimed([a], []).orphans).toEqual([a])
    })
})

describe('WorktreeReaperService.reconcile', () => {
    function make (sets: WorktreeSet[], states: any[], safe: boolean) {
        const worktree = {
            loadPersistedSets: vi.fn().mockResolvedValue(sets),
            isSetSafeToRemove: vi.fn().mockResolvedValue(safe),
            removeSet: vi.fn().mockResolvedValue(undefined),
            forgetSet: vi.fn().mockResolvedValue(undefined),
        }
        const lifecycle = { register: vi.fn() }
        const monitor = { current: states }
        const notifications = { info: vi.fn() }
        const config = { ready$: new Subject() } // never completes → no scheduled timer; we call reconcile() directly
        const svc = new WorktreeReaperService(config as any, monitor as any, worktree as any, lifecycle as any, notifications as any)
        return { svc, worktree, lifecycle, notifications }
    }

    beforeEach(() => { (fs.existsSync as any).mockReturnValue(true) })

    it('re-attaches a live tab in a worktree + reaps the safe orphan', async () => {
        const a = set('/m/p-a/agent')
        const b = set('/m/p-b/agent')
        const outerA = {}; const innerA = {}
        const states = [{ cwd: '/m/p-a/agent', outerTab: outerA, innerTab: innerA }]
        const { svc, worktree, lifecycle, notifications } = make([a, b], states, true)
        await svc.reconcile()
        expect(lifecycle.register).toHaveBeenCalledWith(outerA, a, innerA) // claimed → re-attached
        expect(worktree.removeSet).toHaveBeenCalledWith(b)                 // orphan b → reaped
        expect(worktree.removeSet).not.toHaveBeenCalledWith(a)             // claimed a → never reaped
        expect(notifications.info).toHaveBeenCalledWith(expect.stringMatching(/Tidied 1 orphaned worktree\b/))
    })

    it('an UNSAFE orphan (has work) is kept, not removed', async () => {
        const b = set('/m/p-b/agent')
        const { svc, worktree, notifications } = make([b], [], false)
        await svc.reconcile()
        expect(worktree.removeSet).not.toHaveBeenCalled()
        expect(notifications.info).not.toHaveBeenCalled() // nothing reaped → no toast
    })

    it('an orphan whose dir vanished out-of-band is forgotten, not removed', async () => {
        const b = set('/m/p-b/agent')
        const { svc, worktree } = make([b], [], true)
        ;(fs.existsSync as any).mockReturnValue(false) // dir gone
        await svc.reconcile()
        expect(worktree.forgetSet).toHaveBeenCalledWith(b)
        expect(worktree.removeSet).not.toHaveBeenCalled()
    })

    it('no persisted sets → does nothing', async () => {
        const { svc, worktree, lifecycle } = make([], [], true)
        await svc.reconcile()
        expect(lifecycle.register).not.toHaveBeenCalled()
        expect(worktree.isSetSafeToRemove).not.toHaveBeenCalled()
    })
})
