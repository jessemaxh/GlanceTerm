import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    BaseTabComponent,
    MenuItemOptions,
    NotificationsService,
    PromptModalComponent,
    TabContextMenuItemProvider,
} from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TerminalService } from 'tabby-local'

import { WorktreeService, WorktreeSet } from './worktree.service'

/**
 * UI glue for optional git-worktree isolation: "Open agent in worktree…" opens a
 * new terminal tab cd'd into an isolated worktree of the active tab's workspace,
 * so a second agent can work the same project without clobbering the first. The
 * git/fs work lives in {@link WorktreeService}; this orchestrates discover →
 * prompt → createSet → openTab. The multi-repo PICKER (deselect repos), the
 * branch badge, auto-remove-on-close and the reaper are follow-up P1 steps —
 * for now ALL discovered repos are isolated. See `internal/todo-worktree-isolation.md`.
 */
@Injectable()
export class WorktreeActionsService {
    constructor (
        private worktree: WorktreeService,
        private terminal: TerminalService,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
    ) { }

    /** The tab's live working directory (the agent's cwd), else $HOME. */
    private async resolveCwd (tab: BaseTabComponent): Promise<string> {
        if (tab instanceof BaseTerminalTabComponent) {
            const session = (tab as unknown as { session?: { getWorkingDirectory?: () => Promise<string | null> } }).session
            try {
                const cwd = await session?.getWorkingDirectory?.()
                if (cwd) {
                    return cwd
                }
            } catch { /* fall through to HOME */ }
        }
        return process.env.HOME ?? '/'
    }

    private async promptBranch (defaultName: string): Promise<string | null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = 'Branch name for the isolated agent worktree'
        modal.componentInstance.value = defaultName
        const result = await modal.result.catch(() => null)
        const value = result?.value?.trim()
        return value || null
    }

    /**
     * Open a new agent tab in an isolated git worktree of `rootTab`'s workspace.
     * Returns the created set (for the caller to badge / persist) or null on no-op.
     */
    async openInWorktree (rootTab: BaseTabComponent): Promise<WorktreeSet | null> {
        const root = await this.resolveCwd(rootTab)
        const repos = await this.worktree.discoverSubRepos(root)
        if (!repos.length) {
            this.notifications.error(`No git repository found under ${root}`)
            return null
        }
        const branch = await this.promptBranch('agent/')
        if (!branch) {
            return null // cancelled / empty
        }

        let set: WorktreeSet
        try {
            set = await this.worktree.createSet(root, repos, branch)
        } catch (err: any) {
            this.notifications.error(`Worktree isolation failed: ${err?.message ?? err}`)
            return null
        }

        const tab = await this.terminal.openTab(null, set.isolatedRoot)
        if (!tab) {
            await this.worktree.removeSet(set, { force: true }).catch(() => { /* */ })
            this.notifications.error('Could not open the isolated tab')
            return null
        }
        this.notifications.info(`Isolated worktree ${branch} — ${repos.map(r => r.name).join(', ')}`)
        return set
    }
}

/** Adds "Open agent in worktree…" to a terminal tab's context menu. */
@Injectable()
export class WorktreeContextMenu extends TabContextMenuItemProvider {
    weight = 5

    constructor (private worktreeActions: WorktreeActionsService) {
        super()
    }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        if (!(tab instanceof BaseTerminalTabComponent)) {
            return []
        }
        return [{
            label: 'Open agent in worktree…',
            click: () => { void this.worktreeActions.openInWorktree(tab) },
        }]
    }
}
