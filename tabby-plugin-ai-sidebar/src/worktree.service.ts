import { Injectable } from '@angular/core'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

const execFileAsync = promisify(execFile)

/**
 * Optional git-worktree isolation for running multiple agents on the same
 * project without clobbering each other. This service is the ENGINE — the git +
 * filesystem operations; UI wiring (the picker, the sidebar manager, tab
 * creation, resume persistence, the startup reaper) lives elsewhere. See
 * `internal/todo-worktree-isolation.md` for the full design.
 *
 * Multi-repo: the agent's cwd is often a NON-git workspace root containing
 * several independent git repos (client/ server/ web/). We isolate each git repo
 * as its own worktree on a shared branch, assembled under one isolated root, and
 * SYMLINK the non-git content (shared). Source is isolated per agent; build env
 * is shared (an accepted trade-off).
 */

/** Root under which ALL GlanceTerm-managed worktrees live — the reaper's hard
 *  boundary. We only ever remove worktrees here, never the user's own. */
export const MANAGED_ROOT = path.join(os.homedir(), '.glanceterm', 'worktrees')

/** A git repo found under a workspace root. */
export interface SubRepo {
    name: string      // directory name (client / server / web)
    repoPath: string  // absolute path to the original repo
}

/** One repo's isolated worktree within a set. */
export interface WorktreeRepo {
    name: string
    origPath: string       // the original repo
    worktreePath: string   // the isolated worktree
    base: string           // the commit SHA this worktree was forked from (the safety anchor)
}

/** The worktree set backing one agent tab. Persisted with the tab for resume. */
export interface WorktreeSet {
    root: string           // the workspace root the agent opened in
    isolatedRoot: string   // MANAGED_ROOT/<rootname>/<branch>
    branch: string
    repos: WorktreeRepo[]
}

// ── pure helpers (no IO — unit-testable) ─────────────────────────────────────

/** Where a worktree set lives on disk. Pure.
 *
 *  Globally unique per (absolute root, branch): the dir name carries a stable hash
 *  of the ABSOLUTE root path, so two different workspaces that merely share a
 *  basename (`/a/project` and `/b/project`) never collide onto the same dir — which
 *  would let one set's `fs.rm` delete another's. The branch becomes ONE leaf-safe
 *  path segment: encodeURIComponent collapses any `/` (no nesting, so `agent` and
 *  `agent/x` can't become a parent/child removal hazard) and we also escape `.` so
 *  the segment can never resolve to `.`/`..`. */
export function isolatedRootFor (root: string, branch: string): string {
    const absRoot = path.resolve(root)
    const name = (path.basename(absRoot) || 'workspace').replace(/[^\w.-]/g, '_')
    const hash = crypto.createHash('sha1').update(absRoot).digest('hex').slice(0, 10)
    let leaf = encodeURIComponent(branch).replace(/\./g, '%2E')
    // A git-valid branch can encode past the 255-byte filename-component limit
    // (`/`→`%2F` etc.); cap it and append a hash of the full branch for uniqueness.
    if (leaf.length > 200) {
        leaf = leaf.slice(0, 188) + '-' + crypto.createHash('sha1').update(branch).digest('hex').slice(0, 10)
    }
    return path.join(MANAGED_ROOT, `${name}-${hash}`, leaf)
}

/** Structural validator for a persisted registry entry. Pure. Rejects anything
 *  that isn't a fully-formed WorktreeSet so a corrupt/hand-edited registry can't
 *  feed garbage (or a path) into the reaper. */
export function isWorktreeSet (x: any): x is WorktreeSet {
    return !!x
        && typeof x.root === 'string'
        && typeof x.isolatedRoot === 'string'
        && typeof x.branch === 'string'
        && Array.isArray(x.repos)
        // MUST be non-empty: a zero-repo set makes removeSet skip all git and
        // fall straight to fs.rm(isolatedRoot) with nothing to anchor it — a
        // corrupt `{repos:[], isolatedRoot:<MANAGED_ROOT>}` would otherwise wipe
        // every workspace's worktrees. isSetSafeToRemove also returns true
        // vacuously for [] (the loop never runs), compounding it.
        && x.repos.length > 0
        && x.repos.every((r: any) => !!r
            && typeof r.name === 'string'
            && typeof r.origPath === 'string'
            && typeof r.worktreePath === 'string'
            && typeof r.base === 'string')
}

