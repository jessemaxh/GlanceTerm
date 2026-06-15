import { describe, it, expect } from 'vitest'

import { ReplayHarness, TraceEvent, loadFixture } from './harness'
import { TabStatus } from '../../tab-monitor'

/**
 * Replay of REAL, captured hook traces (vs the hand-modeled events the other
 * replay specs use). Each `real-*.ndjson` fixture is a slice of an actual
 * `~/.glanceterm/hooks/<tab>.log` written by the live handler, scrubbed for
 * publication: tab_id → fixed fake UUID, session_id / transcript_path blanked,
 * cwd → /work/projectN, agent_id / spawn_agent_id / monitor ids → short fake
 * tokens (PAIRING preserved — the same real id always became the same token),
 * and ts rebased to small integers with the ORIGINAL deltas intact.
 *
 * The point: the synthetic specs prove the reducers handle the sequences *I*
 * imagined; these prove they handle the sequences agents ACTUALLY emit — real
 * orderings (incl. the ~3 s SubagentStop→PostToolUse(Agent) reorder), real
 * phantom stops, real interleavings, real monitor timeouts.
 *
 * Helper: replay a fixture event-by-event, calling `at(index)` after each so a
 * test can checkpoint the state the way a human would watch the sidebar.
 */
function replayWithCheckpoints (
    events: TraceEvent[],
    at: (i: number, h: ReplayHarness) => void,
): ReplayHarness {
    const h = new ReplayHarness()
    events.forEach((e, i) => {
        h.process(e)
        at(i, h)
    })
    return h
}

describe('real trace replay — (a) normal turn', () => {
    const TAB = '00000000-0000-4000-8000-000000000001'
    const ev = loadFixture('real-normal-turn.ndjson')

    it('walks working → idle and ignores the trailing phantom SubagentStop', () => {
        // Fixture shape: SessionStart, UserPromptSubmit, Pre/Post(Bash)×3, Stop,
        // a phantom SubagentStop (agent_id never spawned), SessionEnd.
        const idx = { sessionStart: 0, prompt: 1, stop: 10, phantomStop: 11, sessionEnd: 12 }
        expect(ev[idx.sessionStart].event).toBe('SessionStart')
        expect(ev[idx.stop].event).toBe('Stop')
        expect(ev[idx.phantomStop].event).toBe('SubagentStop')
        expect(ev[idx.sessionEnd].event).toBe('SessionEnd')

        const h = replayWithCheckpoints(ev, (i, hh) => {
            if (i === idx.sessionStart) {
                expect(hh.getStatus(TAB)?.status).toBe(TabStatus.Idle)
                // Claude stamps model only on SessionStart; it must stick.
                expect(hh.getStatus(TAB)?.model).toBe('claude-opus-4-8[1m]')
            }
            if (i === idx.prompt) expect(hh.getStatus(TAB)?.status).toBe(TabStatus.Working)
            if (i === idx.stop) {
                expect(hh.getStatus(TAB)?.status).toBe(TabStatus.Idle)
                expect(hh.getSubagentInFlight(TAB)).toBe(0)
            }
            if (i === idx.phantomStop) {
                // The phantom must NOT push the counter negative or otherwise
                // perturb it — a stop for an id we never spawned is a no-op.
                expect(hh.getSubagentInFlight(TAB)).toBe(0)
                expect(hh.getStatus(TAB)?.status).toBe(TabStatus.Idle)
            }
        })

        // End of a real session: NoAi, nothing left in flight.
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.NoAi)
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        expect(h.getMonitorInFlight(TAB)).toBe(0)
        // Sticky model: the SessionStart slug survives every later model-less
        // event including SessionEnd (only a fresh SessionStart resets it).
        expect(h.getStatus(TAB)?.model).toBe('claude-opus-4-8[1m]')
    })
})

