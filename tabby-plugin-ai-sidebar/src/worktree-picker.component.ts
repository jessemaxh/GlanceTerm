import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

import { SubRepo } from './worktree.service'

export interface WorktreePickerResult {
    /** The repos the user chose to isolate (a subset of those discovered). */
    repos: SubRepo[]
    /** Branch name for every isolated worktree in the set. */
    branch: string
}

/**
 * "Open agent in worktree" chooser: a branch name plus, when the workspace
 * holds more than one git repo, a checklist of which to isolate. Unchecked
 * repos are NOT mounted into the isolated root at all (see WorktreeService /
 * `internal/todo-worktree-isolation.md` — a symlink would let the agent edit
 * the original repo the user chose not to isolate, so we omit it entirely).
 *
 * Avoids `ngModel` / FormsModule on purpose — the plugin's NgModule imports
 * only CommonModule + NgbTooltipModule, so state is bound by hand.
 */
@Component({
    template: `
        <div class="modal-header">
            <h5 class="modal-title">Open agent in worktree</h5>
        </div>
        <div class="modal-body">
            <label class="d-block" style="opacity:.8; margin-bottom:.35rem;">
                Branch for the isolated worktree
            </label>
            <input #branchInput class="form-control" [value]="branch"
                   (input)="branch = $any($event.target).value"
                   (keyup.enter)="confirm()" autofocus>

            <ng-container *ngIf="repos.length > 1">
                <label class="d-block" style="opacity:.8; margin:1rem 0 .35rem;">
                    Isolate which repos?
                    <span style="opacity:.6;">— unchecked repos won't be in the agent's workspace</span>
                </label>
                <div *ngFor="let r of repos; let i = index" class="form-check">
                    <input class="form-check-input" type="checkbox" [id]="'wt-repo-' + i"
                           [checked]="checked[i]"
                           (change)="checked[i] = $any($event.target).checked">
                    <label class="form-check-label" [for]="'wt-repo-' + i">{{ r.name }}</label>
                </div>
            </ng-container>
            <p *ngIf="repos.length === 1" style="opacity:.7; margin:.75rem 0 0;">
                Isolating <code>{{ repos[0].name }}</code> into a fresh worktree.
            </p>
        </div>
        <div class="modal-footer">
            <button class="btn btn-secondary" (click)="cancel()">Cancel</button>
            <button class="btn btn-primary" [disabled]="!canIsolate()" (click)="confirm()">Isolate</button>
        </div>
    `,
})
export class WorktreePickerComponent {
    repos: SubRepo[] = []
    /** Parallel to `repos`; true = isolate this one. */
    checked: boolean[] = []
    branch = 'agent/'

    constructor (private modal: NgbActiveModal) { }

    /** Opener calls this right after `ngbModal.open()` to seed the form. */
    init (repos: SubRepo[], branch: string): void {
        this.repos = repos
        this.checked = repos.map(() => true)
        this.branch = branch
    }

    private selected (): SubRepo[] {
        return this.repos.filter((_, i) => this.checked[i])
    }

    canIsolate (): boolean {
        return this.branch.trim().length > 0 && this.selected().length > 0
    }

    confirm (): void {
        if (!this.canIsolate()) {
            return
        }
        const result: WorktreePickerResult = { repos: this.selected(), branch: this.branch.trim() }
        this.modal.close(result)
    }

    cancel (): void {
        this.modal.dismiss()
    }
}
