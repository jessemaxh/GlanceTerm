/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule, Injectable } from '@angular/core'
import { CommonModule } from '@angular/common'
import { NgbTooltipModule } from '@ng-bootstrap/ng-bootstrap'
import {
    ConfigProvider,
    HotkeyProvider,
    SidebarProvider,
    SidebarContribution,
    SidebarService,
    ToolbarButtonProvider,
    ToolbarButton,
    TabContextMenuItemProvider,
} from 'tabby-core'
import { IMAGE_PASTE_HOOK } from 'tabby-terminal'

import { AiSidebarComponent } from './sidebar.component'
import { AiSidebarConfigProvider } from './ai-config-provider'
import { AiSidebarHotkeyProvider } from './ai-hotkey-provider'
import { AttentionJumperService } from './attention-jumper.service'
import { AiHotkeyActionsService } from './ai-hotkey-actions.service'
import { AttentionNotifierService } from './attention-notifier.service'
import { TabMonitor } from './tab-monitor'
import { UnreadService } from './unread.service'
import { HookAdapterRegistry } from './hook-adapters/registry'
import { HookRuntimeService } from './hook-runtime.service'
import { HookInstallerService } from './hook-installer.service'
import { HookWatcherService } from './hook-watcher.service'
import { AutoApproveService } from './auto-approve.service'
import { AutoResumeService } from './auto-resume.service'
import { ScreenshotService } from './screenshot/screenshot.service'
import { ScreenshotPasteService } from './screenshot/paste.service'
import { ImagePasteHookService } from './image-paste-hook.service'
import { SplitShellService } from './split-shell.service'
import { WorktreeService } from './worktree.service'
import { WorktreeActionsService, WorktreeContextMenu } from './worktree-actions.service'
import { EscInterruptService } from './esc-interrupt.service'
import { UpdateCheckService } from './update-check.service'
import { UpdateForceModalComponent } from './update-force-modal.component'
import { DebugLogService } from './debug-log.service'
import { TokenStatsTabComponent } from './token-stats-tab.component'

// Public exports for cross-plugin consumers (currently
// tabby-plugin-mobile-bridge). Surface kept deliberately narrow — every
// added export becomes a contract that downstream plugins compile and
// link against. Removing or renaming requires touching every importer.
export { TabMonitor, TabStatus } from './tab-monitor'
export type { TabState, AiTool } from './tab-monitor'
export { SidebarSettingsRegistry } from './sidebar-settings-registry.service'
export type { SidebarSettingsSection, SectionStatus, SectionStatusTone } from './sidebar-settings-registry.service'
export { HookWatcherService } from './hook-watcher.service'
export type { HookSnapshot } from './hook-watcher.service'

const BASE_ICON_INNER = `
  <rect x="1" y="2" width="5" height="12" rx="1" fill="currentColor" opacity="0.85"/>
  <rect x="7" y="2" width="8" height="3" rx="1" fill="currentColor" opacity="0.55"/>
  <rect x="7" y="6" width="8" height="3" rx="1" fill="currentColor" opacity="0.55"/>
  <rect x="7" y="10" width="8" height="4" rx="1" fill="currentColor" opacity="0.55"/>`

/**
 * Compose the toolbar icon with an optional count badge baked in. We embed
 * the badge inside the SVG (rather than as an HTML overlay) so we don't have
 * to touch tabby-core's toolbar template — the existing `fastHtmlBind` path
 * already re-renders whenever `Command.icon` changes, and `Command.icon` is
 * now a getter that reads through to this function on every CD cycle (see
 * tabby-core/src/api/commands.ts: Command.fromToolbarButton).
 *
 * Display rule: 0 → no badge; 1–9 → digit; ≥10 → "9+" so the bubble stays
 * legible at 16px viewBox.
 */
