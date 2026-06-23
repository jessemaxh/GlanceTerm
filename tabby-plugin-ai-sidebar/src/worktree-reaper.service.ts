import { Injectable } from '@angular/core'
import * as fsSync from 'fs'
import * as path from 'path'
import { ConfigService, NotificationsService } from 'tabby-core'

import { TabMonitor } from './tab-monitor'
import { WorktreeService, WorktreeSet } from './worktree.service'
import { WorktreeLifecycleService } from './worktree-lifecycle.service'

/**
 * Delay after config-ready before the one-shot reconcile. Generous on purpose:
 * AutoResumeService warms every recovered tab's session and TabMonitor polls cwd
 * on an interval, so we wait for those to populate before deciding a worktree is
 * orphaned. The design's load-bearing order — re-attach recovered tabs FIRST,
 * reap only what's left — depends on cwds being known by now.
 */
const REAP_DELAY_MS = 10_000

/** The persisted set a cwd belongs to: isolatedRoot === cwd, or cwd is inside it. Pure. */
export function worktreeSetForCwd (cwd: string, sets: WorktreeSet[]): WorktreeSet | null {
    const c = path.resolve(cwd)
    for (const s of sets) {
        const root = path.resolve(s.isolatedRoot)
        if (c === root || c.startsWith(root + path.sep)) {
            return s
        }
    }
    return null
}

/** Split persisted sets by whether a live tab cwd sits inside them. Pure. */
export function partitionClaimed (
    sets: WorktreeSet[],
    liveCwds: string[],
): { claimed: WorktreeSet[], orphans: WorktreeSet[] } {
    const claimedRoots = new Set<string>()
    for (const cwd of liveCwds) {
        const s = worktreeSetForCwd(cwd, sets)
        if (s) {
            claimedRoots.add(s.isolatedRoot)
        }
    }
    return {
        claimed: sets.filter(s => claimedRoots.has(s.isolatedRoot)),
        orphans: sets.filter(s => !claimedRoots.has(s.isolatedRoot)),
    }
}

/**
 * Startup reconcile for worktrees persisted by a previous session. Crash-safe:
 * worktrees are on-disk git state that survives any app death, so cleanup is
 * purely (close-driven, already) + startup-driven here. Runs ONCE per window:
 *   1. RE-ATTACH — every live tab whose cwd is inside a persisted worktree gets
 *      its lifecycle tracking (badge + close-time cleanup) restored.
 *   2. REAP — a persisted set with NO live tab is removed IF safe (clean + no
 *      unmerged commits), its registry entry dropped if its dir vanished
 *      out-of-band, else KEPT for the manager panel. Safe-only, so even a wrongly
 *      "orphaned" set (a tab that didn't warm in time) loses no data.
 *
 * Bounded scope (documented): per-window + by-cwd. A tab that cd'd entirely out
 * of its worktree, or a worktree claimed by a DIFFERENT window, can look
 * orphaned — but the safe-only gate caps the downside to tidying a clean/merged
 * (work-free) dir. Cross-window/process claim detection is future work.
 */
@Injectable()
export class WorktreeReaperService {
    constructor (
        config: ConfigService,
        private monitor: TabMonitor,
        private worktree: WorktreeService,
        private lifecycle: WorktreeLifecycleService,
        private notifications: NotificationsService,
    ) {
        config.ready$.toPromise()
            .then(() => setTimeout(() => { void this.reconcile() }, REAP_DELAY_MS))
            .catch(() => { /* config never readied — nothing to reconcile */ })
    }

    async reconcile (): Promise<void> {
        const sets = await this.worktree.loadPersistedSets()
        if (!sets.length) {
            return
        }

        // 1) Re-attach live tabs sitting in a persisted worktree.
        const liveCwds: string[] = []
        for (const st of this.monitor.current) {
            if (!st.cwd) {
                continue
            }
            liveCwds.push(st.cwd)
            const set = worktreeSetForCwd(st.cwd, sets)
            if (set) {
                this.lifecycle.register(st.outerTab, set, st.innerTab)
            }
        }

        // 2) Reap the orphans (safe only) / drop vanished entries.
        const { orphans } = partitionClaimed(sets, liveCwds)
        let reaped = 0
        let kept = 0
        for (const set of orphans) {
            try {
                if (!fsSync.existsSync(set.isolatedRoot)) {
                    await this.worktree.forgetSet(set) // dir removed out-of-band → drop stale entry
                } else if (await this.worktree.isSetSafeToRemove(set)) {
                    await this.worktree.removeSet(set) // safe orphan → tidy (auto-forgets)
                    reaped++
                } else {
                    kept++ // has unsaved/unmerged work → leave for the manager
                }
            } catch {
                // Never let one bad set abort the sweep.
            }
        }
        if (reaped > 0) {
            const keptNote = kept ? ` · kept ${kept} with work` : ''
            this.notifications.info(`Tidied ${reaped} orphaned worktree${reaped === 1 ? '' : 's'}${keptNote}`)
        }
    }
}
