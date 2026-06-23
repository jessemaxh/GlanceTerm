import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { WorktreeService, isWorktreeSet, isolatedRootFor, WorktreeSet } from '../worktree.service'

/**
 * Persistence registry tests. No git + no real-home writes: the registry path is
 * a temp file (ctor-injected) and the sets are fabricated — `isolatedRootFor`
 * gives a valid under-MANAGED_ROOT path string without anything on disk.
 */
function fakeSet (root: string, branch: string): WorktreeSet {
    const isolatedRoot = isolatedRootFor(root, branch)
    return {
        root,
        isolatedRoot,
        branch,
        repos: [{
            name: 'client',
            origPath: path.join(root, 'client'),
            worktreePath: path.join(isolatedRoot, 'client'),
            base: 'abc1234',
        }],
    }
}

describe('WorktreeService persistence (registry)', () => {
    let dir: string
    let registry: string
    let svc: WorktreeService

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-reg-'))
        registry = path.join(dir, 'registry.json')
        svc = new WorktreeService(registry)
    })
    afterEach(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
    })

    it('no registry file → loadPersistedSets is []', async () => {
        expect(await svc.loadPersistedSets()).toEqual([])
    })

    it('persist → load round-trips; write is atomic (no .tmp left behind)', async () => {
        const s = fakeSet('/ws/proj', 'agent/x')
        await svc.persistSet(s)
        expect(await svc.loadPersistedSets()).toEqual([s])
        expect(fs.existsSync(registry)).toBe(true)
        expect(fs.existsSync(`${registry}.tmp`)).toBe(false)
    })

    it('persisting the same isolatedRoot twice de-dups', async () => {
        const s = fakeSet('/ws/proj', 'agent/x')
        await svc.persistSet(s)
        await svc.persistSet({ ...s })
        expect(await svc.loadPersistedSets()).toHaveLength(1)
    })

    it('forget one of two leaves the other', async () => {
        const a = fakeSet('/ws/a', 'agent/a')
        const b = fakeSet('/ws/b', 'agent/b')
        await svc.persistSet(a)
        await svc.persistSet(b)
        await svc.forgetSet(a)
        expect((await svc.loadPersistedSets()).map(s => s.branch)).toEqual(['agent/b'])
    })

    it('forget with no registry yet → no-op, creates no file', async () => {
        await svc.forgetSet(fakeSet('/ws/x', 'agent/x'))
        expect(fs.existsSync(registry)).toBe(false)
    })

    it('corrupt registry → loadPersistedSets is [] (never throws on startup)', async () => {
        fs.writeFileSync(registry, '{ this is not json')
        expect(await svc.loadPersistedSets()).toEqual([])
    })

    it('drops malformed + out-of-managed-root entries (no foreign path reaches the reaper)', async () => {
        const good = fakeSet('/ws/proj', 'agent/x')
        const foreign = { ...fakeSet('/ws/p', 'agent/y'), isolatedRoot: '/etc/evil' }
        fs.writeFileSync(registry, JSON.stringify({ version: 1, sets: [good, foreign, { garbage: true }, null] }))
        expect(await svc.loadPersistedSets()).toEqual([good])
    })
})

describe('isWorktreeSet (pure)', () => {
    it('accepts a well-formed set', () => {
        expect(isWorktreeSet(fakeSet('/a', 'b'))).toBe(true)
    })
    it('rejects null, missing fields, and malformed repos', () => {
        expect(isWorktreeSet(null)).toBe(false)
        expect(isWorktreeSet({ root: '/a', isolatedRoot: '/b', branch: 'x' })).toBe(false) // no repos[]
        expect(isWorktreeSet({ root: '/a', isolatedRoot: '/b', branch: 'x', repos: [{ name: 'c' }] })).toBe(false) // repo missing base/paths
    })
})
