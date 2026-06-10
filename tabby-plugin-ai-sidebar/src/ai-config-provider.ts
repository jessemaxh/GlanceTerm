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
            // Per-cwd record of the re-runnable command to launch the AI
            // tool that was running there at quit time (or, more precisely,
            // "last observed alive there during the last session"), plus
            // the COUNT of distinct outer tabs at that cwd that had an
            // agent. Command is the line typed into the restored shell
            // with flags preserved — e.g. `claude --resume`,
            // `codex --model gpt-5`. Count gates how many restored tabs
            // sharing the same cwd actually get the relaunch on next
            // start: 3 tabs in /repo with only 1 having had claude
            // resume claude exactly once, not three times. Captured
            // every TabMonitor tick that sees an aiTool by reducing the
            // raw `ps` cmdline (which may include the node interpreter
            // and absolute paths) to a portable invocation. Decremented
            // when the user is observed quitting the agent in one of
            // the tabs (had-agent → no-agent transition); fully
            // deleted when the count reaches 0. Map keyed by cwd, not
            // per-tab, because cwd is the only stable identifier
            // across restarts. Reads also accept the legacy bare-
            // string shape from pre-fix installs — see
            // `parsePersistedEntry`.
            autoResumeCommandByCwd: {} as Record<string, string | { command: string; count: number }>,
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