describe('real trace replay — (b) in-order subagent spawn/stop', () => {
    const TAB = '00000000-0000-4000-8000-000000000002'
    const ev = loadFixture('real-subagent-turn.ndjson')

    it('peaks at 1 and keeps the row in flight across the MAIN-agent Stop', () => {
        // Shape: …, PostToolUse(Agent) spawn, main Stop (while subagent live),
        // subagent's own tool calls, SubagentStop, UserPromptSubmit, Stop.
        const spawn = ev.findIndex(e => e.event === 'PostToolUse' && e.tool_name === 'Agent')
        const mainStop = ev.findIndex((e, i) => i > spawn && e.event === 'Stop')
        const subStop = ev.findIndex(e => e.event === 'SubagentStop')
        expect(spawn).toBeGreaterThanOrEqual(0)
        expect(mainStop).toBeGreaterThan(spawn)
        expect(subStop).toBeGreaterThan(mainStop)

        replayWithCheckpoints(ev, (i, hh) => {
            if (i === spawn) expect(hh.getSubagentInFlight(TAB)).toBe(1)
            if (i === mainStop) {
                // THE reason this counter exists: the main agent fired Stop
                // (adapter maps to Idle) but a subagent is still chewing tokens,
                // so the in-flight count must remain 1 — TabMonitor uses that to
                // override the row back to working.
                expect(hh.getStatus(TAB)?.status).toBe(TabStatus.Idle)
                expect(hh.getSubagentInFlight(TAB)).toBe(1)
            }
            // Every event between the spawn and the SubagentStop must hold at 1
            // (the subagent's own tool calls carry agent_id but must NOT add).
            if (i > spawn && i < subStop) expect(hh.getSubagentInFlight(TAB)).toBe(1)
            if (i === subStop) expect(hh.getSubagentInFlight(TAB)).toBe(0)
        })
    })

    it('drains to exactly 0 by the end of the real turn', () => {
        const h = new ReplayHarness()
        h.processAll(ev)
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
    })
})

describe('real trace replay — (b) the ~3s SubagentStop→PostToolUse(Agent) reorder', () => {
    const TAB = '00000000-0000-4000-8000-000000000003'
    const ev = loadFixture('real-subagent-reorder.ndjson')

    it('drops the late authoritative spawn so the count stays 0 (tombstone)', () => {
        // Real ordering: the subagent's SubagentStop lands ~3 s BEFORE the
        // PostToolUse(Agent) that announces its spawn. Without the tombstone the
        // late spawn re-adds the just-stopped id and the row pins to
        // "working · 1 agent" forever. With it, the spawn is dropped.
        const stop = ev.findIndex(e => e.event === 'SubagentStop')
        const lateSpawn = ev.findIndex(e => e.event === 'PostToolUse' && e.tool_name === 'Agent')
        expect(stop).toBeGreaterThanOrEqual(0)
        expect(lateSpawn).toBeGreaterThan(stop) // the reorder: stop precedes spawn
        // The stop and the late spawn carry the SAME id (the pairing the fixture
        // preserves) and the gap is the real ~3 s, well inside the 60 s TTL.
        expect(ev[lateSpawn].spawn_agent_id).toBe(ev[stop].agent_id)
        expect(ev[lateSpawn].ts - ev[stop].ts).toBeLessThanOrEqual(60)

        const h = replayWithCheckpoints(ev, (i, hh) => {
            // The subagent's own tool calls (agent_id set) never bump the count.
            if (i < stop) expect(hh.getSubagentInFlight(TAB)).toBe(0)
            if (i === stop) expect(hh.getSubagentInFlight(TAB)).toBe(0)
            if (i === lateSpawn) expect(hh.getSubagentInFlight(TAB)).toBe(0) // dropped, not re-added
        })
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })
})

