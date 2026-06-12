import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'

/**
 * Hotkey ids GlanceTerm contributes to Tabby's hotkey registry. The default key
 * bindings for these ids live in `ai-config-provider.ts`; the user can rebind
 * any of them from Settings → Hotkeys like any other Tabby hotkey.
 */
@Injectable()
export class AiSidebarHotkeyProvider extends HotkeyProvider {
    private all: HotkeyDescription[] = [
        {
            id:   'ai-jump-next-attention',
            name: 'AI Tabs: Jump to next tab waiting on you',
        },
        {
            id:   'ai-jump-prev-attention',
            name: 'AI Tabs: Jump to previous tab waiting on you',
        },
        {
            id:   'ai-screenshot',
            name: 'AI Tabs: Screenshot → paste into the focused agent',
        },
        {
            id:   'ai-split-shell',
            name: 'AI Tabs: Toggle a shell pane beside the current tab',
        },
    ]

    async provide (): Promise<HotkeyDescription[]> {
        return this.all
    }
}
