import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { WorktreeService, decideSafeToRemove, isolatedRootFor, summarizeSetStatus } from '../worktree.service'

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' })

function makeRepo (dir: string): void {
    fs.mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'user.email', 't@example.com')
    git(dir, 'config', 'user.name', 'Test')
    fs.writeFileSync(path.join(dir, 'README.md'), 'init\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
}

describe('decideSafeToRemove (pure)', () => {
    it('clean + no commits ahead → safe', () => expect(decideSafeToRemove('', '')).toBe(true))
    it('dirty working tree → not safe', () => expect(decideSafeToRemove(' M file.ts\n', '')).toBe(false))
    it('untracked file → not safe', () => expect(decideSafeToRemove('?? new.txt\n', '')).toBe(false))
    it('commits ahead of base → not safe', () => expect(decideSafeToRemove('', 'a1b2c3\n')).toBe(false))
})

describe('isolatedRootFor (pure)', () => {
    it('is under the managed root, namespaced by root, branch as one safe segment', () => {
        const p = isolatedRootFor('/Users/x/my-project', 'agent/login')
        expect(p).toContain(path.join('.glanceterm', 'worktrees'))
        expect(p).toMatch(/my-project-[0-9a-f]{6,}/)       // basename + stable hash of abs root
        expect(path.basename(p)).toBe('agent%2Flogin')     // branch = single encoded segment (no nesting)
    })
    it('same basename but different absolute root → DIFFERENT dir (no collision)', () => {
        expect(isolatedRootFor('/tmp/a/project', 'b')).not.toBe(isolatedRootFor('/tmp/c/project', 'b'))
    })
    it('a trailing slash on the root is irrelevant (path is resolved)', () => {
        expect(isolatedRootFor('/Users/x/my-project/', 'b')).toBe(isolatedRootFor('/Users/x/my-project', 'b'))
    })
    it('caps an over-long branch leaf under the filename-component limit', () => {
        const p = isolatedRootFor('/x/p', 'feature/' + 'a'.repeat(400))
        expect(path.basename(p).length).toBeLessThanOrEqual(200)
    })
})

