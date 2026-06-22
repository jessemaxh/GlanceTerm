import { describe, it, expect } from 'vitest'
import { ReplayHarness, TraceEvent } from './harness'
import { TabStatus } from '../../tab-monitor'

/**
 * Regression: a tab that should read "needs you" shows "working".
 *
 * Observed live (tab "hark"): the MAIN agent presented an AskUserQuestion and
 * blocked waiting for the user — PermissionRequest(AskUserQuestion) correctly set
 * the row to needs_permission. But the agent also had a BACKGROUNDED reviewer
 * subagent still running, whose Bash/Read tool events (PreToolUse/PostToolUse,
 * each carrying the subagent's `agent_id`) map to `working` and clobbered
 * needs_permission. The row sat on "working" for the whole ~5-minute wait, until
 * the user finally answered.
 *
 * Fix: a hook event carrying an `agent_id` is from a SUBAGENT, not the main
 * agent, so it must not drive the main row status. Claude emits no agent_id on
 * the main agent's own events (verified: main Pre/PostToolUse, Stop, and the
 * AskUserQuestion PermissionRequest all have agent_id absent).
 */

const TAB = 'tab-1'
const ev = (over: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB, agent: 'claude', event: 'PreToolUse', ts: 1000, ...over,
})

describe('subagent tool events do not clobber the main agent status', () => {
    it('main agent at AskUserQuestion stays needs_permission while a bg subagent runs tools', () => {
        const h = new ReplayHarness()
        // A backgrounded reviewer subagent is spawned and running.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aBG', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)

        // Main agent asks a question (no agent_id) → needs you.
        h.process(ev({ event: 'PreToolUse', tool_name: 'AskUserQuestion', ts: 1001 }))
        h.process(ev({ event: 'PermissionRequest', tool_name: 'AskUserQuestion', ts: 1001 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.NeedsPermission)

        // The backgrounded subagent keeps firing tools (each carries agent_id).
        // Before the fix these mapped to `working` and clobbered needs_permission.
        h.process(ev({ event: 'PreToolUse', tool_name: 'Bash', agent_id: 'aBG', ts: 1002 }))
        h.process(ev({ event: 'PostToolUse', tool_name: 'Bash', agent_id: 'aBG', ts: 1003 }))
        h.process(ev({ event: 'PreToolUse', tool_name: 'Read', agent_id: 'aBG', ts: 1004 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.NeedsPermission) // was Working before the fix

        // Subagent finishes — still needs you.
        h.process(ev({ event: 'SubagentStop', agent_id: 'aBG', ts: 1005 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.NeedsPermission)

        // User answers → AskUserQuestion PostToolUse from the MAIN agent (no
        // agent_id) → working (unsticks needs_permission, as designed).
        h.process(ev({ event: 'PostToolUse', tool_name: 'AskUserQuestion', ts: 1006 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
    })

    it('main agent events (no agent_id) still drive status normally', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PreToolUse', tool_name: 'Bash', ts: 1000 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
        h.process(ev({ event: 'Stop', ts: 1001 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
    })
})
