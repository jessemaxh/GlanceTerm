import type { AiTool, TabStatus } from '../tab-monitor'

/**
 * One hook event the adapter wants the agent to call us back on. Shape is
 * intentionally generic — Claude has `matcher` and `async`, Codex/Gemini
 * will likely have different knobs. Adapters serialize this into whatever
 * format their settings file expects.
 */
export interface HookEventEntry {
    /** Agent's own event name, e.g. "UserPromptSubmit" for Claude. */
    event: string
    /** Optional matcher (Claude-specific — narrows Notification events). */
    matcher?: string
    /** Whether the hook is synchronous (blocks the agent) or async. */
    async: boolean
}

export interface InstallReport {
    /** True if we wrote new entries; false if everything was already present. */
    installed: boolean
    /** Path we wrote to, for the installer UI and logs. */
    settingsPath: string
}

/**
 * Per-agent hook integration. Adding a new AI agent (codex, gemini, …)
 * = one new HookAdapter subclass + one registry entry — no other code touched.
 *
 * The plumbing assumes the agent supports a "shell out on lifecycle events"
 * hook mechanism that:
 *   1. Reads a settings JSON file at a well-known path.
 *   2. Inherits env vars from the spawning shell (so `GLANCETERM_TAB_ID` flows
 *      through to the hook handler we register).
 *   3. Lets us pipe a payload (typically JSON on stdin) into our handler.
 *
 * Agents without any such mechanism (aider, opencode, goose, …) get a degraded
 * "running / not running" experience via the process-tree detector, not via
 * an adapter — they never appear in this registry.
 */
export abstract class HookAdapter {
    /** Identifier — must match the AiTool string used elsewhere. */
    abstract readonly id: AiTool

    /** Human-readable name for installer dialogs. */
    abstract readonly displayName: string

    /**
     * Absolute path to the settings file we'll modify. Adapters resolve
     * platform-specific paths here (e.g. ~/.claude/settings.json on POSIX,
     * %APPDATA%\Claude\settings.json on Windows).
     */
    abstract configFilePath(): string

    /** List of lifecycle events we want to subscribe to. */
    abstract hookEvents(): HookEventEntry[]

    /**
     * Idempotently inject our hook entries into the settings file. MUST
     * preserve every other key the user had set. Should not throw on
     * malformed existing JSON — instead, log and bail (returning
     * installed=false).
     *
     * `handlerCommand` is a fully-formed, platform-correct command string
     * that the agent should invoke for each hook event (e.g.
     *   POSIX:   `'/home/me/.glanceterm/handlers/glanceterm-hook.sh' claude`
     *   Windows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "...\glanceterm-hook.ps1" claude`
     * ). Adapters embed it verbatim — they don't shell-quote, don't append
     * the agent id, don't re-derive platform branches. That's the
     * HookRuntimeService's job; centralising it there means a future
     * platform port (BSD shells, etc.) only touches one file.
     */
    abstract installHooks (handlerCommand: string): Promise<InstallReport>

    /**
     * Remove our entries. Same preserve-other-keys discipline. Reserved for
     * a future "Uninstall GlanceTerm hooks" command — currently unused.
     */
    abstract uninstallHooks (): Promise<void>

    /** Cheap check without writing. */
    abstract isInstalled (): Promise<boolean>

    /**
     * Map an event the handler observed → our TabStatus enum. Return `null`
     * for events that don't change visible status (e.g. PreCompact is
     * observability-only, SessionStart is ambiguous, etc.).
     */
    abstract mapEventToStatus (event: string, matcher?: string): TabStatus | null
}
