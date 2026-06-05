import { Injectable } from '@angular/core'
import {
    AppService,
    NotificationsService,
    ProfilesService,
    SplitDirection,
    SplitTabComponent,
    TabsService,
    BaseTabComponent,
} from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TerminalService } from 'tabby-local'

/**
 * Opens a fresh local shell in a new pane inside the currently active tab,
 * with its CWD pre-set to the focused leaf's live working directory.
 *
 * Uses Tabby's own primitives end-to-end:
 *   - SplitTabComponent.getFocusedTab() + addTab() — same path the built-in
 *     "Split right" context-menu item walks (tabContextMenu.ts:90).
 *   - session.getWorkingDirectory() — same source as the "Copy CWD" action.
 *   - TerminalService.getDefaultProfile() — Tabby's resolver for the user's
 *     configured default local profile, falling back to the first builtin.
 *
 * We deliberately do NOT call SplitTabComponent.splitTab(), because that
 * goes through tabsService.duplicate() and would re-run whatever command
 * the AI tab was launched with (claude / codex / …). We want a bare shell.
 */
@Injectable({ providedIn: 'root' })
export class SplitShellService {
    constructor (
        private app: AppService,
        private tabsService: TabsService,
        private profilesService: ProfilesService,
        private terminalService: TerminalService,
        private notifications: NotificationsService,
    ) {}

    async openShellInCurrentTab (side: SplitDirection = 'r'): Promise<void> {
        const root = this.app.activeTab
        if (!(root instanceof SplitTabComponent)) {
            this.notifications.info('No active tab to split')
            return
        }

        const focused = root.getFocusedTab() ?? root.getAllTabs()[0] ?? null
        if (!focused) {
            this.notifications.info('Active tab is empty')
            return
        }

        const cwd = await this.resolveCwd(focused)

        const baseProfile = await this.terminalService.getDefaultProfile()
        if (!baseProfile) {
            this.notifications.error('No default local profile configured')
            return
        }
        const profile = {
            ...baseProfile,
            options: { ...(baseProfile.options ?? {}), cwd },
        }

        const params = await this.profilesService.newTabParametersForProfile(profile)
        if (!params) {
            this.notifications.error('Could not build tab params for default profile')
            return
        }

        const newTab = this.tabsService.create(params)
        await root.addTab(newTab, focused, side)
    }

    private async resolveCwd (tab: BaseTabComponent): Promise<string> {
        if (tab instanceof BaseTerminalTabComponent) {
            const session = (tab as unknown as { session?: { getWorkingDirectory?: () => Promise<string|null> } }).session
            try {
                const cwd = await session?.getWorkingDirectory?.()
                if (cwd) {
                    return cwd
                }
            } catch {
                // fall through to HOME
            }
        }
        return process.env.HOME ?? '/'
    }
}
