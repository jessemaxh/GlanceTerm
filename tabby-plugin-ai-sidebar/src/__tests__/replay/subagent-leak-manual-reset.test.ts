import { describe, it, expect } from 'vitest'
import { ReplayHarness, TraceEvent } from './harness'
import { TabStatus } from '../../tab-monitor'

/**
 * Regression + escape-hatch coverage for a LEAKED live-subagent id.
 *
 * Real-world trace (gmailClient, 2026-07-06): a foreground subagent spawned
 * (PostToolUse(Agent) → spawn_agent_id), ran a few tools, then its
 * `SubagentStop` NEVER arrived — Claude did not fire the hook for a subagent
 * that terminated abnormally. The id is removed ONLY by a matching
 * SubagentStop and the set is reset ONLY on SessionStart/SessionEnd; the main
 * agent's `Stop` (turn end) does NOT touch it. So the id leaked across every
 * later turn, pinning a phantom "· 1 agent" badge that forced the otherwise
 * idle row to "working" (the idle→working override keys off this count). The
 * transcript confirmed the subagent DID finish (107/107 Tasks balanced), so the
 * count was genuinely wrong — an upstream-dropped event GlanceTerm can't
 * prevent at the source (the hook is simply never emitted).
 *
 * `TabMonitor.resetAgentState()` (sidebar row right-click → "Reset agent
 * status") wraps `HookWatcher.clearSideChannel()`: the user's manual
 * force-correct. This pins BOTH halves — the leak survives N Stops (the bug),
 * and the manual clear drops it to 0 while keeping the snapshot (the fix).
 */

const LEAK = 'a8aa9a9e911216418'
const TAB = 'gmailclient-leak-0001'

const ev = (over: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB, agent: 'claude', event: 'PreToolUse', ts: 1000, ...over,
})

describe('leaked subagent id — survives Stops, cleared by manual reset', () => {
    it('a missing SubagentStop leaks across turns; the main-agent Stop never clears it', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'SessionStart', source: 'startup', model: 'claude-opus-4-8', ts: 1000 }))
        h.process(ev({ event: 'UserPromptSubmit', ts: 1001 }))

        // A sibling subagent that DOES balance (spawn → stop): proves the
        // counter is healthy in general — only the dropped-stop id leaks.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'sibling1', ts: 1002 }))
        h.process(ev({ event: 'SubagentStop', agent_id: 'sibling1', ts: 1003 }))
        expect(h.getSubagentInFlight(TAB)).toBe(0)

        // The leaked subagent: spawn + a couple of tools, then NO SubagentStop.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: LEAK, ts: 1010 }))
        h.process(ev({ event: 'PreToolUse', tool_name: 'Bash', agent_id: LEAK, ts: 1011 }))
        h.process(ev({ event: 'PostToolUse', tool_name: 'Bash', agent_id: LEAK, ts: 1012 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)

        // The main agent ends the turn — and several more turns pass. In the
        // real trace the main agent Stopped 12 times; none cleared the leak,
        // because Stop is not a set operation (only SessionStart/End reset).
        for (let i = 0; i < 3; i++) {
            h.process(ev({ event: 'Stop', ts: 2000 + i * 100 }))
            h.process(ev({ event: 'UserPromptSubmit', ts: 2050 + i * 100 }))
        }

        // Phantom persists — exactly the "· 1 agent" badge the user saw, on the
        // leaked id and nothing else.
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        expect([...h.watcher.liveAgentIdsFor(TAB)]).toEqual([LEAK])
    })

    it('the manual reset (clearSideChannel) drops the phantom to 0 and keeps the snapshot', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'SessionStart', source: 'startup', model: 'claude-opus-4-8', ts: 1000 }))
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: LEAK, ts: 1010 }))
        h.process(ev({ event: 'Stop', ts: 2000 }))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        expect(h.getStatus(TAB)).not.toBeNull()

        // TabMonitor.resetAgentState() calls exactly this primitive.
        expect(h.watcher.clearSideChannel(TAB)).toBe(true)

        expect(h.getSubagentInFlight(TAB)).toBe(0)           // phantom gone
        expect(h.getStatus(TAB)).not.toBeNull()              // snapshot/status kept
        expect(h.watcher.clearSideChannel(TAB)).toBe(false)  // idempotent no-op
    })

    it('reset guard discriminates by RAW status: idle for a phantom, working for a real turn', () => {
        // TabMonitor.resetAgentState() refuses to clear while the RAW hook
        // status is Working — a genuinely busy tab's live set is real and
        // clearing it would undercount. It keys off exactly this snapshot
        // status, so this pins the discriminator the guard relies on.

        // Phantom: main agent idle (Stop) + a leaked count. The RAW status stays
        // IDLE — the idle→working override lives in TabMonitor, not the
        // snapshot — so the guard ALLOWS the reset.
        const phantom = new ReplayHarness()
        phantom.process(ev({ event: 'SessionStart', source: 'startup', ts: 1000 }))
        phantom.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: LEAK, ts: 1001 }))
        phantom.process(ev({ event: 'Stop', ts: 1002 }))
        expect(phantom.getSubagentInFlight(TAB)).toBe(1)
        expect(phantom.getStatus(TAB)?.status).toBe(TabStatus.Idle)     // guard → allow

        // Real turn: main agent mid-turn (UserPromptSubmit) + a REAL live
        // subagent. RAW status is Working, so the guard BLOCKS the reset —
        // clearing here would drop a genuinely-running subagent from the count.
        const busy = new ReplayHarness()
        busy.process(ev({ event: 'SessionStart', source: 'startup', ts: 1000 }))
        busy.process(ev({ event: 'UserPromptSubmit', ts: 1001 }))
        busy.process(ev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'realsub', ts: 1002 }))
        expect(busy.getSubagentInFlight(TAB)).toBe(1)
        expect(busy.getStatus(TAB)?.status).toBe(TabStatus.Working)     // guard → block
    })
})
