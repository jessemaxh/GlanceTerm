import { describe, it, expect } from 'vitest'

import { ReplayHarness, TraceEvent } from './harness'
import { resolveRawStatus, TabStatus } from '../../tab-monitor'

/**
 * Harness `Workflow`-tool agents.
 *
 * Every shape and every timing constant asserted here comes from the four real
 * workflow runs captured in the local hook logs (72 agents total; the largest
 * run 41 agents / 29 minutes). Measurements referenced below:
 *   - `spawn_agent_id` emitted by a workflow agent: 0 of 72.
 *   - agents that emit ONLY a terminal stop and no in-flight event: 4 of 72.
 *   - agents that emit a trailing tool event AFTER their stop: 19 of 72 (26%),
 *     one of them a second BEFORE it.
 *   - inter-wave troughs where the live count is legitimately 0: 78 s, 63 s,
 *     20 s, 8 s.
 *   - longest single tool call in the corpus: 601 s (Claude's default Bash
 *     timeout is 600 s, so ~600 s is a designed-in cluster, not a tail).
 */

const TAB = 'wf-tab'
const S = 1000                       // ts is unix SECONDS; the code uses ts*1000

const ev = (e: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB,
    agent: 'claude',
    event: 'PostToolUse',
    ts: 0,
    ...e,
} as TraceEvent)

// Always advance the harness clock with the fixture. Its default `_now` is 0,
// so a spec that never calls setNow evaluates liveness at a NEGATIVE elapsed and
// `isWorkflowRunning` is vacuously true — which silently voided several of these
// assertions in an earlier revision.
const launch = (h: ReplayHarness, at: number) => {
    h.setNow(at * S)
    return h.process(ev({ event: 'PostToolUse', tool_name: 'Workflow', ts: at }))
}
const work = (h: ReplayHarness, agentId: string, at: number, event = 'PostToolUse') => {
    h.setNow(at * S)
    return h.process(ev({ event, tool_name: 'Bash', agent_id: agentId, ts: at }))
}
const stop = (h: ReplayHarness, agentId: string, at: number, event = 'SubagentStop') => {
    h.setNow(at * S)
    return h.process(ev({ event, agent_id: agentId, ts: at }))
}

