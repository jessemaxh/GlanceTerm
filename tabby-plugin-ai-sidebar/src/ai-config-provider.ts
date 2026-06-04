import { Injectable } from '@angular/core'
import { ConfigProvider, Platform } from 'tabby-core'

/**
 * Default key bindings for the hotkey ids declared in `AiSidebarHotkeyProvider`.
 * The base `defaults` covers Linux/Windows; `platformDefaults[macOS]` swaps in
 * the Mac glyph. Tabby merges these into the user's config on first run.
 */
@Injectable()
export class AiSidebarConfigProvider extends ConfigProvider {
    defaults = {
        hotkeys: {
            'ai-jump-next-attention': ['Ctrl-J'],
            'ai-jump-prev-attention': ['Ctrl-Shift-J'],
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'ai-jump-next-attention': ['⌘-J'],
                'ai-jump-prev-attention': ['⌘-Shift-J'],
            },
        },
    }
}
