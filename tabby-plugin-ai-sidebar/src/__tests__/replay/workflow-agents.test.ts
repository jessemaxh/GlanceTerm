import { describe, it, expect } from 'vitest'

import { ReplayHarness, TraceEvent } from './harness'

/**
 * Harness `Workflow`-tool agents.
 *
 * Every shape here is taken from a REAL run captured in the local hook logs on
 * 2026-08-02 (`vidcatch-cross-review`, 41 agents / 29 minutes): the Workflow
 * tool's Pre+PostToolUse both fire at launch and carry no ids, each workflow
 * agent then emits its own in-flight Pre/PostToolUse with a top-level
 * `agent_id`, and ends with exactly one `SubagentStop`. Crucially the run
 * produced ZERO `spawn_agent_id` events — which is why the authoritative-spawn
 * `liveAgentIds` path is blind to them and the row showed idle for 29 minutes.
 */

const TAB = 'wf-tab'
let clock = 1_700_000_000

const ev = (e: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB,
    agent: 'claude',
    event: 'PostToolUse',
    ts: clock,
    ...e,
} as TraceEvent)

/** Launch a workflow (both events fire at launch, ~5s apart in the real trace). */
const launch = (h: ReplayHarness, at: number) => {
    clock = at
    h.process(ev({ event: 'PreToolUse', tool_name: 'Workflow', ts: at }))
    h.process(ev({ event: 'PostToolUse', tool_name: 'Workflow', ts: at }))
}
/** One in-flight tool event attributed to a workflow agent. */
const work = (h: ReplayHarness, agentId: string, at: number, event = 'PostToolUse') =>
    h.process(ev({ event, tool_name: 'Bash', agent_id: agentId, ts: at }))
const stop = (h: ReplayHarness, agentId: string, at: number) =>
    h.process(ev({ event: 'SubagentStop', agent_id: agentId, ts: at }))

describe('Workflow agents — passive tracking', () => {
    it('counts agents that never emit a spawn signal (the reported bug)', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        // Three agents show up only via their own tool events.
        work(h, 'a1', 1006)
        work(h, 'a2', 1007)
        work(h, 'a3', 1008)
        expect(h.getWorkflowInFlight(TAB)).toBe(3)
        // The exact, authoritative subagent count stays untouched — no spawn
        // signal was ever seen, so it must remain 0.
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('drains to 0 as each agent stops, and clears the workflow', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006); work(h, 'a2', 1007)
        stop(h, 'a1', 1200)
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
        stop(h, 'a2', 1300)
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
        // Past the arm grace → the run is over, so no stale elapsed timer.
        h.setNow(1_000_000 * 1000)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
    })

    it('does NOT track agent_ids on a tab that never launched a workflow', () => {
        const h = new ReplayHarness()
        work(h, 'orphan', 1006)          // bare agent_id, no workflow armed
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    // Real ordering hazard: a SubagentStop was written BETWEEN an agent's
    // PreToolUse and its PostToolUse in the SAME second. Without the tombstone
    // the trailing PostToolUse resurrects a finished agent — which is exactly
    // how 6 of 41 agents leaked in the captured run.
    it('a same-second trailing tool event cannot resurrect a stopped agent', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006, 'PreToolUse')
        stop(h, 'a1', 1010)
        work(h, 'a1', 1010, 'PostToolUse')   // same ts, arrives after the stop
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    // 12.7% of observed agent ids (55/432) emit tool calls and NEVER get a
    // SubagentStop. A tombstone can't bound those — only staleness can.
    it('expires an orphan that never stops, instead of pinning forever', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'orphan', 1006)
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
        h.setNow(1006 * 1000 + 599_000)       // just under the 10-min TTL
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
        h.setNow(1006 * 1000 + 601_000)       // past it
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    it('a busy agent inside one slow tool call is NOT expired (p99.9 gap = 293s)', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'slow', 1006, 'PreToolUse')
        h.setNow(1006 * 1000 + 293_000)       // observed worst-case quiet gap
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
    })

    it('a session boundary drops workflow state (no phantom across restarts)', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006)
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
        h.process(ev({ event: 'SessionStart', ts: 2000 }))
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
    })

    it('keeps the workflow armed at launch before any agent reports in', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        // Real runs took ~6s for the first agent's first tool call; the row must
        // not read "finished" during that window.
        h.setNow(1000 * 1000 + 5_000)
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * 1000)
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    it('re-launching a workflow restamps the start time', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006)
        stop(h, 'a1', 1100)
        launch(h, 5000)
        expect(h.getWorkflowStartedAt(TAB)).toBe(5000 * 1000)
    })
})
