import { describe, it, expect } from 'vitest'
import { ReplayHarness, TraceEvent } from './harness'

/**
 * Regression: a backgrounded subagent that FINISHED its task and is later
 * woken by `SendMessage` ("Agent X had no active task; resumed from transcript
 * in the background") runs again, but the wake goes through the SendMessage
 * tool — NOT the Agent tool — so it fires NO `spawn_agent_id`. Before the fix
 * the resumed run was invisible to liveAgentIds: the main agent's Stop dropped
 * the row to idle/"ready" while the subagent kept working (observed live: one
 * Agent-tool spawn but several SubagentStops as the same id was re-messaged
 * across a session — 1 spawn / 4 stops for aa4986…, 1 / 8 for aa4196…).
 *
 * The handler now emits `resumed_agent_id = tool_input.to` ONLY on the
 * confirmed-resume result, and processEvent treats it as an authoritative
 * spawn that BYPASSES the tombstone (a resume is a distinct explicit signal,
 * not the ~2 s-late PostToolUse(Agent) echo the tombstone defends against).
 * It drains via the same SubagentStop(agent_id=to) the resumed agent fires.
 */

const TAB = 'tab-1'
const ev = (over: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB, agent: 'claude', event: 'PreToolUse', ts: 1000, ...over,
})

describe('subagent resume via SendMessage', () => {
    it('counts a dormant background subagent that a message wakes', () => {
        const h = new ReplayHarness()
        // Original Agent-tool spawn + first task completes → back to 0.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'a04c31', ts: 1000 }))
        h.process(ev({ event: 'SubagentStop', agent_id: 'a04c31', ts: 1001 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)

        // Much later, the main agent SendMessages it → Claude resumes it in the
        // background. Before the fix this stayed 0 (row read "ready" while it ran).
        h.process(ev({ event: 'PostToolUse', tool_name: 'SendMessage', resumed_agent_id: 'a04c31', ts: 5000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        expect(h.liveAgentIdsFor(TAB).has('a04c31')).toBe(true)

        // The resumed run finishes → drains via the normal SubagentStop path.
        h.process(ev({ event: 'SubagentStop', agent_id: 'a04c31', ts: 5200 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('bypasses the tombstone — a resume within 60s of the stop still counts', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aX', ts: 1000 }))
        h.process(ev({ event: 'SubagentStop', agent_id: 'aX', ts: 1001 }))   // seeds tombstone @1001
        expect(h.getSubagentInFlight(TAB)).toBe(0)

        // A *spawn* 1 s later would be dropped as a late echo (see
        // subagent-tombstone.test.ts). A *resume* is a distinct explicit
        // signal — the user read the output and immediately re-messaged — so it
        // must NOT be suppressed by the tombstone.
        h.process(ev({ event: 'PostToolUse', tool_name: 'SendMessage', resumed_agent_id: 'aX', ts: 1002 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
    })

    it('does NOT add on a "Message queued" SendMessage (handler leaves the field empty)', () => {
        const h = new ReplayHarness()
        // Agent already active → the real handler emits no resumed_agent_id.
        // Such an event must be a pure status/no-op for the counter.
        const changed = h.process(ev({ event: 'PostToolUse', tool_name: 'SendMessage', ts: 2000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        // It still maps to a status (working) for the main agent, so it's not a
        // full no-op — just no counter mutation. (Asserting the counter is the
        // contract that matters here.)
        void changed
    })

    it('handles repeated wake→finish cycles, draining each time (1 spawn, N stops)', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aa4196', ts: 1000 }))
        h.process(ev({ event: 'SubagentStop', agent_id: 'aa4196', ts: 1100 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)

        for (let i = 0; i < 3; i++) {
            const base = 2000 + i * 1000
            h.process(ev({ event: 'PostToolUse', tool_name: 'SendMessage', resumed_agent_id: 'aa4196', ts: base }))
            expect(h.getSubagentInFlight(TAB)).toBe(1)
            h.process(ev({ event: 'SubagentStop', agent_id: 'aa4196', ts: base + 500 }))
            expect(h.getSubagentInFlight(TAB)).toBe(0)
        }
    })

    it('is idempotent — resuming an id already in flight does not double-count', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'SendMessage', resumed_agent_id: 'aZ', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        // A second resume for the same still-running id is a no-op (Set add).
        h.process(ev({ event: 'PostToolUse', tool_name: 'SendMessage', resumed_agent_id: 'aZ', ts: 1010 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        h.process(ev({ event: 'SubagentStop', agent_id: 'aZ', ts: 1100 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('resets the resumed id on a session boundary', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'SendMessage', resumed_agent_id: 'aB', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        // A fresh session (crash-restart, /clear) must not carry the id over.
        h.process(ev({ event: 'SessionStart', source: 'startup', ts: 1200 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })
})
