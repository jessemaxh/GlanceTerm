import { describe, it, expect } from 'vitest'
import { ReplayHarness, TraceEvent } from './harness'

/**
 * Regression: a subagent that ends abnormally via `StopFailure` (interrupt /
 * stream timeout / error) must be REMOVED from the in-flight set, not re-added.
 *
 * Bug (introduced with the StopFailure subscription, commit a4bf2448): the
 * subagent reducer only treated `SubagentStop` as a stop; a `StopFailure`
 * carrying the subagent's agent_id fell into the passive-liveness branch and
 * was pushed as a SPAWN. The subagent never left `liveAgentIds`, so
 * getSubagentInFlight stayed ≥1 and TabMonitor's idle→working override pinned
 * the row to "working · N agents" forever after the main agent had finished.
 * Reproduced by any interrupted/timed-out subagent — matches the real trace
 * (agent a7051886… whose last event was `StopFailure`, never `SubagentStop`).
 */

const TAB = 'tab-1'
const ev = (over: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB, agent: 'claude', event: 'PreToolUse', ts: 1000, ...over,
})

describe('subagent StopFailure clears the in-flight count', () => {
    it('a subagent ending via StopFailure is removed (not re-added as a spawn)', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aSUB', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        // passive liveness during the subagent's run — a no-op while live
        h.process(ev({ event: 'PostToolUse', tool_name: 'Bash', agent_id: 'aSUB', ts: 1001 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        // abnormal end — the subagent's terminal event is StopFailure
        h.process(ev({ event: 'StopFailure', agent_id: 'aSUB', ts: 1002 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)   // was 1 (leak) before the fix
    })

    it('normal SubagentStop still works (guard against over-correcting)', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aSUB', ts: 1000 }))
        h.process(ev({ event: 'SubagentStop', agent_id: 'aSUB', ts: 1001 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('the MAIN agent\'s StopFailure (no agent_id) does NOT clear a live subagent', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aSUB', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        // main agent's own turn fails — no agent_id; the backgrounded subagent
        // is still running and must stay counted.
        h.process(ev({ event: 'StopFailure', ts: 1002 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
    })

    it('StopFailure for an unknown subagent is a harmless no-op', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'StopFailure', agent_id: 'aGHOST', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('two subagents, one StopFailure + one SubagentStop, both drain to zero', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aA', ts: 1000 }))
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aB', ts: 1001 }))
        expect(h.getSubagentInFlight(TAB)).toBe(2)
        h.process(ev({ event: 'StopFailure', agent_id: 'aA', ts: 1002 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        h.process(ev({ event: 'SubagentStop', agent_id: 'aB', ts: 1003 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })
})