describe('Workflow agents — passive tracking', () => {
    it('counts agents that emit no spawn signal, without touching the exact count', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006); work(h, 'a2', 1007); work(h, 'a3', 1008)
        expect(h.getWorkflowInFlight(TAB)).toBe(3)
        // The authoritative subagent count must stay 0 — no spawn was ever seen.
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('is inert on a tab that never launched a workflow', () => {
        const h = new ReplayHarness()
        expect(work(h, 'orphan', 1006)).toBe(false)   // no state change at all
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
    })

    it('arms on PostToolUse(Workflow) only, not PreToolUse', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'PreToolUse', tool_name: 'Workflow', ts: 1000 }))
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
        work(h, 'a1', 1006)
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    // THE regression this feature exists for: workflows run in waves, and the
    // live count is legitimately 0 between them. An earlier version tore the
    // chip down on the first trough and could never re-arm, restoring the
    // original bug for 46% and 91% of the two longest captured runs.
    it('survives an inter-wave trough and keeps counting the next wave', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'w1a', 1010); work(h, 'w1b', 1011)
        stop(h, 'w1a', 1100); stop(h, 'w1b', 1101)
        // Trough: nothing live. Poll here, as the real poll loop would.
        h.setNow(1102 * S)
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * S)   // still running
        // Wave 2 starts 78 s later — the worst trough observed.
        work(h, 'w2a', 1179)
        h.setNow(1179 * S)
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * S)
    })

    it('ends the run only after a long silence, measured from the last agent event', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1010)
        stop(h, 'a1', 1100)
        h.setNow(1100 * S + 179_000)          // just inside the quiet window
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * S)
        h.setNow(1100 * S + 181_000)          // past it
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
    })

    it('a same-second trailing tool event cannot resurrect a stopped agent', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006, 'PreToolUse')
        stop(h, 'a1', 1010)
        work(h, 'a1', 1010, 'PostToolUse')     // 26% of real agents do this
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    it('treats StopFailure as terminal too', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006)
        stop(h, 'a1', 1010, 'StopFailure')
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    it('does not double-count an ordinary subagent spawned during a workflow', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        // Authoritative spawn → belongs to liveAgentIds, not the workflow map.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'reg1', ts: 1005 }))
        work(h, 'reg1', 1006)
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    it('ignores non-tool events that happen to carry an agent_id', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        h.process(ev({ event: 'Stop', agent_id: 'a1', ts: 1006 }))
        h.process(ev({ event: 'Notification', agent_id: 'a2', ts: 1007 }))
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    it('keeps refreshing last-seen so a long-running agent is never expired', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006)
        work(h, 'a1', 1500)                    // still active
        h.setNow(1500 * S + 899_000)           // 899 s after the LAST event
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
    })

    // The staleness backstop is defensive only (0 of 72 workflow agents orphaned)
    // and must clear an id that genuinely stops reporting.
    it('expires an agent that goes silent past the stale window', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'orphan', 1006)
        h.setNow(1006 * S + 899_000)
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
        h.setNow(1006 * S + 901_000)
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    // 601 s single Bash calls exist in the corpus; a 600 s window would expire
    // an agent one second before its tool returned.
    it('does not expire an agent inside a 601-second tool call', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'slow', 1006, 'PreToolUse')
        h.setNow(1006 * S + 601_000)
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
    })

    it('a fresh session drops workflow state', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006)
        h.process(ev({ event: 'SessionStart', source: 'startup', ts: 2000 } as any))
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
    })

    // Auto-compaction is a MID-TURN continuation of the same session and fires
    // exactly when context is long — i.e. during a half-hour workflow.
    it('an auto-compact SessionStart does NOT disarm a running workflow', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006)
        h.process(ev({ event: 'SessionStart', source: 'compact', ts: 1100 } as any))
        h.setNow(1100 * S)
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * S)
        work(h, 'a2', 1110)
        expect(h.getWorkflowInFlight(TAB)).toBe(2)
    })

    it('clearSideChannel wipes workflow state', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006)
        expect(h.watcher.clearSideChannel(TAB)).toBe(true)
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
    })

    it('does not restamp while the run is still live (elapsed never jumps back)', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1006)
        launch(h, 1010)                        // nested / duplicate call mid-run
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * S)
    })

    // A second workflow in the same session previously inherited the first
    // run's clock forever — measured at +39h and +40h of bogus elapsed on a
    // real tab, because the guard tested "ever armed" rather than "running".
    it('a NEW workflow after the previous one ended restamps the clock', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1010)
        stop(h, 'a1', 1100)
        h.setNow(1100 * S + 200_000)           // run 1 is over
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
        launch(h, 5000)
        work(h, 'b1', 5010)
        expect(h.getWorkflowStartedAt(TAB)).toBe(5000 * S)
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
    })

    // The phantom-chip regression: stray stops (Claude fires them by the
    // hundred for ids we never tracked) must not resurrect a finished run.
    it('a stray SubagentStop cannot revive a finished workflow', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1010)
        stop(h, 'a1', 1100)
        h.setNow(1100 * S + 200_000)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
        stop(h, 'never-tracked', 1400)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    // Same for an orphan ordinary agent_id after the run.
    it('a stray tool event cannot revive a finished workflow', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1010)
        stop(h, 'a1', 1100)
        h.setNow(1100 * S + 200_000)
        work(h, 'orphan', 1400)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
    })

    it('an outstanding agent keeps the run alive past the quiet window', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'slow', 1010, 'PreToolUse')     // inside one long tool call
        h.setNow(1010 * S + 500_000)            // way past WORKFLOW_QUIET_MS
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * S)
    })

    it('holds the arm grace when a launch is followed by silence, then gives up', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        h.setNow(1000 * S + 119_000)
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * S)
        h.setNow(1000 * S + 121_000)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
    })

    it('a stop for an id this workflow never tracked does not extend the run', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1010)
        stop(h, 'a1', 1020)
        stop(h, 'never-seen', 1100)             // must not refresh the clock
        h.setNow(1020 * S + 181_000)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
    })

    it('the tombstone expires, so a much later event can start a new agent', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1010)
        stop(h, 'a1', 1020)
        work(h, 'a1', 1090)                     // 70s later — past the 60s tombstone
        expect(h.getWorkflowInFlight(TAB)).toBe(1)
    })

    it('dropping a closed tab clears its workflow state', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1010)
        h.watcher.retainOnly(new Set(['someone-else']))
        expect(h.getWorkflowInFlight(TAB)).toBe(0)
        expect(h.getWorkflowStartedAt(TAB)).toBeNull()
        expect(h.watcher.clearSideChannel(TAB)).toBe(false)
    })

    it('clearSideChannel is not reported for a tab with nothing to clear', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        work(h, 'a1', 1010)
        expect(h.watcher.clearSideChannel(TAB)).toBe(true)
        expect(h.watcher.clearSideChannel(TAB)).toBe(false)
    })

    it('a nested Workflow launch from inside an agent does not restamp', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        h.process(ev({ event: 'PostToolUse', tool_name: 'Workflow', agent_id: 'a1', ts: 4000 }))
        expect(h.getWorkflowStartedAt(TAB)).toBe(1000 * S)
    })

    it('reports change only for a genuinely new agent', () => {
        const h = new ReplayHarness()
        launch(h, 1000)
        expect(work(h, 'a1', 1006)).toBe(true)
        expect(work(h, 'a1', 1007)).toBe(false)
    })
})

/**
 * The status override itself — the user-visible half of the feature. Extracted
 * from TabMonitor's poll loop precisely so it can be asserted here; while it was
 * inline, deleting it entirely was invisible to the whole suite.
 */
describe('resolveRawStatus', () => {
    it('holds the row at working for a running workflow, even in a wave trough', () => {
        expect(resolveRawStatus(TabStatus.Idle, 0, true)).toBe(TabStatus.Working)
    })
    it('holds the row at working while subagents are in flight', () => {
        expect(resolveRawStatus(TabStatus.Idle, 2, false)).toBe(TabStatus.Working)
    })
    it('leaves a genuinely idle row idle', () => {
        expect(resolveRawStatus(TabStatus.Idle, 0, false)).toBe(TabStatus.Idle)
    })
    it('never downgrades or overrides a non-idle status', () => {
        for (const s of [TabStatus.Working, TabStatus.NeedsPermission, TabStatus.NoAi]) {
            expect(resolveRawStatus(s, 0, false)).toBe(s)
            expect(resolveRawStatus(s, 5, true)).toBe(s)
        }
    })
})