/** "Safe to remove" decision from raw git output: clean working tree AND no
 *  commits ahead of base (nothing to lose). Pure. */
export function decideSafeToRemove (statusPorcelain: string, revListAhead: string): boolean {
    return statusPorcelain.trim() === '' && revListAhead.trim() === ''
}

// ── service ──────────────────────────────────────────────────────────────────

@Injectable()
export class WorktreeService {
    /** Where the resume/reaper registry lives. Default = under the managed root;
     *  overridable so unit tests don't touch the real ~/.glanceterm. */
    private readonly registryPath: string

    /** Serializes registry read-modify-write so concurrent persist/forget in this
     *  process can't lose updates. See mutateRegistry. */
    private registryQueue: Promise<void> = Promise.resolve()

    constructor (registryPath: string = path.join(MANAGED_ROOT, 'registry.json')) {
        this.registryPath = registryPath
    }

    private async git (cwd: string, args: string[]): Promise<string> {
        const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })
        return stdout
    }

    /** Reject a branch name that git would refuse — BEFORE it ever reaches a path.
     *  An unvalidated `../x` would otherwise `mkdir`/`rm -rf` outside the managed
     *  root (the branch is used in `isolatedRootFor`). Cheap structural reject +
     *  git's own authoritative `check-ref-format`. */
    private async validateBranch (branch: string): Promise<void> {
        if (!branch || branch.startsWith('-') || branch.startsWith('/') || branch.includes('..')) {
            throw new Error(`invalid branch name: "${branch}"`)
        }
        try {
            await execFileAsync('git', ['check-ref-format', `refs/heads/${branch}`], { encoding: 'utf-8' })
        } catch {
            throw new Error(`invalid branch name: "${branch}"`)
        }
    }

    /** Defense-in-depth: refuse to mkdir/rm a path outside ~/.glanceterm/worktrees.
     *  Even if branch validation is somehow bypassed, the destructive `fs.rm` and
     *  `mkdir` can never escape the managed root. */
    private assertWithinManagedRoot (p: string): void {
        const resolved = path.resolve(p)
        const managed = path.resolve(MANAGED_ROOT)
        // Must be STRICTLY inside — refuse `=== managed` too, so a corrupt
        // isolatedRoot of MANAGED_ROOT itself can never reach fs.rm(managed).
        if (resolved === managed || !resolved.startsWith(managed + path.sep)) {
            throw new Error(`refusing to touch a path outside the managed worktree root: ${p}`)
        }
    }

    /** True if `dir` is a git repo TOPLEVEL (or a linked worktree) — it has a
     *  `.git` entry directly inside it (a directory for a normal repo, a file for
     *  a worktree). A subdirectory inside a repo has none. We check for `.git`
     *  rather than comparing `git --show-toplevel` to the path, because git
     *  returns the symlink-resolved realpath (e.g. /private/var on macOS) which
     *  won't equal an unresolved /var path. */
    private isRepoToplevel (dir: string): boolean {
        return fsSync.existsSync(path.join(dir, '.git'))
    }

    /**
     * Discover the git repos to isolate. If `root` is itself a repo toplevel →
     * single-repo case (`[root]`). Otherwise scan its direct children for repo
     * toplevels — the multi-repo non-git-root workspace.
     *
     * BY DESIGN: depth-1 only (a nested `client/frontend/.git` under a non-repo
     * `client/` is not found), and a child that is a SYMLINK to a repo is treated
     * as shared content (not isolated), since `Dirent.isDirectory()` is false for a
     * symlink. Both keep discovery predictable; revisit if real workspaces need them.
     */
    async discoverSubRepos (root: string): Promise<SubRepo[]> {
        if (this.isRepoToplevel(root)) {
            return [{ name: path.basename(root), repoPath: root }]
        }
        const out: SubRepo[] = []
        let entries: fsSync.Dirent[]
        try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return out }
        for (const e of entries) {
            if (!e.isDirectory()) continue
            const p = path.join(root, e.name)
            if (this.isRepoToplevel(p)) out.push({ name: e.name, repoPath: p })
        }
        return out
    }

    /** The commit a worktree's "ahead of base" is measured against — the repo's
     *  current HEAD commit SHA, NOT the branch name. `rev-parse --abbrev-ref HEAD`
     *  returns "HEAD" on a detached HEAD, and `rev-list HEAD..HEAD` is always empty,
     *  so a worktree with real commits would be misjudged "safe to remove". A SHA is
     *  correct in detached state too. */
    private async baseCommit (repo: string): Promise<string> {
        return (await this.git(repo, ['rev-parse', 'HEAD'])).trim()
    }

    private async branchExists (repo: string, branch: string): Promise<boolean> {
        try { await this.git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]); return true } catch { return false }
    }

    /**
     * Create a worktree set: one worktree per selected repo on `branch`, plus
     * symlinks for the root's non-git entries (shared). Rolls back on failure.
     * Throws if `branch` already exists in any selected repo (caller picks a
     * fresh name).
     */
    async createSet (root: string, repos: SubRepo[], branch: string): Promise<WorktreeSet> {
        await this.validateBranch(branch)
        for (const r of repos) {
            if (await this.branchExists(r.repoPath, branch)) {
                throw new Error(`branch "${branch}" already exists in ${r.name}`)
            }
        }
        const isolatedRoot = isolatedRootFor(root, branch)
        this.assertWithinManagedRoot(isolatedRoot)

        // Single-repo (root IS the git repo): `isolatedRoot` must BE the worktree —
        // NOT a `<repoName>/` subdir with the original's top-level files symlinked
        // into isolatedRoot (that would make a tab cd'd to isolatedRoot edit the
        // ORIGINAL repo through symlinks, defeating isolation). Multi-repo: assemble
        // a worktree per repo under isolatedRoot + symlink the non-isolated siblings.
        const singleRepo = repos.length === 1 && path.resolve(repos[0].repoPath) === path.resolve(root)
        await fs.mkdir(path.dirname(isolatedRoot), { recursive: true })
        // Atomically claim isolatedRoot so the destructive rollback below never
        // fs.rm's a dir we don't own — `ownsIsolatedRoot` gates that fs.rm.
        //   multi-repo: a NON-recursive mkdir IS the claim (EEXIST → abort here).
        //   single-repo: `git worktree add` creates the dir, so we pre-check it's
        //   absent and mark ownership only AFTER git creates it — a TOCTOU create by
        //   another process makes worktree-add fail with ownership still false → no rm.
        let ownsIsolatedRoot = false
        if (singleRepo) {
            if (fsSync.existsSync(isolatedRoot)) {
                throw new Error(`worktree dir already exists (concurrent create / stale leftover): ${isolatedRoot}`)
            }
        } else {
            try {
                await fs.mkdir(isolatedRoot)
                ownsIsolatedRoot = true
            } catch {
                throw new Error(`worktree dir already exists (concurrent create / stale leftover): ${isolatedRoot}`)
            }
        }

        const created: WorktreeRepo[] = []
        try {
            if (singleRepo) {
                const r = repos[0]
                const base = await this.baseCommit(r.repoPath)
                // `worktree add` creates isolatedRoot itself — no symlinks, no subdir.
                await this.git(r.repoPath, ['worktree', 'add', isolatedRoot, '-b', branch])
                ownsIsolatedRoot = true // git created isolatedRoot
                created.push({ name: r.name, origPath: r.repoPath, worktreePath: isolatedRoot, base })
            } else {
                for (const r of repos) {
                    const base = await this.baseCommit(r.repoPath)
                    const worktreePath = path.join(isolatedRoot, r.name)
                    await this.git(r.repoPath, ['worktree', 'add', worktreePath, '-b', branch])
                    created.push({ name: r.name, origPath: r.repoPath, worktreePath, base })
                }
                // Symlink every root entry that ISN'T an isolated repo (non-git content
                // + unchecked repos) → shared. Surface failures instead of swallowing
                // them — an agent must not silently run missing its shared content.
                // lstat (not existsSync) so a stale BROKEN link is replaced; a Windows
                // directory needs a junction (a plain symlink needs privilege there).
                const selected = new Set(repos.map(r => r.name))
                let entries: fsSync.Dirent[] = []
                try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { /* */ }
                const failed: string[] = []
                for (const e of entries) {
                    if (selected.has(e.name)) continue
                    // Do NOT mount an UNSELECTED git repo — symlinking it would let the
                    // agent edit the original repo the user chose not to isolate. Only
                    // non-git content is shared; unselected repos are absent here.
                    if (e.isDirectory() && this.isRepoToplevel(path.join(root, e.name))) continue
                    const link = path.join(isolatedRoot, e.name)
                    let present = true
                    try { fsSync.lstatSync(link) } catch { present = false }
                    if (present) continue
                    try {
                        const type = process.platform === 'win32' && e.isDirectory() ? 'junction' : undefined
                        await fs.symlink(path.join(root, e.name), link, type)
                    } catch (err: any) {
                        failed.push(`${e.name} (${err?.code ?? 'symlink failed'})`)
                    }
                }
                if (failed.length) {
                    throw new Error(`could not share non-git content into the worktree: ${failed.join(', ')}`)
                }
            }
        } catch (err) {
            // Inline rollback: remove the created worktrees + their freshly-created
            // branches, prune every attempted repo, and fs.rm isolatedRoot ONLY if we
            // created it (never delete a dir another set / a stale leftover owns).
            for (const r of created) {
                try { await this.git(r.origPath, ['worktree', 'remove', '--force', r.worktreePath]) } catch { /* */ }
                try { await this.git(r.origPath, ['branch', '-D', branch]) } catch { /* */ }
            }
            for (const r of repos) {
                try { await this.git(r.repoPath, ['worktree', 'prune']) } catch { /* */ }
            }
            if (ownsIsolatedRoot) {
                this.assertWithinManagedRoot(isolatedRoot)
                await fs.rm(isolatedRoot, { recursive: true, force: true }).catch(() => {})
                try { await fs.rmdir(path.dirname(isolatedRoot)) } catch { /* */ }
            }
            throw err
        }
        return { root, isolatedRoot, branch, repos: created }
    }

    /** Is the whole set safe to remove? Every repo: clean working tree AND no
     *  commits ahead of base. */
    async isSetSafeToRemove (set: WorktreeSet): Promise<boolean> {
        for (const r of set.repos) {
            if (!fsSync.existsSync(r.worktreePath)) continue // already gone
            try {
                const status = await this.git(r.worktreePath, ['status', '--porcelain'])
                const ahead = await this.git(r.worktreePath, ['rev-list', `${r.base}..HEAD`])
                if (!decideSafeToRemove(status, ahead)) return false
            } catch {
                // Can't determine (e.g. base SHA gone) → conservatively NOT safe;
                // keep the worktree rather than risk auto-removing live work.
                return false
            }
        }
        return true
    }

    /**
     * Remove a worktree set: each repo's worktree + the isolated root + symlinks.
     * Also deletes the per-repo branch when it has no commits ahead of base
     * (fully merged / never diverged). `force` skips git's dirty check — the
     * caller must have confirmed (dirty-guard lives in the UI). Best-effort: a
     * repo already gone is fine.
     */
    async removeSet (set: WorktreeSet, opts: { force?: boolean } = {}): Promise<void> {
        // ATOMIC non-force: if ANY repo in the set is unsafe (dirty / unmerged),
        // remove NOTHING — otherwise a multi-repo set is half torn down (a clean
        // sibling's worktree + branch deleted while the dirty one is kept). force =
        // the UI dirty-guard already confirmed the discard, so skip this gate.
        if (!opts.force && !(await this.isSetSafeToRemove(set))) {
            return
        }

        // 1) Remove every worktree dir. `force` ONLY relaxes git's dirty check.
        for (const r of set.repos) {
            const args = ['worktree', 'remove', r.worktreePath]
            if (opts.force) args.push('--force')
            try { await this.git(r.origPath, args) } catch { /* maybe already removed */ }
        }
        // 2) THEN delete branches — SEPARATE, never-forced data protection: delete a
        //    repo's branch ONLY if its worktree actually went AND it has no commits
        //    ahead of base (fully merged). A branch with unmerged COMMITS is kept
        //    even under force; deferring until the worktree is gone means a refused
        //    remove never leaves a deleted branch behind a surviving worktree.
        for (const r of set.repos) {
            if (fsSync.existsSync(r.worktreePath)) continue // worktree survived → keep its branch
            try {
                const ahead = await this.git(r.origPath, ['rev-list', `${r.base}..${set.branch}`])
                if (ahead.trim() === '') {
                    await this.git(r.origPath, ['branch', '-D', set.branch]).catch(() => {})
                }
            } catch { /* base/branch gone — ignore */ }
            try { await this.git(r.origPath, ['worktree', 'prune']) } catch { /* */ }
        }
        // 3) Nuke the isolated root only if force OR every worktree dir is gone.
        const anyWorktreeLeft = set.repos.some(r => fsSync.existsSync(r.worktreePath))
        if (opts.force || !anyWorktreeLeft) {
            this.assertWithinManagedRoot(set.isolatedRoot)
            await fs.rm(set.isolatedRoot, { recursive: true, force: true }).catch(() => {})
            // Best-effort: drop the now-empty per-workspace parent (<name>-<hash>/).
            try { await fs.rmdir(path.dirname(set.isolatedRoot)) } catch { /* not empty / gone */ }
            // The set is gone → drop it from the resume/reaper registry. (A non-force
            // KEEP returned early above, so a kept-because-dirty set stays recorded.)
            await this.forgetSet(set)
        }
    }

    // ── persistence: resume re-attach + the startup reaper ───────────────────
    //
    // A sidecar registry (MANAGED_ROOT/registry.json) records every live set so
    // that after a restart/crash a recovered tab can re-attach (badge + cleanup)
    // and the reaper knows each worktree's base SHA for the safe-to-remove check.
    // The in-memory lifecycle map dies with the process; this is the durable copy.
    // persistSet is called by the UI AFTER the tab opens; removeSet auto-forgets.

    /** Load persisted sets (for resume + reaper). Returns [] on any error — a
     *  missing/corrupt registry must never crash startup — and drops malformed or
     *  out-of-managed-root entries so a hand-edited file can't steer the reaper's
     *  fs.rm at a foreign path. */
    async loadPersistedSets (): Promise<WorktreeSet[]> {
        let parsed: any
        try {
            parsed = JSON.parse(await fs.readFile(this.registryPath, 'utf-8'))
        } catch {
            return []
        }
        const sets: unknown[] = Array.isArray(parsed?.sets) ? parsed.sets : []
        const managed = path.resolve(MANAGED_ROOT)
        return sets.filter(isWorktreeSet).filter(s => {
            const r = path.resolve(s.isolatedRoot)
            return r === managed || r.startsWith(managed + path.sep)
        })
    }

    /** Record a set so a recovered tab can re-attach + the reaper knows its base. */
    async persistSet (set: WorktreeSet): Promise<void> {
        await this.mutateRegistry(sets =>
            [...sets.filter(s => s.isolatedRoot !== set.isolatedRoot), set])
    }

    /** Drop a set from the registry. No-op if no registry exists yet (so engine
     *  paths that never persisted — e.g. open-failure rollback — write nothing). */
    async forgetSet (set: WorktreeSet): Promise<void> {
        if (!fsSync.existsSync(this.registryPath)) {
            return
        }
        await this.mutateRegistry(sets => sets.filter(s => s.isolatedRoot !== set.isolatedRoot))
    }

    /**
     * Serialize every read-modify-write of the registry through one in-process
     * queue, so concurrent persist/forget (rapid open/close) can't lose updates
     * or interleave. `transform` runs against the freshly-loaded set inside the
     * critical section. (Cross-PROCESS — a second window — still races; the
     * unique temp name below prevents corruption, and a lost update self-heals
     * on the next launch's reconcile. A cross-process lock is future work.)
     */
    private mutateRegistry (transform: (sets: WorktreeSet[]) => WorktreeSet[]): Promise<void> {
        const run = async (): Promise<void> => {
            const next = transform(await this.loadPersistedSets())
            await this.writeRegistry(next)
        }
        // Chain regardless of the previous op's outcome so one failure doesn't
        // wedge the queue. Swallow here; callers already treat persist as best-effort.
        this.registryQueue = this.registryQueue.then(run, run)
        return this.registryQueue
    }

    private async writeRegistry (sets: WorktreeSet[]): Promise<void> {
        await fs.mkdir(path.dirname(this.registryPath), { recursive: true })
        // UNIQUE temp per write (pid + random): a shared `.tmp` would let two
        // concurrent writers interleave bytes into the same file, then publish
        // torn JSON via rename. With a private temp, rename is genuinely atomic.
        const tmp = `${this.registryPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
        try {
            await fs.writeFile(tmp, JSON.stringify({ version: 1, sets }, null, 2), 'utf-8')
            await fs.rename(tmp, this.registryPath) // atomic: a crash mid-write can't corrupt the live file
        } catch (e) {
            await fs.rm(tmp, { force: true }).catch(() => {}) // don't leak a temp on failure
            throw e
        }
    }
}
