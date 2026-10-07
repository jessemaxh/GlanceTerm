/**
 * Early warning for changes in Claude Code's hook output.
 *
 * Everything the sidebar knows about subagents comes from undocumented fields
 * in Claude's hook payloads, and those change without notice. When one does,
 * nothing breaks loudly — rows just read "ready" while agents work, and the
 * change is found weeks later from a screenshot. Twice so far:
 *   - SendMessage stopped returning the English phrase the handler keyed on.
 *     196 resumes in two weeks; 58 were recognised. Found from a screenshot.
 *   - A new built-in tool, SubagentHandback, appeared on 2026-09-24 and was
 *     not noticed at all until a log survey turned it up.
 *
 * This does not try to fix anything. It writes a `[drift]` line to debug.log
 * the first time it sees evidence of such a change, so the change is visible
 * the day it ships and can be handled deliberately:
 *
 *   untracked   A subagent is doing work but is not in the live count. This
 *               is the SYMPTOM, so it fires whatever field changed. Classified
 *               by what preceded it, which points at the likely cause.
 *   new-tool    A built-in tool name never seen before. New tools are how new
 *               agent mechanics arrive.
 *   sendmessage A SendMessage result the handler could not classify as either
 *               a resume or a queued message.
 *
 * Each distinct finding is logged once per app run, so a recurring problem
 * shows up as one line, not a flood. Only fed LIVE events — HookWatcher calls
 * it from inside its `eventAt >= startupTs` branch, so cold-loading old logs at
 * launch never replays historical drift.
 */

/** Built-in Claude Code tool names known at the time of writing. A name outside
 *  this list is reported once as `new-tool`; add it here once it is understood.
 *  MCP tools (`mcp__*`) are excluded — they come from the user's own config. */
export const KNOWN_CLAUDE_TOOLS: ReadonlySet<string> = new Set([
    'Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
    'NotebookEdit', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite',
    'TodoRead', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'Skill',
    'SlashCommand', 'ToolSearch', 'SendMessage', 'Workflow', 'Monitor',
    'TaskStop', 'TaskOutput', 'KillShell', 'BashOutput', 'ListAgents',
    'SubagentHandback', 'ScheduleWakeup', 'PushNotification', 'ReadNotifications',
    'SendUserFile', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete',
    'CronList', 'RemoteTrigger', 'Artifact', 'LSP',
])

/** Activity this soon after an agent's SubagentStop is a known trailing event,
 *  not a resumption (26% of agents emit one). Matches the subagent tombstone. */
const TRAILING_EVENT_MS = 60_000

/** A SendMessage this recently before the activity makes "resumed but not
 *  counted" the likely explanation. Real resumes start within ~20 s. */
const RESUME_WINDOW_MS = 60_000

/** Cap on remembered findings, so a pathological session can't grow memory. */
const MAX_KEYS = 5_000

export interface DriftEvent {
    tabId: string
    event: string
    toolName: string
    agentId: string
    agentType: string
    smResult: string
    source: string
    /** ms since epoch */
    at: number
}

export interface DriftContext {
    /** The agent id is in the authoritative live-subagent set. */
    tracked: boolean
    /** The tab has a harness Workflow running; its agents are tracked apart. */
    workflowRunning: boolean
}

export type DriftKind = 'untracked' | 'new-tool' | 'sendmessage'

export interface DriftFinding {
    kind: DriftKind
    message: string
}

export class DriftDetector {
    private readonly reported = new Set<string>()
    /** tab -> agent id -> last SubagentStop time */
    private readonly stoppedAt = new Map<string, Map<string, number>>()
    /** tab -> time of the main agent's last SendMessage */
    private readonly lastSendMessageAt = new Map<string, number>()

    /** Feed one live event. Returns the findings it produced, already deduped,
     *  so the caller only has to log them. */
    observe (ev: DriftEvent, ctx: DriftContext): DriftFinding[] {
        const out: DriftFinding[] = []
        const tab8 = ev.tabId.slice(0, 8)

        if (ev.event === 'SessionEnd' || (ev.event === 'SessionStart' && ev.source !== 'compact')) {
            this.stoppedAt.delete(ev.tabId)
            this.lastSendMessageAt.delete(ev.tabId)
        }

        if (ev.toolName && !ev.toolName.startsWith('mcp__') && !KNOWN_CLAUDE_TOOLS.has(ev.toolName)) {
            this.report(out, `tool:${ev.toolName}`, 'new-tool',
                `new tool "${ev.toolName}" (used by ${ev.agentId ? 'a subagent' : 'the main agent'}, tab ${tab8}) — not in KNOWN_CLAUDE_TOOLS; check whether it changes how agents start, stop or hand back`)
        }

        if (ev.toolName === 'SendMessage' && ev.event === 'PostToolUse' && !ev.agentId) {
            this.lastSendMessageAt.set(ev.tabId, ev.at)
            if (ev.smResult === 'unknown') {
                this.report(out, 'sm:unknown', 'sendmessage',
                    `SendMessage result was neither a resume nor a queued message (tab ${tab8}) — the result format may have changed; check the handler's resume detection`)
            }
        }

        if (ev.agentId && (ev.event === 'SubagentStop' || ev.event === 'StopFailure')) {
            let m = this.stoppedAt.get(ev.tabId)
            if (!m) {
                m = new Map()
                this.stoppedAt.set(ev.tabId, m)
            }
            m.set(ev.agentId, ev.at)
            return out
        }

        if (
            ev.agentId
            && (ev.event === 'PreToolUse' || ev.event === 'PostToolUse')
            && !ctx.tracked
            && !ctx.workflowRunning
            && ev.agentType !== 'workflow-subagent'
        ) {
            const stop = this.stoppedAt.get(ev.tabId)?.get(ev.agentId)
            if (stop !== undefined && ev.at - stop <= TRAILING_EVENT_MS) {
                return out
            }
            const sm = this.lastSendMessageAt.get(ev.tabId)
            let cause = 'active-after-stop: working again after its SubagentStop with no resume'
            if (stop === undefined) {
                cause = 'never-spawned: no spawn or resume signal was seen for it'
            } else if (sm !== undefined && sm >= stop && ev.at - sm <= RESUME_WINDOW_MS) {
                cause = 'resumed-uncounted: re-woken by SendMessage but not re-counted — the resume signal may have changed'
            }
            const id8 = ev.agentId.slice(0, 8)
            this.report(out, `untracked:${ev.tabId}:${ev.agentId}:${stop ?? 'none'}`, 'untracked',
                `untracked subagent ${id8}${ev.agentType ? ` (${ev.agentType})` : ''} on tab ${tab8} — ${cause}`)
        }
        return out
    }

    private report (out: DriftFinding[], key: string, kind: DriftKind, message: string): void {
        if (this.reported.has(key)) {
            return
        }
        if (this.reported.size >= MAX_KEYS) {
            this.reported.clear()
        }
        this.reported.add(key)
        out.push({ kind, message })
    }
}
