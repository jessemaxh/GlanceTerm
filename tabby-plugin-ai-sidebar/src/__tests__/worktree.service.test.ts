import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { WorktreeService, decideSafeToRemove, isolatedRootFor } from '../worktree.service'

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
    it('lands under the managed worktree root, keyed by root name + branch', () => {
        const p = isolatedRootFor('/Users/x/my-project', 'agent/login')
        expect(p).toContain(path.join('.glanceterm', 'worktrees', 'my-project', 'agent', 'login'))
    })
    it('tolerates a trailing slash', () => {
        expect(isolatedRootFor('/Users/x/my-project/', 'b')).toContain(path.join('my-project', 'b'))
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
        svc = new WorktreeService()
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
})
