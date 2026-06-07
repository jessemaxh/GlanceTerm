import { describe, it, expect } from 'vitest'

import { ReplayHarness, loadFixture } from './harness'

/**
 * Regression test for the "backgrounded reviewer agent shows as ready"
 * bug from commit 60cbe448. Story:
 *
 *   1. Main agent invokes Agent(subagent_type: reviewer, run_in_background: true).
 *      Claude returns the launched agent's id ("a60a3311112ba1079") in
 *      PostToolUse(Agent).tool_response.agentId; the subagent runs in
 *      the background while main continues with other tool calls.
 *   2. Main's response ends → Stop fires.
 *   3. Roughly one second later Claude emits a SubagentStop with a
 *      DIFFERENT agent_id (in production: "a1ede988396d3b34f"), agent_type
 *      empty — an internal CC lifecycle marker, not our subagent.
 *      Pre-fix the timestamp-window reducer popped the queued spawn here
 *      because 35s of spawn-age was just inside the [30s, 4min] band,
 *      and the row dropped to "ready" while the reviewer kept running.
 *   4. ~120s later the subagent's real SubagentStop fires with the
 *      original agent_id; pre-fix this hit an empty queue and was a no-op.
 *
 * The id-based reducer (60cbe448) drops the phantom because its
 * agent_id was never added to the live set, and only pops on the real
 * SubagentStop. This test pins that behaviour to the fixture so a
 * future refactor that re-introduces the timestamp heuristic will
 * fail loudly here.
 *
 * Fixture: src/__tests__/replay/fixtures/reviewer-ack-bug.ndjson —
 * synthesised from the on-disk hook log captured during the original
 * investigation (debug-payloads.log on 2026-06-07). The agent_id
 * "a60a3311112ba1079" matches the real reviewer-agent id from that
 * session; "a1ede988396d3b34f" matches the phantom we captured.
 */
describe('reviewer-ack regression', () => {
    const TAB = 'c47db5dd-0000-0000-0000-000000000001'
    const REVIEWER = 'a60a3311112ba1079'
    const PHANTOM = 'a1ede988396d3b34f'

    it('drops phantom SubagentStop, pops on the real one', () => {
        const harness = new ReplayHarness()
        const events = loadFixture(import.meta.url, 'fixtures/reviewer-ack-bug.ndjson')

        // After PreToolUse(Agent): no spawn yet (that fires on PostToolUse
        // when tool_response.agentId is available).
        harness.process(events[0])
        expect(harness.getSubagentInFlight(TAB)).toBe(0)

        // After PostToolUse(Agent) carrying spawn_agent_id: reviewer is live.
        harness.process(events[1])
        expect(harness.getSubagentInFlight(TAB)).toBe(1)
        expect(harness.liveAgentIdsFor(TAB).has(REVIEWER)).toBe(true)

        // Subagent's own Bash/Read events carry agent_id=REVIEWER. They
        // re-add the same id, which is a no-op in the set reducer.
        harness.process(events[2])  // PreToolUse(Bash) inside subagent
        harness.process(events[3])  // PostToolUse(Bash) inside subagent
        harness.process(events[4])  // PreToolUse(Read) inside subagent
        harness.process(events[5])  // PostToolUse(Read) inside subagent
        expect(harness.getSubagentInFlight(TAB)).toBe(1)

        // Main agent's Stop ends its response. Subagent is still running.
        // Stop carries no agent_id so it doesn't touch the set.
        harness.process(events[6])
        expect(harness.getSubagentInFlight(TAB)).toBe(1)

        // THE BUG WINDOW: phantom SubagentStop fires 1s after main Stop,
        // with an unrelated agent_id and empty agent_type. The pre-fix
        // timestamp-window reducer popped REVIEWER here (the bug). The
        // id-based reducer drops the phantom because PHANTOM was never
        // in our live set.
        harness.process(events[7])
        expect(harness.getSubagentInFlight(TAB)).toBe(1)               // <-- the regression guard
        expect(harness.liveAgentIdsFor(TAB).has(REVIEWER)).toBe(true)  // <-- still tracked
        expect(harness.liveAgentIdsFor(TAB).has(PHANTOM)).toBe(false)  // <-- never added

        // Reviewer keeps making tool calls; counter unchanged.
        harness.process(events[8])  // PreToolUse(Bash) inside subagent, much later
        harness.process(events[9])  // PostToolUse(Bash) inside subagent
        expect(harness.getSubagentInFlight(TAB)).toBe(1)

        // Real SubagentStop with matching agent_id pops the set; tab is now idle.
        harness.process(events[10])
        expect(harness.getSubagentInFlight(TAB)).toBe(0)
        expect(harness.liveAgentIdsFor(TAB).size).toBe(0)
    })
})
