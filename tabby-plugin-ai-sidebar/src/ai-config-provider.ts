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
            // List of cwds the user has right-click-pinned to the top of the
            // sidebar. Persisted so pins survive an app restart that brings
            // the same cwd back (Tabby session restore). Auto-evicted when
            // a previously-seen-this-session cwd disappears from the live
            // tab list (the "tab close removes pin" rule). See sidebar
            // component's prunePinnedCwds for the prune contract.
            pinnedCwds: [] as string[],
            // Master switch for "tab is restored → re-launch the AI agent
            // that was running in it at quit time". Default on because the
            // alternative ("restored tab is a bare shell, user has to
            // re-type `claude` everywhere") is what users were complaining
            // about. See AutoResumeService.
            autoResumeAgents: true,
            // Per-cwd record of which AI tool was running there at quit time
            // (or, more precisely, "last observed alive there during the
            // last session"). Captured every TabMonitor tick that sees an
            // aiTool, deleted when the user is observed quitting the agent
            // (had-agent → no-agent transition on the same outer tab).
            // Map shape, not a per-tab list, because cwd is the only stable
            // identifier across restarts.
            autoResumeAgentByCwd: {} as Record<string, string>,
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
