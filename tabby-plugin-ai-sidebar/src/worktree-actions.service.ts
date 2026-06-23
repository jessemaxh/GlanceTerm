import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService,
    BaseTabComponent,
    MenuItemOptions,
    NotificationsService,
    SplitTabComponent,
    TabContextMenuItemProvider,
} from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TerminalService } from 'tabby-local'

import { WorktreeService, WorktreeSet } from './worktree.service'
import { WorktreeLifecycleService } from './worktree-lifecycle.service'
import { WorktreePickerComponent, WorktreePickerResult } from './worktree-picker.component'
import { TabMonitor, AiTool } from './tab-monitor'

/**
 * Delay before typing the agent's launch command into the fresh worktree shell,
 * so the shell has printed its prompt first. Mirrors AutoResumeService's
 * RESUME_DELAY_MS (2s) — the proven value for typing into a just-opened tab.
 */
const LAUNCH_DELAY_MS = 2_000

/**
 * UI glue for optional git-worktree isolation: "Open agent in worktree…" opens a
 * new terminal tab cd'd into an isolated worktree of the active tab's workspace,
 * so a second agent can work the same project without clobbering the first. The
 * git/fs work lives in {@link WorktreeService}; this orchestrates discover →
 * pick repos + branch → createSet → openTab → register for lifecycle cleanup.
 * Auto-remove-on-close + the branch badge come from {@link WorktreeLifecycleService};
 * the startup reaper + manager panel are follow-up P1/P2 steps. See
 * `internal/todo-worktree-isolation.md`.
 */
@Injectable()
export class WorktreeActionsService {
    constructor (
        private worktree: WorktreeService,
        private lifecycle: WorktreeLifecycleService,
        private terminal: TerminalService,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
        private app: AppService,
        private monitor: TabMonitor,
    ) { }

    /** The AI agent running in the source tab, if any — its bare command name
     *  ('claude'/'codex'/…) is what we auto-launch in the worktree. Prefer an
     *  inner-leaf match (the right pane) over the wrapping split. */
    private detectAiTool (tab: BaseTabComponent): AiTool | null {
        const states = this.monitor.current
        return (states.find(s => s.innerTab === tab) ?? states.find(s => s.outerTab === tab))?.aiTool ?? null
    }

    /** Type the agent's bare command into the fresh worktree shell once it's
     *  ready. The tool name is a fixed lowercase token (shell-safe); a fresh
     *  session, no inherited flags (chosen behaviour). Best-effort — a closed
     *  tab / dead session just no-ops. */
    private scheduleAgentLaunch (tab: BaseTabComponent, tool: AiTool): void {
        const term = tab as unknown as { sendInput?: (data: string) => void }
        setTimeout(() => {
            try {
                term.sendInput?.(`${tool}\r`)
            } catch (e: any) {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] worktree agent auto-launch failed:', e?.message ?? e)
            }
        }, LAUNCH_DELAY_MS)
    }

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

    /** Branch name + which repos to isolate; null if the user cancels. */
    private async pickReposAndBranch (repos: WorktreePickerResult['repos']): Promise<WorktreePickerResult | null> {
        const modal = this.ngbModal.open(WorktreePickerComponent)
        ;(modal.componentInstance as WorktreePickerComponent).init(repos, 'agent/')
        const result = await modal.result.catch(() => null)
        return (result as WorktreePickerResult | null) ?? null
    }

    /**
     * Open a new agent tab in an isolated git worktree of `rootTab`'s workspace.
     * Returns the created set (for the caller to badge / persist) or null on no-op.
     */
    async openInWorktree (rootTab: BaseTabComponent): Promise<WorktreeSet | null> {
        const root = await this.resolveCwd(rootTab)
        const aiTool = this.detectAiTool(rootTab)
        const repos = await this.worktree.discoverSubRepos(root)
        if (!repos.length) {
            this.notifications.error(`No git repository found under ${root}`)
            return null
        }

        const choice = await this.pickReposAndBranch(repos)
        if (!choice) {
            return null // cancelled
        }

        let set: WorktreeSet
        try {
            set = await this.worktree.createSet(root, choice.repos, choice.branch)
        } catch (err: any) {
            this.notifications.error(`Worktree isolation failed: ${err?.message ?? err}`)
            return null
        }
        // Persist BEFORE opening the tab so a crash in between can't leave an
        // unrecorded worktree (invisible to both re-attach and the reaper). The
        // open-failure path below force-removes the set, which auto-forgets it.
        await this.worktree.persistSet(set).catch(e => {
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] worktree persistSet failed:', e?.message ?? e)
        })

        // openTab can REJECT (unguarded profile/PTY init), not just return null —
        // both leave the freshly-created set orphaned on disk, so handle them the
        // same way: force-remove the empty set (branch is at base → safe) + toast.
        let tab: BaseTabComponent | null
        try {
            tab = await this.terminal.openTab(null, set.isolatedRoot)
        } catch {
            tab = null
        }
        if (!tab) {
            await this.worktree.removeSet(set, { force: true }).catch(e => {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] worktree rollback after failed openTab failed:', e)
            })
            this.notifications.error('Could not open the isolated tab')
            return null
        }
        // openTab returns the INNER leaf, but the sidebar badge keys off the
        // top-level tab (TabState.outerTab) and AppService.tabRemoved$ emits the
        // top-level tab — so register the wrapping SplitTabComponent, else both
        // the badge and the close-time cleanup silently miss. getParentTab() is
        // the split that now contains the leaf; `?? tab` covers the unwrapped case.
        const outer = this.app.getParentTab(tab) ?? tab
        this.lifecycle.register(outer, set, tab)
        if (aiTool) {
            this.scheduleAgentLaunch(tab, aiTool)
        }
        const launching = aiTool ? ` · launching ${aiTool}` : ''
        this.notifications.info(`Isolated worktree ${choice.branch} — ${choice.repos.map(r => r.name).join(', ')}${launching}`)
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
        // The terminal to act on. Right-clicking the terminal CONTENT passes the
        // leaf directly; right-clicking the TAB HEADER passes the top-level tab,
        // which for a terminal is a SplitTabComponent wrapper — unwrap it to its
        // focused (else first) terminal leaf, else the item is missing on the
        // header (the most natural place to right-click).
        const terminal = this.resolveTerminalTab(tab)
        if (!terminal) {
            return []
        }
        return [{
            label: 'Open agent in worktree…',
            click: () => { void this.worktreeActions.openInWorktree(terminal) },
        }]
    }

    private resolveTerminalTab (tab: BaseTabComponent): BaseTerminalTabComponent<any> | null {
        if (tab instanceof BaseTerminalTabComponent) {
            return tab
        }
        if (tab instanceof SplitTabComponent) {
            const focused = tab.getFocusedTab()
            if (focused instanceof BaseTerminalTabComponent) {
                return focused
            }
            const firstTerminal = tab.getAllTabs().find(t => t instanceof BaseTerminalTabComponent)
            return (firstTerminal as BaseTerminalTabComponent<any> | undefined) ?? null
        }
        return null
    }
}