describe('WorktreeService — multi-repo non-git root (real git)', () => {
    let root: string
    let svc: WorktreeService

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-wt-'))
        // a NON-git workspace root with two sub-repos + a non-git dir
        makeRepo(path.join(root, 'client'))
        makeRepo(path.join(root, 'server'))
        fs.mkdirSync(path.join(root, 'scripts'))
        fs.writeFileSync(path.join(root, 'scripts', 'build.sh'), '#!/bin/sh\n')
        // Inject a temp registry path so removeSet's auto-forgetSet never reads
        // or rewrites the dogfooder's REAL ~/.glanceterm/worktrees/registry.json.
        svc = new WorktreeService(path.join(root, '.gt-registry.json'))
    })

    afterEach(() => {
        try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* */ }
    })

    it('discovers the git sub-repos, ignores the non-git dir', async () => {
        const repos = await svc.discoverSubRepos(root)
        expect(repos.map(r => r.name).sort()).toEqual(['client', 'server'])
    })

    it('isolates each repo as a worktree + symlinks non-git content; reflects safety', async () => {
        const repos = await svc.discoverSubRepos(root)
        const set = await svc.createSet(root, repos, 'agent/x')

        // each repo got an isolated worktree on the new branch
        expect(set.repos.map(r => r.name).sort()).toEqual(['client', 'server'])
        for (const r of set.repos) {
            expect(fs.existsSync(r.worktreePath)).toBe(true)
            expect(git(r.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('agent/x')
        }
        // non-git scripts/ is a SHARED symlink, not a copy
        const link = path.join(set.isolatedRoot, 'scripts')
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)

        // fresh worktrees: clean + no commits ahead → safe to remove
        expect(await svc.isSetSafeToRemove(set)).toBe(true)

        // uncommitted work in one repo → NOT safe (nothing-to-lose check fails)
        fs.writeFileSync(path.join(set.repos[0].worktreePath, 'wip.txt'), 'work in progress')
        expect(await svc.isSetSafeToRemove(set)).toBe(false)

        // force-remove tears down worktrees + isolated root entirely
        await svc.removeSet(set, { force: true })
        expect(fs.existsSync(set.isolatedRoot)).toBe(false)
        // and the original repos are intact + the worktree refs pruned
        expect(git(repos[0].repoPath, 'worktree', 'list')).not.toContain('agent/x')
    })

    it('refuses a branch name that already exists in a repo', async () => {
        const repos = await svc.discoverSubRepos(root)
        git(repos[0].repoPath, 'branch', 'taken')
        await expect(svc.createSet(root, repos, 'taken')).rejects.toThrow(/already exists/)
    })

    it('single-repo case: a git root resolves to just itself', async () => {
        const repos = await svc.discoverSubRepos(path.join(root, 'client'))
        expect(repos).toHaveLength(1)
        expect(repos[0].name).toBe('client')
    })

    it('rejects a path-traversal branch name before touching the filesystem', async () => {
        const repos = await svc.discoverSubRepos(root)
        await expect(svc.createSet(root, repos, '../../evil')).rejects.toThrow(/invalid branch/)
    })

    it('single-repo: isolatedRoot IS the worktree (no nested subdir / symlinked original)', async () => {
        const client = path.join(root, 'client')
        const set = await svc.createSet(client, await svc.discoverSubRepos(client), 'agent/solo')
        // worktreePath == isolatedRoot, and it's a real checkout (own .git + files)
        expect(set.repos[0].worktreePath).toBe(set.isolatedRoot)
        expect(fs.existsSync(path.join(set.isolatedRoot, '.git'))).toBe(true)
        expect(fs.existsSync(path.join(set.isolatedRoot, 'README.md'))).toBe(true)
        // README is the worktree's OWN checkout, not a symlink back to the original
        expect(fs.lstatSync(path.join(set.isolatedRoot, 'README.md')).isSymbolicLink()).toBe(false)
        // no nested <repoName>/ dir
        expect(fs.existsSync(path.join(set.isolatedRoot, 'client'))).toBe(false)
        await svc.removeSet(set, { force: true })
    })

    it('force-remove discards uncommitted changes but KEEPS a branch with unmerged commits', async () => {
        const repos = await svc.discoverSubRepos(root)
        const set = await svc.createSet(root, repos, 'agent/work')
        const client = repos.find(r => r.name === 'client')!
        const wt = set.repos.find(r => r.name === 'client')!.worktreePath
        // a real commit on the worktree branch → ahead of base
        fs.writeFileSync(path.join(wt, 'feature.txt'), 'done')
        git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'feature')
        // plus an uncommitted file → force is needed to remove the worktree dir
        fs.writeFileSync(path.join(wt, 'scratch.txt'), 'wip')
        await svc.removeSet(set, { force: true })
        // committed work survives: the branch still exists in the ORIGINAL repo
        expect(git(client.repoPath, 'branch', '--list', 'agent/work')).toContain('agent/work')
    })

    it('detached-HEAD base: a worktree with a commit is NOT judged safe to remove', async () => {
        const client = path.join(root, 'client')
        git(client, 'checkout', '-q', '--detach') // base via abbrev-ref would be "HEAD"
        const set = await svc.createSet(client, await svc.discoverSubRepos(client), 'agent/d')
        expect(await svc.isSetSafeToRemove(set)).toBe(true) // fresh worktree → safe
        // a real commit on the worktree branch
        fs.writeFileSync(path.join(set.isolatedRoot, 'x.txt'), 'x')
        git(set.isolatedRoot, 'add', '.'); git(set.isolatedRoot, 'commit', '-qm', 'c')
        // base is the SHA (not "HEAD"), so the commit IS detected → unsafe
        expect(await svc.isSetSafeToRemove(set)).toBe(false)
        await svc.removeSet(set, { force: true })
    })

    it('non-force removeSet is ATOMIC: one dirty repo → the WHOLE set is preserved', async () => {
        const repos = await svc.discoverSubRepos(root)
        const set = await svc.createSet(root, repos, 'agent/dirty')
        const dirty = set.repos.find(r => r.name === 'client')!
        const clean = set.repos.find(r => r.name === 'server')!
        fs.writeFileSync(path.join(dirty.worktreePath, 'uncommitted.txt'), 'precious')
        // one repo unsafe → abort the whole set, remove NOTHING (no partial teardown)
        await svc.removeSet(set)
        expect(fs.existsSync(path.join(dirty.worktreePath, 'uncommitted.txt'))).toBe(true) // dirty work kept
        expect(fs.existsSync(clean.worktreePath)).toBe(true)                                // clean SIBLING worktree kept
        expect(git(clean.origPath, 'branch', '--list', 'agent/dirty')).toContain('agent/dirty') // sibling branch NOT deleted
        await svc.removeSet(set, { force: true }) // cleanup
    })

    it('aborts WITHOUT rollback if the isolated dir already exists (concurrent / stale)', async () => {
        const repos = await svc.discoverSubRepos(root)
        const dir = isolatedRootFor(root, 'agent/dup')
        fs.mkdirSync(dir, { recursive: true }) // simulate a concurrent / stale claim
        await expect(svc.createSet(root, repos, 'agent/dup')).rejects.toThrow(/already exists/)
        expect(fs.existsSync(dir)).toBe(true) // NOT deleted — we don't own it
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('single-repo: existing isolated dir aborts WITHOUT deleting it', async () => {
        const client = path.join(root, 'client')
        const dir = isolatedRootFor(client, 'agent/s')
        fs.mkdirSync(dir, { recursive: true })
        await expect(svc.createSet(client, await svc.discoverSubRepos(client), 'agent/s')).rejects.toThrow(/already exists/)
        expect(fs.existsSync(dir)).toBe(true) // foreign dir NOT deleted by rollback
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('an UNSELECTED git repo is not mounted (only selected repos + non-git content)', async () => {
        const only = (await svc.discoverSubRepos(root)).filter(r => r.name === 'client')
        const set = await svc.createSet(root, only, 'agent/partial')
        expect(fs.existsSync(path.join(set.isolatedRoot, 'client'))).toBe(true)  // selected → worktree
        expect(fs.existsSync(path.join(set.isolatedRoot, 'scripts'))).toBe(true) // non-git → symlinked
        expect(fs.existsSync(path.join(set.isolatedRoot, 'server'))).toBe(false) // unselected git repo → absent
        await svc.removeSet(set, { force: true })
    })

    it('inspectSet reports clean → dirty → ahead status (manager panel)', async () => {
        const repos = await svc.discoverSubRepos(root)
        const set = await svc.createSet(root, repos, 'agent/status')

        let st = await svc.inspectSet(set)
        expect(st.safe).toBe(true)
        expect(st.dirty).toBe(false)
        expect(st.ahead).toBe(0)

        // uncommitted change in one repo → dirty + unsafe
        fs.writeFileSync(path.join(set.repos[0].worktreePath, 'wip.txt'), 'x')
        st = await svc.inspectSet(set)
        expect(st.dirty).toBe(true)
        expect(st.safe).toBe(false)
        expect(st.repos.find(r => r.name === set.repos[0].name)!.dirtyFiles).toBeGreaterThan(0)

        // a real commit in the other repo → ahead + unsafe
        const other = set.repos[1]
        fs.writeFileSync(path.join(other.worktreePath, 'f.txt'), 'y')
        git(other.worktreePath, 'add', '.'); git(other.worktreePath, 'commit', '-qm', 'c')
        st = await svc.inspectSet(set)
        expect(st.ahead).toBeGreaterThanOrEqual(1)
        expect(st.safe).toBe(false)

        await svc.removeSet(set, { force: true })
    })
})

describe('summarizeSetStatus (pure)', () => {
    const r = (o: Partial<{ exists: boolean; ok: boolean; dirtyFiles: number; ahead: number }> = {}) =>
        ({ name: 'x', exists: true, ok: true, dirtyFiles: 0, ahead: 0, ...o })

    it('all clean+merged existing repos → safe', () => {
        expect(summarizeSetStatus([r(), r()]).safe).toBe(true)
    })
    it('a dirty repo → dirty + unsafe', () => {
        const s = summarizeSetStatus([r(), r({ dirtyFiles: 2 })])
        expect(s.dirty).toBe(true)
        expect(s.safe).toBe(false)
    })
    it('ahead commits → unsafe, ahead summed across repos', () => {
        const s = summarizeSetStatus([r({ ahead: 2 }), r({ ahead: 1 })])
        expect(s.ahead).toBe(3)
        expect(s.safe).toBe(false)
    })
    it('a git-unreadable (ok:false) repo → unsafe', () => {
        expect(summarizeSetStatus([r({ ok: false })]).safe).toBe(false)
    })
    it('a gone repo is skipped — never counts dirty / ahead / unsafe', () => {
        const s = summarizeSetStatus([r({ exists: false, ok: false, dirtyFiles: 9, ahead: 9 })])
        expect(s.safe).toBe(true)
        expect(s.dirty).toBe(false)
        expect(s.ahead).toBe(0)
    })
})
