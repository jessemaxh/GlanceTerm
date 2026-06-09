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

    /**
     * True when this adapter's hook payloads carry an authoritative
     * "this Bash invocation is backgrounded" signal for EVERY Bash call —
     * i.e. the handler writes `bg=1` when the agent intends to background
     * the shell, and `bg=0` (or absent) otherwise. When true, TabMonitor
     * trusts the hook absolutely: child processes that weren't claimed by
     * a `bg=1` event are NOT bg jobs, even if they're long-lived. This
     * eliminates the "long synchronous Bash gets falsely badged as bg"
     * over-count the persistence-time heuristic suffers from.
     *
     * Defaults to false: adapters that haven't been audited against the
     * "every Bash gets a bg classification" contract fall through to the
     * heuristic, which over-counts on long synchronous calls but keeps
     * bg detection working without per-call hook coverage.
     */
    signalsBgJobs (): boolean {
        return false
    }

    /**
     * True when this agent CLI maintains a long-lived native helper child
     * under the agent's own pid — visible to our process-tree scan from the
     * moment the agent launches, BEFORE any hook event arrives. The bg-job
     * heuristic (child persisted for ≥BG_PERSIST_MS) would otherwise badge
     * that helper as `1 bg` forever.
     *
     * When true, TabMonitor treats the adapter as hook-authoritative even
     * BEFORE the first hook event for this tab — the heuristic is
     * suppressed and the hook's bg arrivals queue is the only source of
     * truth for bg-job counts. Cost: real bg jobs that occur before the
     * first hook event are hidden until that event lands; for agents with
     * working hooks this window is sub-second.
     *
     * When false (default), the heuristic runs in the gap between tab
     * launch and first hook event — necessary for agents like Claude
     * whose hook may install AFTER the agent starts (the install runs at
     * GlanceTerm startup, but the user may have already started Claude in
     * a tab spawned before install completed).
     *
     * Codex spawns a node + native worker pair. Claude does not.
     */
    spawnsNativeHelper (): boolean {
        return false
    }
}
