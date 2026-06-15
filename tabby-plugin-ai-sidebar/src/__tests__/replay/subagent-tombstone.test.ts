import { describe, it, expect } from 'vitest'
import { ReplayHarness, TraceEvent } from './harness'

/**
 * Regression: the ~2 s reorder where Claude fires `SubagentStop` BEFORE the
 * `PostToolUse(Agent)` that announced the spawn. Without the tombstone, the late
 * authoritative spawn re-adds the just-stopped id → liveAgentIds never drains →
 * the row pins to "working · N agents" forever (the same symptom class as the
 * orphan-leak bug). The tombstone drops a spawn that arrives within
 * SUBAGENT_TOMBSTONE_TTL_MS (60 s) of that id's stop; a genuinely new spawn of
 * the same id past the window is honored. Reducer + phantom-stop are tested
 * elsewhere; this guards the processEvent-level tombstone.
 */

const TAB = 'tab-1'
const ev = (over: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB, agent: 'claude', event: 'PreToolUse', ts: 1000, ...over,
})

describe('subagent tombstone: late spawn after stop', () => {
    it('drops a PostToolUse(Agent) spawn that arrives within 60s of the stop', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aX', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        h.process(ev({ event: 'SubagentStop', agent_id: 'aX', ts: 1001 }))   // seeds tombstone @1001
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        // The reordered authoritative spawn lands 1 s later — must be dropped.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aX', ts: 1002 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0) // was 1 (stuck) without the tombstone
    })

    it('honors a genuinely new spawn of the same id past the 60s window', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aX', ts: 1000 }))
        h.process(ev({ event: 'SubagentStop', agent_id: 'aX', ts: 1001 }))   // tombstone @1001
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        // 99 s later (> 60 s TTL): a real re-spawn, not a reorder → counted.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aX', ts: 1100 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
    })
})
