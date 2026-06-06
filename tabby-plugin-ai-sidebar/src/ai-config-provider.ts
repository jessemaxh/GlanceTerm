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
        ai: {
            // Play a short chime when an AI tab transitions working → done.
            // Pairs with the existing OS notification + sidebar badge.
            // Default on — losing the badge happens easily when the window is
            // backgrounded; a sound makes the transition impossible to miss.
            soundOnReady: true,
            // Hide the GlanceTerm window during the screenshot grab so it
            // doesn't end up in the captured frame. Default on because the
            // common case is "screenshot something OTHER than GlanceTerm to
            // share with the agent" — but expose a toggle so users who want
            // to capture content from another GlanceTerm tab can flip it off.
            screenshotHideWindow: true,
            // Auto-approve Claude Code permission prompts (Bash(rm *), etc.)
            // by responding `allow` to its synchronous PermissionRequest hook.
            // OFF by default — flipping it ON gives the AI free rein to run
            // any command without user confirmation. UI shows a confirm
            // dialog on first enable; see AutoApproveService.
            autoApprovePermissions: false,
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