describe('real trace replay — (c) monitor lifecycle with real timeouts', () => {
    const TAB = '00000000-0000-4000-8000-000000000004'
    const ev = loadFixture('real-monitor.ndjson')

    it('counts up to 3, removes on TaskStop, ignores a phantom TaskStop, TTL-evicts the rest', () => {
        // 3 monitors start (one 90 s, two 240 s). Two are stopped by TaskStop;
        // one TaskStop is for an id never started (phantom). The 90 s monitor is
        // never explicitly stopped → must self-evict at start+timeout+grace.
        const starts = ev.filter(e => e.event === 'PostToolUse' && e.tool_name === 'Monitor' && e.monitor_task_id)
        const stops = ev.filter(e => e.event === 'PreToolUse' && e.tool_name === 'TaskStop' && e.stop_task_id)
        expect(starts.length).toBe(3)
        expect(stops.length).toBe(3) // two real + one phantom

        const h = new ReplayHarness()
        let started = 0
        let realStops = 0
        const startedIds = new Set<string>()
        ev.forEach(e => {
            h.process(e)
            if (e.event === 'PostToolUse' && e.tool_name === 'Monitor' && e.monitor_task_id) {
                started++
                startedIds.add(e.monitor_task_id)
                expect(h.getMonitorInFlight(TAB)).toBe(started)
            }
            if (e.event === 'PreToolUse' && e.tool_name === 'TaskStop' && e.stop_task_id) {
                const wasLive = startedIds.has(e.stop_task_id)
                if (wasLive) {
                    realStops++
                    expect(h.getMonitorInFlight(TAB)).toBe(started - realStops)
                } else {
                    // phantom TaskStop for a never-started id → no decrement.
                    expect(h.getMonitorInFlight(TAB)).toBe(started - realStops)
                }
            }
        })

        // Two of three stopped; the 90 s monitor is still live.
        expect(h.getMonitorInFlight(TAB)).toBe(1)

        // Find the surviving monitor's start to compute its real TTL deadline.
        const survivor = starts.find(s => !stops.some(st => st.stop_task_id === s.monitor_task_id))!
        const deadline = survivor.ts * 1000 + (survivor.monitor_timeout_ms ?? 0) + 5_000 // grace
        h.setNow(deadline - 1)
        expect(h.getMonitorInFlight(TAB)).toBe(1)
        h.setNow(deadline + 1)
        expect(h.getMonitorInFlight(TAB)).toBe(0) // self-evicted, no TaskStop ever fired
    })
})

describe('real trace replay — (d) subagent that ends via StopFailure', () => {
    const TAB = '00000000-0000-4000-8000-000000000005'
    const ev = loadFixture('real-stopfailure.ndjson')

    it('holds at 1 through the main Stop + a phantom SubagentStop, drains on StopFailure', () => {
        // Real abnormal end: the subagent never fires SubagentStop; its turn is
        // closed by StopFailure (interrupt / stream error). In between, the MAIN
        // agent fires Stop, and an UNRELATED subagent's SubagentStop lands —
        // neither may drain our subagent.
        const spawn = ev.findIndex(e => e.event === 'PostToolUse' && e.tool_name === 'Agent')
        const mainStop = ev.findIndex(e => e.event === 'Stop')
        const phantom = ev.findIndex(e => e.event === 'SubagentStop')
        const stopFail = ev.findIndex(e => e.event === 'StopFailure')
        expect(spawn).toBeGreaterThanOrEqual(0)
        expect(stopFail).toBeGreaterThan(phantom)
        // The phantom SubagentStop is for a DIFFERENT id than our subagent.
        expect(ev[phantom].agent_id).not.toBe(ev[spawn].spawn_agent_id)
        // StopFailure carries OUR subagent's id.
        expect(ev[stopFail].agent_id).toBe(ev[spawn].spawn_agent_id)

        const h = replayWithCheckpoints(ev, (i, hh) => {
            if (i === spawn) expect(hh.getSubagentInFlight(TAB)).toBe(1)
            if (i === mainStop) expect(hh.getSubagentInFlight(TAB)).toBe(1) // main Stop ≠ subagent end
            if (i === phantom) expect(hh.getSubagentInFlight(TAB)).toBe(1)  // different id, ignored
            if (i === stopFail) expect(hh.getSubagentInFlight(TAB)).toBe(0) // StopFailure drains it
        })
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle) // StopFailure → idle
    })
})

describe('real trace replay — (e) backgrounded Bash (bg:1)', () => {
    const TAB = '00000000-0000-4000-8000-000000000006'
    const ev = loadFixture('real-bg-bash.ndjson')

    it('treats a bg shell as working, never as a subagent or monitor', () => {
        const bg = ev.findIndex(e => e.bg === 1)
        const stop = ev.findIndex(e => e.event === 'Stop')
        expect(bg).toBeGreaterThanOrEqual(0)
        expect(ev[bg]).toMatchObject({ event: 'PreToolUse', tool_name: 'Bash', bg: 1 })

        replayWithCheckpoints(ev, (i, hh) => {
            // A bg-Bash must NOT leak into the subagent or monitor counters —
            // that's the regression that pinned rows to "working · N agents".
            expect(hh.getSubagentInFlight(TAB)).toBe(0)
            expect(hh.getMonitorInFlight(TAB)).toBe(0)
            if (i === bg) expect(hh.getStatus(TAB)?.status).toBe(TabStatus.Working)
            if (i === stop) expect(hh.getStatus(TAB)?.status).toBe(TabStatus.Idle)
        })
    })
})
