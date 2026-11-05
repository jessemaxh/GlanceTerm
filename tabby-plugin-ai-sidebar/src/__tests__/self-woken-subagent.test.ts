import { describe, expect, it } from 'vitest'

import { ReplayHarness, TraceEvent } from './replay/harness'

/**
 * A subagent that starts a background task and stops is re-woken by Claude
 * when the task finishes, with no hook for the wake — it just starts emitting
 * tool events again. Replays the real pattern from 2026-10-29: agent a2bcf8ce
 * started a Monitor, stopped at 17:24:24 and was back at work at 17:28:00,
 * while the only SendMessage in between resumed a different agent.
 */

const TAB = '5e917a62-1d75-4d81-8574-1129edad24e3'
const AGENT = 'a2bcf8ce00000000a'
const OTHER = 'a5c07e1600000000a'
const T0 = 1_790_000_000 // seconds

const ev = (e: Partial<TraceEvent>): TraceEvent => ({ tab_id: TAB, agent: 'claude', event: 'PostToolUse', ts: T0, ...e } as TraceEvent)
const tool = (agentId: string, ts: number, name = 'Bash') => ev({ event: 'PreToolUse', tool_name: name, agent_id: agentId, ts })

/** Spawned, worked, started a Monitor and stopped at T0+100. */
function stoppedAfterMonitor () {
    const h = new ReplayHarness()
    h.process(ev({ tool_name: 'Agent', spawn_agent_id: AGENT, ts: T0 }))
    h.process(tool(AGENT, T0 + 10))
    h.process(tool(AGENT, T0 + 97, 'Monitor'))
    h.process(ev({ event: 'SubagentStop', agent_id: AGENT, ts: T0 + 100 }))
    expect(h.getSubagentInFlight(TAB)).toBe(0)
    return h
}

describe('a subagent woken by its own background task', () => {
    it('is counted while it works and released at its next stop', () => {
        const h = stoppedAfterMonitor()
        h.process(ev({ tool_name: 'SendMessage', sm_result: 'resumed', resumed_agent_id: OTHER, ts: T0 + 274 } as Partial<TraceEvent>))
        expect(h.getSubagentInFlight(TAB)).toBe(1) // the other agent
        h.process(tool(AGENT, T0 + 316))
        expect(h.getSubagentInFlight(TAB)).toBe(2)
        h.process(tool(AGENT, T0 + 333))
        expect(h.getSubagentInFlight(TAB)).toBe(2)
        h.process(ev({ event: 'SubagentStop', agent_id: AGENT, ts: T0 + 380 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
    })

    it('can wake and be counted again after a second stop', () => {
        const h = stoppedAfterMonitor()
        h.process(tool(AGENT, T0 + 316))
        h.process(ev({ event: 'SubagentStop', agent_id: AGENT, ts: T0 + 380 }))
        h.process(tool(AGENT, T0 + 900))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
    })

    it('ignores the trailing event right after a stop', () => {
        const h = stoppedAfterMonitor()
        h.process(tool(AGENT, T0 + 159))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('never counts an agent that was not spawned or resumed here', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'SubagentStop', agent_id: 'orphan00000000000', ts: T0 }))
        h.process(tool('orphan00000000000', T0 + 300))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('stops counting after 15 minutes of silence, and counts again on its next event', () => {
        const h = stoppedAfterMonitor()
        h.process(tool(AGENT, T0 + 316))
        h.setNow((T0 + 316) * 1000 + 14 * 60_000)
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        h.setNow((T0 + 316) * 1000 + 16 * 60_000)
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        h.process(tool(AGENT, T0 + 316 + 17 * 60))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
    })

    it('is not counted twice when a SendMessage then resumes it', () => {
        const h = stoppedAfterMonitor()
        h.process(tool(AGENT, T0 + 316))
        h.process(ev({ tool_name: 'SendMessage', sm_result: 'resumed', resumed_agent_id: AGENT, ts: T0 + 400 } as Partial<TraceEvent>))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        h.process(ev({ event: 'SubagentStop', agent_id: AGENT, ts: T0 + 500 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('is forgotten at a session boundary', () => {
        const h = stoppedAfterMonitor()
        h.process(tool(AGENT, T0 + 316))
        h.process(ev({ event: 'SessionStart', source: 'startup', ts: T0 + 400 } as Partial<TraceEvent>))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        h.process(tool(AGENT, T0 + 800))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('is cleared by "Reset agent status"', () => {
        const h = stoppedAfterMonitor()
        h.process(tool(AGENT, T0 + 316))
        expect(h.watcher.clearSideChannel(TAB)).toBe(true)
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        h.process(tool(AGENT, T0 + 800))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('is not counted on a tab running a workflow', () => {
        const h = stoppedAfterMonitor()
        h.process(ev({ tool_name: 'Workflow', ts: T0 + 200 }))
        h.process(tool(AGENT, T0 + 316))
        expect(h.liveAgentIdsFor(TAB).size).toBe(0)
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })
})
