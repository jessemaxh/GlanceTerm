import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { AppService, BaseTabComponent, HotkeysService, NotificationsService } from 'tabby-core'

import { ScreenshotService } from './screenshot/screenshot.service'
import { ScreenshotPasteService } from './screenshot/paste.service'
import { SplitShellService } from './split-shell.service'
import { TabMonitor, TabStatus } from './tab-monitor'

/**
 * Keyboard equivalents for the two sidebar toolbar buttons (screenshot +
 * shell-split), so they work without reaching for the mouse — and, crucially,
 * even when the AI sidebar panel is collapsed/hidden (you can't click a button
 * that isn't on screen).
 *
 * Why a dedicated, eagerly-bootstrapped service instead of handling the hotkey
 * inside the sidebar component: the component is only alive while the sidebar
 * panel is mounted. Tabby contributes the panel via SidebarProvider and can
 * tear the component down when hidden, which would silently kill the hotkeys.
 * This service is injected at module bootstrap (see index.ts) and subscribes to
 * the global `hotkey$` stream the same way AttentionJumperService does, so the
 * bindings are live for the whole app session regardless of sidebar visibility.
 *
 * Default bindings live in ai-config-provider.ts (Ctrl/⌘-Shift-G screenshot,
 * Ctrl/⌘-Shift-B split-shell); the ids are declared in AiSidebarHotkeyProvider
 * so they show up — and are rebindable — in Settings → Hotkeys.
 *
 * The screenshot path mirrors the button's `runCapture(false)`:
 *   - guard with the same "active tab must be an AI agent" pre-flight so a
 *     stray hotkey on a plain shell gets a friendly toast, not a silent no-op;
 *   - capture WITHOUT hiding the window (the common "snip another tab" case);
 *   - route the PNG through the per-agent paste adapter.
 * ScreenshotService.capture() carries its own `inProgress` re-entrancy guard,
 * so a hotkey fired mid-capture (or racing the button) is a safe no-op.
 */
@Injectable({ providedIn: 'root' })
export class AiHotkeyActionsService implements OnDestroy {
    private capturing = false
    private subs: Subscription[] = []

    constructor (
        private app: AppService,
        private notifications: NotificationsService,
        private screenshot: ScreenshotService,
        private screenshotPaste: ScreenshotPasteService,
        private splitShell: SplitShellService,
        private monitor: TabMonitor,
        hotkeys: HotkeysService,
    ) {
        this.subs.push(hotkeys.hotkey$.subscribe(id => {
            if (id === 'ai-screenshot') void this.screenshotActiveTab()
            if (id === 'ai-split-shell') void this.splitShell.toggleShellInCurrentTab('r')
        }))
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
    }

    /** Mirror of the toolbar button's "is the focused pane an AI agent" gate. */
    private activeTabIsAi (): boolean {
        const active = this.app.activeTab
        if (!active) return false
        const focusedInner = focusedInnerOf(active)
        const states = this.monitor.current
        const match = states.find(s => s.outerTab === active && s.innerTab === focusedInner)
            ?? states.find(s => s.outerTab === active)
        return !!(match && match.aiTool && match.status !== TabStatus.NoAi)
    }

    private async screenshotActiveTab (): Promise<void> {
        if (this.capturing) return
        this.capturing = true
        try {
            // Permission first, then the agent-tab gate: surface the Screen
            // Recording prompt regardless of which tab is focused, so a missing
            // permission isn't hidden behind "focus an AI agent tab".
            if (!await this.screenshot.ensureScreenPermission()) return
            if (!this.activeTabIsAi()) {
                this.notifications.info('Focus an AI agent tab (Claude, Codex, …) to use screenshot paste.')
                return
            }
            const result = await this.screenshot.capture({ hideWindow: false })
            if (!result) return   // user cancelled or capture failed
            await this.screenshotPaste.paste(result.buffer)
        } finally {
            this.capturing = false
        }
    }
}

/** A split's focused leaf, or the tab itself when it isn't a split. Mirrors the
 *  sidebar component's helper of the same name. */
function focusedInnerOf (outer: BaseTabComponent): BaseTabComponent {
    try {
        const fn = (outer as any).getFocusedTab
        if (typeof fn === 'function') {
            const inner = fn.call(outer)
            if (inner) return inner
        }
    } catch { /* fall through */ }
    return outer
}
