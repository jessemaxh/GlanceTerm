import { describe, it, expect } from 'vitest'

import { ReplayHarness, TraceEvent } from './harness'

/**
 * Mirror Claude's footer pair "N shell, M monitor" on our sidebar.
 *
 * The shell half is handled by TabMonitor's process-tree poll (with
 * hook-confirmed PreToolUse(Bash, run_in_background:true) anchors via
 * `pendingBgArrivals`). The monitor half lives entirely in
 * HookWatcher's `liveMonitorTaskIds` set — Monitor tasks are internal
 * Claude state with no process-tree footprint, so the hook IS the
 * signal.
 *
 * Lifecycle this suite pins:
 *
 *   PostToolUse(Monitor) w/ monitor_task_id  → add to live set
 *   PreToolUse(TaskStop) w/ stop_task_id     → remove from live set
 *   SessionStart / SessionEnd                → drop the whole set
 *
 * Plus the robustness shape borrowed from the SubagentStop reducer:
 *
 *   - TaskStop with a stop_task_id we never saw is dropped on the
 *     floor (TaskStop also targets bg shells; those id-domains overlap
 *     conceptually but never collide because shell ids live elsewhere).
 *   - Re-adding the same monitor_task_id is idempotent (a fixture replay
 *     that sees the same line twice shouldn't double-count).
 */
const TAB = '11111111-2222-3333-4444-555555555555'
const TAB2 = '66666666-7777-8888-9999-aaaaaaaaaaaa'

function monitorStarted (taskId: string, tabId = TAB, ts = 1_000): TraceEvent {
    return {
        tab_id: tabId, agent: 'claude', event: 'PostToolUse', tool_name: 'Monitor',
        ts, monitor_task_id: taskId,
    }
}
function monitorStopped (taskId: string, tabId = TAB, ts = 2_000): TraceEvent {
    return {
        tab_id: tabId, agent: 'claude', event: 'PreToolUse', tool_name: 'TaskStop',
        ts, stop_task_id: taskId,
    }
}
function sessionStart (tabId = TAB, ts = 500): TraceEvent {
    return { tab_id: tabId, agent: 'claude', event: 'SessionStart', ts }
}
function sessionEnd (tabId = TAB, ts = 9_000): TraceEvent {
    return { tab_id: tabId, agent: 'claude', event: 'SessionEnd', ts }
}

