import { describe, it, expect } from 'vitest'
import { ReplayHarness, TraceEvent } from './harness'

/**
 * Regression: an "idle but `working · 1 agent`" tab.
 *
 * Bug: the subagent live-count had a PASSIVE-LIVENESS add path — ANY hook event
 * carrying a top-level `agent_id` (e.g. a PreToolUse/PostToolUse from inside a
 * subagent's turn) was pushed as a SPAWN. But Claude Code emits `agent_id`s on
 * tool calls that never get a matching `SubagentStop` (orphan/transient ids). In
 * the real trace, `af57c354b79259bc4` fired a single `PreToolUse(Bash)` and
 * nothing else — no spawn, no stop. The passive path inserted it into
 * `liveAgentIds`, where it could never be removed (the only decrement is a
 * SubagentStop/StopFailure carrying that id, and the set is otherwise cleared
 * only on SessionStart/SessionEnd; the main agent's `Stop` doesn't touch it).
 * So `getSubagentInFlight` stayed ≥1 and TabMonitor's idle→working override
 * pinned the tab to "working · 1 agent" while the main agent sat idle.
 *
 * Fix: ADD is authoritative-only — only `PostToolUse(Agent/Task).spawn_agent_id`
 * creates a tracked id. A bare top-level `agent_id` only ever produces a STOP
 * (on SubagentStop/StopFailure). No time-based TTL: every counted id is a real
 * Task spawn, which reliably emits a matching stop, so the set drains to 0 by
 * construction.
 */

const TAB = 'tab-1'
const ev = (over: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB, agent: 'claude', event: 'PreToolUse', ts: 1000, ...over,
})

describe('orphan passive agent_id never inflates the in-flight count', () => {
    it('a bare agent_id with no authoritative spawn is NOT counted', () => {
        const h = new ReplayHarness()
        // Exactly the leaker: one tool call carrying a top-level agent_id that
        // was never spawned and never stopped.
        h.process(ev({ event: 'PreToolUse', tool_name: 'Bash', agent_id: 'af57c354', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)   // was 1 (leak) before the fix
    })

    it('the reported scenario: real bg agent drains, main goes idle, orphan stays 0', () => {
        const h = new ReplayHarness()
        // A real run_in_background subagent spawns, works, and finishes.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aBG', ts: 1000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        h.process(ev({ event: 'PostToolUse', tool_name: 'Bash', agent_id: 'aBG', ts: 1001 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)   // passive sighting of a tracked id = no-op
        h.process(ev({ event: 'SubagentStop', agent_id: 'aBG', ts: 1002 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        // Main agent's turn ends — idle, at the prompt. (No agent_id.)
        h.process(ev({ event: 'Stop', ts: 1003 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        // Now the orphan tool call + a phantom stop for an id we never spawned.
        h.process(ev({ event: 'PreToolUse', tool_name: 'Bash', agent_id: 'af57c354', ts: 1004 }))
        h.process(ev({ event: 'SubagentStop', agent_id: 'aGHOST', ts: 1005 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)   // stays idle — the actual bug
    })

    it('a genuinely-running bg subagent still holds the count after main Stop', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'aBG', ts: 1000 }))
        // Main agent finishes its turn but the backgrounded subagent runs on.
        h.process(ev({ event: 'Stop', ts: 1001 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)   // must NOT be cleared by main Stop
        h.process(ev({ event: 'PostToolUse', tool_name: 'Bash', agent_id: 'aBG', ts: 1002 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        h.process(ev({ event: 'SubagentStop', agent_id: 'aBG', ts: 1003 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)   // drains when the real subagent ends
    })
})
