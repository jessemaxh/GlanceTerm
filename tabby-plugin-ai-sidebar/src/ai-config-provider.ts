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
            // G = "grab" a screenshot, B = shell "beside" the agent. Both land
            // in GlanceTerm's free Ctrl-Shift-letter space (rebindable in
            // Settings → Hotkeys).
            'ai-screenshot': ['Ctrl-Shift-G'],
            'ai-split-shell': ['Ctrl-Shift-B'],
        },
        ai: {
            // Play a short chime when an AI tab transitions working → done.
            // Pairs with the existing OS notification + sidebar badge.
            // Default on — losing the badge happens easily when the window is
            // backgrounded; a sound makes the transition impossible to miss.
            soundOnReady: true,
            // Auto-approve Claude Code permission prompts (Bash(rm *), etc.)
            // by responding `allow` to its synchronous PermissionRequest hook.
            // OFF by default — flipping it ON gives the AI free rein to run
            // any command without user confirmation. UI shows a confirm
            // dialog on first enable; see AutoApproveService.
            autoApprovePermissions: false,
            // Hide rows for tabs that don't have an AI agent running (raw
            // status `no_ai`). OFF by default — a fresh shell IS a row in
            // the sidebar, dimmed via the no_ai opacity rule, so users
            // notice when they have terminals open but unused. Flip ON
            // when running many AI agents and the plain-shell rows are
            // pure noise.
            // User-pinned cwds (right-click → Pin to top) bypass this
            // filter — the explicit pin gesture overrides the bulk rule.
            hideTabsWithoutAgent: false,
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
            // Sub-switch under autoResumeAgents: when a tab is restored, resume
            // the agent's EXACT prior session (`claude --resume <id>`,
            // `codex resume <id>`, `opencode --session <id>`) instead of a
            // fresh conversation. Default on — "bring my tab back where I left
            // it" is the expected behaviour. Off → fall back to re-launching
            // the bare captured command (a new session). No effect for agents
            // without resume-by-id (Gemini) or before a session id is captured.
            // See AutoResumeService.buildResumeCommand.
            autoResumeSession: true,
            // NOTE: the re-runnable command per terminal is no longer stored
            // in config. It rides each tab's own Tabby recovery token
            // (TerminalTabComponent.glancetermResumeCommand) so two tabs
            // sharing a cwd but running different agents each get their own
            // command back. See AutoResumeService. The old cwd-keyed
            // `autoResumeCommandByCwd` map has been removed — any leftover
            // entry in a user's config is simply ignored.

            // Remote update check (see UpdateCheckService). Reads a small JSON
            // from `configUrl` holding `latest`/`minimum` versions: newer than
            // running → dismissible notify; below `minimum` → forced update
            // gate. Fail-open: any fetch/parse error is a silent no-op.
            updateCheck: {
                enabled: true,
                // Empty by default → the check is a no-op until pointed at a
                // hosted JSON endpoint. Set this to your update-config URL
                // (Cloudflare Worker / R2 / GitHub raw) to switch it on.
                configUrl: '',
                // Poll cadence in hours; first check fires shortly after launch.
                intervalHours: 6,
            },
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'ai-jump-next-attention': ['⌘-J'],
                'ai-jump-prev-attention': ['⌘-Shift-J'],
                'ai-screenshot': ['⌘-Shift-G'],
                'ai-split-shell': ['⌘-Shift-B'],
            },
        },
    }
}