describe('Monitor lifecycle', () => {
    it('adds a started monitor to the live set', () => {
        const h = new ReplayHarness()
        h.process(monitorStarted('mon-1'))
        expect(h.getMonitorInFlight(TAB)).toBe(1)
    })

    it('tracks multiple concurrent monitors', () => {
        const h = new ReplayHarness()
        h.process(monitorStarted('mon-1'))
        h.process(monitorStarted('mon-2'))
        h.process(monitorStarted('mon-3'))
        expect(h.getMonitorInFlight(TAB)).toBe(3)
    })

    it('removes a specific monitor when its TaskStop fires', () => {
        const h = new ReplayHarness()
        h.process(monitorStarted('mon-1'))
        h.process(monitorStarted('mon-2'))
        h.process(monitorStopped('mon-1'))
        expect(h.getMonitorInFlight(TAB)).toBe(1)
    })

    it('drains to zero when all TaskStops arrive', () => {
        const h = new ReplayHarness()
        h.process(monitorStarted('a'))
        h.process(monitorStarted('b'))
        h.process(monitorStopped('a'))
        h.process(monitorStopped('b'))
        expect(h.getMonitorInFlight(TAB)).toBe(0)
    })

    it('silently drops TaskStop for an unknown id', () => {
        // The TaskStop tool stops backgrounded Bash shells too; their ids
        // live in a different domain. We must NOT decrement on a stop for
        // an id we never saw — otherwise the count drifts below zero (or,
        // with Set semantics, an unrelated stop deletes nothing but used
        // to log a "removed nonexistent" warning).
        const h = new ReplayHarness()
        h.process(monitorStarted('mon-1'))
        h.process(monitorStopped('this-is-a-bash-shell-id'))
        expect(h.getMonitorInFlight(TAB)).toBe(1)
    })

    it('is idempotent for repeat PostToolUse(Monitor) with the same id', () => {
        // A cold-load that re-reads the same fixture line, or a 30s
        // rescan that re-processes an already-seen event, must not bump
        // the count. The append-only tailOffset normally prevents this
        // from reaching processEvent at all — pinning the set-add
        // semantics so a future code path that bypasses tailOffset
        // (e.g. an explicit "re-evaluate this event") stays safe.
        const h = new ReplayHarness()
        h.process(monitorStarted('mon-1'))
        h.process(monitorStarted('mon-1'))
        h.process(monitorStarted('mon-1'))
        expect(h.getMonitorInFlight(TAB)).toBe(1)
    })

    it('resets the whole set on SessionStart', () => {
        // Crash recovery: Claude died mid-monitor, no TaskStop fired,
        // the next SessionStart for the same tab must wipe the lingering
        // ids so the next session's badge starts at 0.
        const h = new ReplayHarness()
        h.process(monitorStarted('mon-1'))
        h.process(monitorStarted('mon-2'))
        h.process(sessionStart(TAB, 5_000))
        expect(h.getMonitorInFlight(TAB)).toBe(0)
    })

    it('resets the whole set on SessionEnd', () => {
        const h = new ReplayHarness()
        h.process(monitorStarted('mon-1'))
        h.process(sessionEnd())
        expect(h.getMonitorInFlight(TAB)).toBe(0)
    })

    it('keeps per-tab tracking independent', () => {
        // Two tabs running Claude. A monitor stopping in tab A must not
        // touch tab B's count, even when they happen to share an id —
        // the lookup is keyed by tab_id BEFORE the set membership check.
        const h = new ReplayHarness()
        h.process(monitorStarted('mon-1', TAB))
        h.process(monitorStarted('mon-1', TAB2))
        expect(h.getMonitorInFlight(TAB)).toBe(1)
        expect(h.getMonitorInFlight(TAB2)).toBe(1)

        h.process(monitorStopped('mon-1', TAB))
        expect(h.getMonitorInFlight(TAB)).toBe(0)
        expect(h.getMonitorInFlight(TAB2)).toBe(1)
    })

    it('ignores PostToolUse(Monitor) with no monitor_task_id', () => {
        // An older log line written before the handler-side extraction
        // shipped would have monitor_task_id absent / empty. We must
        // skip rather than add an empty-string entry — empty-string
        // would later "match" a real-id TaskStop's `if (set?.delete(id))`
        // check and decrement nothing, but it would also block the
        // matching real ADD via the idempotence guard.
        const h = new ReplayHarness()
        h.process({
            tab_id: TAB, agent: 'claude', event: 'PostToolUse', tool_name: 'Monitor',
            ts: 1000,
            // monitor_task_id omitted
        })
        expect(h.getMonitorInFlight(TAB)).toBe(0)
    })

    it('does not bump on non-Monitor PostToolUse, even with a monitor_task_id', () => {
        // Defensive — the handler only sets monitor_task_id when it
        // saw PostToolUse(Monitor). But a malformed log line that
        // claimed PostToolUse(Bash) with the id field set must NOT
        // count: the `tool_name === 'Monitor'` gate in processEvent
        // is the safety boundary.
        const h = new ReplayHarness()
        h.process({
            tab_id: TAB, agent: 'claude', event: 'PostToolUse', tool_name: 'Bash',
            ts: 1000, monitor_task_id: 'mon-1',
        })
        expect(h.getMonitorInFlight(TAB)).toBe(0)
    })

    it('reports zero for tabs we have never seen', () => {
        const h = new ReplayHarness()
        expect(h.getMonitorInFlight('unknown-tab')).toBe(0)
    })

    it('handles the reported scenario: 1 shell + 1 monitor live concurrently', () => {
        // The exact case the user reported: Claude's footer shows
        // "1 shell, 1 monitor". The shell count is the TabMonitor
        // process-tree path; the monitor count is the one this suite
        // covers. End-to-end:
        //
        //   PreToolUse(Bash, bg=1)         → queues a pending bg arrival
        //                                     (TabMonitor consumes it on
        //                                     the next process-tree poll
        //                                     — verified elsewhere).
        //   PostToolUse(Monitor) w/ id     → live monitor set = {id}.
        //
        // We assert on the live-monitor count directly; the shell
        // count's process-tree path lives outside HookWatcher.
        const h = new ReplayHarness()
        h.process({
            tab_id: TAB, agent: 'claude', event: 'PreToolUse', tool_name: 'Bash',
            ts: 1000, bg: 1,
        })
        h.process(monitorStarted('bxk0l0j7y'))
        expect(h.getMonitorInFlight(TAB)).toBe(1)
    })
})