function makeToolbarIcon (count: number): string {
    let badge = ''
    if (count > 0) {
        const label = count > 9 ? '9+' : String(count)
        // Position at top-right, leave a touch of breathing room from the edge.
        badge = `
  <circle cx="13" cy="3" r="3" fill="#FF5252" stroke="var(--bs-body-bg, #1C1F23)" stroke-width="0.8"/>
  <text x="13" y="4.6" text-anchor="middle" font-family="ui-monospace, monospace" font-size="4.2" font-weight="700" fill="#fff">${label}</text>`
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${BASE_ICON_INNER}${badge}\n</svg>`
}

@Injectable()
class AiSidebarContribProvider extends SidebarProvider {
    provide (): SidebarContribution[] {
        return [{
            id: 'ai-sidebar',
            title: 'AI Tabs',
            component: AiSidebarComponent,
            side: 'left',
            defaultWidth: 440,
            // Floor chosen so the row's basic info stays readable at the
            // narrowest drag: body width ≈ slotWidth − 169px (num/rail/meta/
            // gaps/padding/scrollbar), so 360px leaves ~190px of body — enough
            // to keep the agent+model label and the "Nk input Nk output" token
            // line each on a single line instead of wrapping/ellipsising.
            minWidth: 360,
            maxWidth: 720,
            defaultVisible: true,
        }]
    }
}

@Injectable()
class ToggleAiSidebarButtonProvider extends ToolbarButtonProvider {
    constructor (private sidebar: SidebarService, private unread: UnreadService) {
        super()
    }
    provide (): ToolbarButton[] {
        // `icon` is a getter so the badge updates without re-running provide().
        // Command.fromToolbarButton (in our fork of tabby-core) defines its
        // own `icon` as a getter that reads through to this one — change
        // detection naturally re-evaluates the binding on every CD cycle.
        const unread = this.unread
        return [{
            get icon () { return makeToolbarIcon(unread.count) },
            title: 'Toggle AI Tabs sidebar',
            weight: 5,
            click: () => this.sidebar.toggle('ai-sidebar'),
        }]
    }
}

@NgModule({
    imports: [CommonModule, NgbTooltipModule],
    declarations: [AiSidebarComponent, UpdateForceModalComponent, TokenStatsTabComponent],
    providers: [
        HookAdapterRegistry,
        HookRuntimeService,
        HookWatcherService,
        HookInstallerService,
        AutoApproveService,
        AutoResumeService,
        TabMonitor,
        UnreadService,
        AttentionJumperService,
        AiHotkeyActionsService,
        AttentionNotifierService,
        ScreenshotService,
        ScreenshotPasteService,
        ImagePasteHookService,
        SplitShellService,
        WorktreeService,
        WorktreeActionsService,
        EscInterruptService,
        UpdateCheckService,
        { provide: SidebarProvider,       useClass: AiSidebarContribProvider,      multi: true },
        { provide: ToolbarButtonProvider, useClass: ToggleAiSidebarButtonProvider, multi: true },
        { provide: HotkeyProvider,        useClass: AiSidebarHotkeyProvider,       multi: true },
        { provide: ConfigProvider,        useClass: AiSidebarConfigProvider,       multi: true },
        { provide: TabContextMenuItemProvider, useClass: WorktreeContextMenu,       multi: true },
        // Hook into BaseTerminalTabComponent.paste() so a PNG on the system
        // clipboard turns into a temp-file path typed into the focused terminal.
        // Hook lives in our plugin; the vendored conditional in
        // tabby-terminal's paste() is one line. Image-clipboard absent → hook
        // returns false → default text paste runs.
        { provide: IMAGE_PASTE_HOOK,      useExisting: ImagePasteHookService },
    ],
})
export default class AiSidebarModule {
    /**
     * Eagerly inject every long-lived service so they subscribe at startup,
     * even before any UI consumer reads them. The hook installer kicks off
     * the settings.json install in its constructor; the watcher starts its
     * fs.watch the same way.
     */
    constructor (
        // FIRST so the unified debug log rotates a fresh file + tees the global
        // console.warn/error before any other service can emit — see
        // DebugLogService / ~/.glanceterm/debug.log.
        _dbg: DebugLogService,
        _j: AttentionJumperService,
        _n: AttentionNotifierService,
        _u: UnreadService,
        _i: HookInstallerService,
        _w: HookWatcherService,
        _s: SplitShellService,
        // Eager-inject so the constructor's flag-file reconcile runs at
        // startup — otherwise the file would only appear the first time the
        // sidebar component reaches the service via the toolbar button.
        _a: AutoApproveService,
        // Eager-inject so the replay window starts ticking at app launch,
        // not the first time the sidebar component is rendered. Without
        // this, opening GlanceTerm with the sidebar hidden would skip
        // auto-resume entirely.
        _r: AutoResumeService,
        // Eager-inject so per-tab ESC sniffers are armed before the user
        // ever switches focus. Without this the first ESC in a freshly
        // launched session would land before the service had subscribed.
        _e: EscInterruptService,
        // Eager-inject so the screenshot / split-shell hotkeys are live for the
        // whole session — including while the sidebar panel is hidden (you
        // can't click a toolbar button that isn't on screen).
        _h: AiHotkeyActionsService,
        // Eager-inject so the remote update check schedules itself at launch
        // (first check + interval) without waiting for any UI consumer.
        _uc: UpdateCheckService,
    ) {
        // eslint-disable-next-line no-console
        console.log('[glanceterm] plugin loaded')
    }
}
