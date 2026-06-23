import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { NotificationsService, PlatformService } from 'tabby-core'

import { WorktreeService, WorktreeSet, WorktreeSetStatus } from './worktree.service'
import { WorktreeLifecycleService } from './worktree-lifecycle.service'

interface Row {
    set: WorktreeSet
    status: WorktreeSetStatus
    /** A live tab this session is sitting in this worktree → don't offer remove. */
    live: boolean
    /** Two-step guard: a dirty/unmerged remove turns the button into Force-discard. */
    confirming: boolean
    /** When Force-discard was armed — gates against a fast double-click. */
    armedAt?: number
    busy: boolean
}

/** Ignore a Force-discard 2nd click within this window of arming, so a fast
 *  double-click can't blow past the confirm step. */
const CONFIRM_MIN_MS = 350

/**
 * Worktree manager (P2c). Lists every persisted worktree set with its live git
 * status and lets the user remove orphans manually — the visibility + cleanup
 * backstop for the conservative reaper, which never auto-deletes an existing-dir
 * worktree. A SAFE orphan (clean + merged) removes directly; a dirty/unmerged one
 * is dirty-guarded (the button becomes a red "Force-discard" needing a second
 * click). A LIVE set (open tab this session) isn't removable here — close its tab
 * (the close-driven cleanup handles it) so we never delete a worktree in use.
 */
@Component({
    template: `
        <div class="modal-header">
            <h5 class="modal-title">Worktrees <span style="opacity:.6;">({{ rows.length }})</span></h5>
        </div>
        <div class="modal-body" style="max-height:60vh; overflow:auto;">
            <p *ngIf="loading" style="opacity:.7;">Loading…</p>
            <p *ngIf="!loading && rows.length === 0" style="opacity:.7;">
                No managed worktrees. Right-click an agent → “Open agent in worktree…” to create one.
            </p>
            <div *ngFor="let r of rows" class="wt-row"
                 style="display:flex; align-items:center; gap:.6rem; padding:.5rem 0; border-bottom:1px solid rgba(255,255,255,.08);">
                <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; gap:.4rem;">
                        <code style="font-size:12px;">⎇ {{ r.set.branch }}</code>
                        <span *ngIf="r.live" style="font-size:10px; opacity:.6; border:1px solid rgba(255,255,255,.2); border-radius:999px; padding:0 5px;">in use</span>
                    </div>
                    <div style="font-size:11px; opacity:.7; margin-top:2px;">
                        {{ reposLabel(r) }} ·
                        <span [style.color]="statusColor(r)">{{ statusLabel(r) }}</span>
                    </div>
                </div>
                <button class="btn btn-sm btn-secondary" (click)="reveal(r)" [disabled]="r.busy">Reveal</button>
                <button *ngIf="!r.live"
                        class="btn btn-sm"
                        [class.btn-danger]="r.confirming || !r.status.safe"
                        [class.btn-secondary]="!r.confirming && r.status.safe"
                        [disabled]="r.busy"
                        (click)="remove(r)">
                    {{ r.confirming ? 'Force-discard' : 'Remove' }}
                </button>
                <span *ngIf="r.live" style="font-size:11px; opacity:.5; width:5.5rem; text-align:center;">close its tab</span>
            </div>
        </div>
        <div class="modal-footer" style="justify-content:space-between;">
            <button class="btn btn-secondary" (click)="tidyAllSafe()" [disabled]="loading || safeOrphanCount() === 0">
                Tidy all safe ({{ safeOrphanCount() }})
            </button>
            <span>
                <button class="btn btn-secondary" (click)="refresh()" [disabled]="loading">Refresh</button>
                <button class="btn btn-primary" (click)="close()">Close</button>
            </span>
        </div>
    `,
})
export class WorktreeManagerComponent {
    rows: Row[] = []
    loading = true

    constructor (
        private modal: NgbActiveModal,
        private worktree: WorktreeService,
        private lifecycle: WorktreeLifecycleService,
        private platform: PlatformService,
        private notifications: NotificationsService,
    ) {
        this.refresh().catch(e => this.notifications.error(`Could not load worktrees: ${e?.message ?? e}`))
    }

    /** In use = a live tab in THIS window OR (cross-process, best-effort) a live
     *  process cwd'd inside the worktree. Re-checked at click time because the
     *  row's `live` snapshot from refresh() can be stale. */
    private async inUse (r: Row): Promise<boolean> {
        if (this.lifecycle.liveIsolatedRoots().has(r.set.isolatedRoot)) {
            return true
        }
        return this.worktree.isInUse(r.set)
    }

