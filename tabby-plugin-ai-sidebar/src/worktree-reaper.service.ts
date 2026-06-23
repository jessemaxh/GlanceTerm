import { Injectable } from '@angular/core'
import * as fsSync from 'fs'
import * as path from 'path'
import { ConfigService } from 'tabby-core'

import { TabMonitor } from './tab-monitor'
import { WorktreeService, WorktreeSet } from './worktree.service'
import { WorktreeLifecycleService } from './worktree-lifecycle.service'

/**
 * Delay after config-ready before the one-shot reconcile. Generous on purpose:
 * AutoResumeService warms every recovered tab's session and TabMonitor polls cwd
 * on an interval, so we wait for those to populate before matching tabs to
 * worktrees. Re-attach is the only timing-sensitive step now (see below).
 */
const REAP_DELAY_MS = 10_000

/** Best-effort canonical path (resolves symlinks) so a live tab's OS-resolved
 *  cwd (`/private/var…`) matches an unresolved isolatedRoot. Falls back to a
 *  plain resolve if the path doesn't exist / can't be realpath'd. */
function canonical (p: string): string {
    try {
        return fsSync.realpathSync(p)
    } catch {
        return path.resolve(p)
    }
}

/** The persisted set a cwd belongs to: isolatedRoot === cwd, or cwd is inside it.
 *  `resolve` canonicalizes both sides (default = path.resolve, for pure tests). */
export function worktreeSetForCwd (
    cwd: string,
    sets: WorktreeSet[],
    resolve: (p: string) => string = path.resolve,
): WorktreeSet | null {
    const c = resolve(cwd)
    for (const s of sets) {
        const root = resolve(s.isolatedRoot)
        if (c === root || c.startsWith(root + path.sep)) {
            return s
        }
    }
    return null
}

/**
 * Startup reconcile for worktrees persisted by a previous session. Crash-safe:
 * worktrees are on-disk git state that survives any app death, so cleanup is
 * (close-driven, already) + this startup pass. Runs ONCE per window:
 *   1. RE-ATTACH — every live tab whose cwd is inside a persisted worktree gets
 *      its lifecycle tracking (badge + close-time cleanup) restored.
 *   2. FORGET VANISHED — a persisted entry whose dir was removed out-of-band is
 *      dropped from the registry (the dir is already gone — nothing to delete).
 *
 * Deliberately CONSERVATIVE — it does NOT auto-delete an orphan whose dir still
 * exists. Proving a worktree is truly unused is unsafe from here: a tab may not
 * have warmed its cwd yet (→ looks orphaned while a live agent works in it), may
 * have cd'd out, or may belong to ANOTHER window this process can't see.
 * Auto-deleting a "clean" worktree out from under a live agent is real data
 * loss, so existing-dir orphans are KEPT for the manager panel (P2c) /
 * close-driven cleanup. Safe auto-reap (needs a robust cross-process/in-use
 * claim signal) is future work. See the worktree-isolation design doc.
 */
@Injectable()
export class WorktreeReaperService {
    private running = false

    constructor (
        config: ConfigService,
        private monitor: TabMonitor,
        private worktree: WorktreeService,
        private lifecycle: WorktreeLifecycleService,
    ) {
        config.ready$.toPromise()
            .then(() => setTimeout(() => { void this.reconcile() }, REAP_DELAY_MS))
            .catch(() => { /* config never readied — nothing to reconcile */ })
    }

    async reconcile (): Promise<void> {
        if (this.running) {
            return // reentrancy guard — never double-issue forgetSet on the same set
        }
        this.running = true
        try {
            const sets = await this.worktree.loadPersistedSets()
            if (!sets.length) {
                return
            }
            // 1) Re-attach live tabs sitting in a persisted worktree.
            for (const st of this.monitor.current) {
                if (!st.cwd) {
                    continue
                }
                const set = worktreeSetForCwd(st.cwd, sets, canonical)
                if (set) {
                    this.lifecycle.register(st.outerTab, set, st.innerTab)
                }
            }
            // 2) Drop registry entries whose worktree dir vanished out-of-band.
            //    (Existing-dir orphans are intentionally KEPT — see class doc.)
            for (const set of sets) {
                if (!fsSync.existsSync(set.isolatedRoot)) {
                    await this.worktree.forgetSet(set).catch(() => { /* */ })
                }
            }
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] worktree reconcile failed:', e?.message ?? e)
        } finally {
            this.running = false
        }
    }
}
