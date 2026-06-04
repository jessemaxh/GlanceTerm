import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'

/**
 * Hotkey ids HiveTerm contributes to Tabby's hotkey registry. The default key
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
    ]

    async provide (): Promise<HotkeyDescription[]> {
        return this.all
    }
}