    async refresh (): Promise<void> {
        this.loading = true
        try {
            const live = this.lifecycle.liveIsolatedRoots()
            const sets = await this.worktree.loadPersistedSets()
            const rows = await Promise.all(sets.map(async set => ({
                set,
                status: await this.worktree.inspectSet(set),
                live: live.has(set.isolatedRoot),
                confirming: false,
                busy: false,
            })))
            // Orphans first, then live; within each, dirty/unmerged before safe.
            rows.sort((a, b) => Number(a.live) - Number(b.live) || Number(a.status.safe) - Number(b.status.safe))
            this.rows = rows
        } finally {
            this.loading = false
        }
    }

    reposLabel (r: Row): string {
        return r.status.repos.map(x => x.exists ? x.name : `${x.name} (gone)`).join(', ') || '—'
    }

    statusLabel (r: Row): string {
        if (r.status.repos.every(x => !x.exists)) return 'missing'
        if (r.status.dirty) {
            const n = r.status.repos.reduce((s, x) => s + x.dirtyFiles, 0)
            return `dirty (${n} file${n === 1 ? '' : 's'})`
        }
        if (r.status.ahead > 0) return `clean · ${r.status.ahead} ahead`
        return 'clean · merged'
    }

    statusColor (r: Row): string {
        if (r.status.dirty) return '#E5C07B'      // amber: has uncommitted work
        if (r.status.ahead > 0) return '#61AFEF'  // blue: committed-but-unmerged
        return '#98C379'                          // green: safe
    }

    safeOrphanCount (): number {
        return this.rows.filter(r => !r.live && r.status.safe).length
    }

    async remove (r: Row): Promise<void> {
        if (r.busy) {
            return
        }
        if (!r.status.safe && !r.confirming) {
            r.confirming = true // first click on an unsafe set → arm Force-discard
            r.armedAt = Date.now()
            return
        }
        // Defeat a fast double-click: require the armed state to have been visible
        // for a beat before the second (destructive) click counts.
        if (r.confirming && r.armedAt && Date.now() - r.armedAt < CONFIRM_MIN_MS) {
            return
        }
        // Re-check in-use AT CLICK TIME — `r.live` from refresh() can be stale (a
        // tab opened/recovered into this worktree since) and never saw another
        // window's tab. Never delete a worktree in use, esp. on the force path.
        if (await this.inUse(r)) {
            this.notifications.error(`${r.set.branch} is in use by an open tab — close it first`)
            r.confirming = false
            void this.refresh()
            return
        }
        r.busy = true
        try {
            const removed = await this.worktree.removeSet(r.set, { force: !r.status.safe })
            if (removed) {
                this.rows = this.rows.filter(x => x !== r)
                this.notifications.info(`Removed worktree ${r.set.branch}`)
            } else {
                // non-force no-op (became dirty/unmerged since refresh) → keep + re-sync.
                this.notifications.info(`Kept ${r.set.branch} — it has unsaved or unmerged work`)
                void this.refresh()
            }
        } catch (e: any) {
            r.busy = false
            r.confirming = false
            this.notifications.error(`Could not remove ${r.set.branch}: ${e?.message ?? e}`)
        }
    }

    async tidyAllSafe (): Promise<void> {
        const targets = this.rows.filter(r => !r.live && r.status.safe)
        let removed = 0
        for (const r of targets) {
            if (await this.inUse(r)) {
                continue // went live since refresh → skip (don't delete an in-use worktree)
            }
            r.busy = true
            try {
                if (await this.worktree.removeSet(r.set)) { // non-force: safe only
                    this.rows = this.rows.filter(x => x !== r)
                    removed++
                } else {
                    r.busy = false
                }
            } catch { r.busy = false }
        }
        if (removed) {
            this.notifications.info(`Tidied ${removed} worktree${removed === 1 ? '' : 's'}`)
        }
        if (removed < targets.length) {
            void this.refresh() // some skipped (in use / became dirty) → re-sync the list
        }
    }

    reveal (r: Row): void {
        try {
            this.platform.openPath(r.set.isolatedRoot)
        } catch { /* base PlatformService throws; safe to ignore */ }
    }

    close (): void {
        this.modal.close()
    }
}
