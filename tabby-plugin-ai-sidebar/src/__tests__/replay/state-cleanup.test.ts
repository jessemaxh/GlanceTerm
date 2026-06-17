import { describe, it, expect } from 'vitest'
import { ReplayHarness, TraceEvent } from './harness'

/**
 * State-management review fixes (2026-06-11). Four behaviours, all at the
 * HookWatcher level:
 *
 *   H1 — the subagent / monitor / bg side-channel keys off Claude-only payload
 *        fields and must run ONLY for the Claude adapter. A non-Claude event
 *        that happens to carry a top-level agent_id must NOT pin a phantom
 *        live-subagent count (Codex has no decrement path for it).
 *   C1 — retainOnly() evicts ALL per-tab state for UUIDs no longer belonging to
 *        a live tab (the on-disk handler never unlinks the log, so the watcher's
 *        own ENOENT cleanup never fires).
 *   M1 — clearSideChannel() drops the session-scoped counters for one tab while
 *        keeping its snapshot/offset, for the no_ai (crashed-but-open) case.
 *   M2 — the sticky model slug survives a model-less resume/compact SessionStart
 *        (Claude only emits `model` on startup/compact; resume carries none),
 *        and resets only on a genuinely fresh `startup`.
 */

const ev = (over: Partial<TraceEvent>): TraceEvent => ({
    tab_id: 'tab', agent: 'claude', event: 'PreToolUse', ts: 1000, ...over,
})

describe('H1: Claude-specific side-channel is gated on the Claude adapter', () => {
    it('a Codex event carrying a top-level agent_id does NOT increment the counter', () => {
        const h = new ReplayHarness()
        // These exact shapes would each spawn under Claude (authoritative +
        // passive liveness). For Codex the whole block is gated off.
        h.process(ev({ tab_id: 'tabC', agent: 'codex', event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'x1' }))
        h.process(ev({ tab_id: 'tabC', agent: 'codex', event: 'PostToolUse', tool_name: 'Bash', agent_id: 'x1', ts: 1001 }))
        expect(h.getSubagentInFlight('tabC')).toBe(0)
    })

    it('a Codex Monitor PostToolUse does NOT populate the monitor counter', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'tabC', agent: 'codex', event: 'PostToolUse', tool_name: 'Monitor', monitor_task_id: 'm1' }))
        expect(h.getMonitorInFlight('tabC')).toBe(0)
    })

    it('Claude still populates the subagent counter (control)', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'tabA', agent: 'claude', event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'x1' }))
        expect(h.getSubagentInFlight('tabA')).toBe(1)
    })
})

describe('C1: retainOnly evicts state for tabs no longer live', () => {
    it('drops a closed tab entirely, leaves a live tab untouched', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'live', agent: 'claude', event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 's1' }))
        h.process(ev({ tab_id: 'dead', agent: 'claude', event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 's2' }))
        expect(h.getStatus('live')).not.toBeNull()
        expect(h.getStatus('dead')).not.toBeNull()
        expect(h.getSubagentInFlight('dead')).toBe(1)

        h.watcher.retainOnly(new Set(['live']))

        expect(h.getStatus('dead')).toBeNull()
        expect(h.getSubagentInFlight('dead')).toBe(0)
        expect(h.getStatus('live')).not.toBeNull()
        expect(h.getSubagentInFlight('live')).toBe(1)
    })

    it('an empty live set evicts everything (caller is responsible for the zero-tab guard)', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'a', agent: 'claude', event: 'PreToolUse' }))
        h.process(ev({ tab_id: 'b', agent: 'claude', event: 'PreToolUse' }))
        h.watcher.retainOnly(new Set())
        expect(h.getStatus('a')).toBeNull()
        expect(h.getStatus('b')).toBeNull()
    })
})

describe('M1: clearSideChannel drops counters but keeps the snapshot', () => {
    it('clears subagent/monitor counters, retains the snapshot, idempotent', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'tab', agent: 'claude', event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 's1' }))
        h.process(ev({ tab_id: 'tab', agent: 'claude', event: 'PostToolUse', tool_name: 'Monitor', monitor_task_id: 'm1', ts: 1001 }))
        expect(h.getSubagentInFlight('tab')).toBe(1)
        expect(h.getMonitorInFlight('tab')).toBe(1)
        expect(h.getStatus('tab')).not.toBeNull()

        expect(h.watcher.clearSideChannel('tab')).toBe(true)
        expect(h.getSubagentInFlight('tab')).toBe(0)
        expect(h.getMonitorInFlight('tab')).toBe(0)
        // Snapshot survives — process-tree detection drives the no_ai row;
        // a revival re-reads from the retained offset, not the whole log.
        expect(h.getStatus('tab')).not.toBeNull()

        // Nothing left → cheap no-op the second time.
        expect(h.watcher.clearSideChannel('tab')).toBe(false)
    })

    it('is a no-op for a tab with no side-channel state', () => {
        const h = new ReplayHarness()
        expect(h.watcher.clearSideChannel('never-seen')).toBe(false)
    })
})

describe('M2: sticky model survives resume/compact, resets only on a fresh startup', () => {
    it('a model-less RESUME SessionStart KEEPS the prior slug (regression: chip vanished after resume)', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'startup', model: 'claude-opus-4-8' }))
        expect(h.getStatus('tab')?.model).toBe('claude-opus-4-8')
        // Claude sends model='' on a source:resume SessionStart — it must NOT
        // wipe the slug (this is the bug that made the model chip disappear).
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'resume', ts: 2000 }))
        expect(h.getStatus('tab')?.model).toBe('claude-opus-4-8')
    })

    it('a model-less COMPACT SessionStart keeps the slug', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'startup', model: 'claude-opus-4-8' }))
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'compact', ts: 2000 }))
        expect(h.getStatus('tab')?.model).toBe('claude-opus-4-8')
    })

    it('a model-less fresh STARTUP drops the prior slug (stale-slug guard for a reused tab)', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'startup', model: 'claude-opus-4-8' }))
        expect(h.getStatus('tab')?.model).toBe('claude-opus-4-8')
        // Mid-session model-less events keep it sticky.
        h.process(ev({ tab_id: 'tab', event: 'PostToolUse', tool_name: 'Bash', ts: 1001 }))
        expect(h.getStatus('tab')?.model).toBe('claude-opus-4-8')
        // A brand-new startup with no model must NOT inherit the old slug.
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'startup', ts: 2000 }))
        expect(h.getStatus('tab')?.model ?? null).toBeNull()
    })

    it('a SessionStart WITH a model replaces the prior one', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'startup', model: 'claude-opus-4-8' }))
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-6', ts: 2000 }))
        expect(h.getStatus('tab')?.model).toBe('claude-sonnet-4-6')
    })

    it('mid-session model-less events still keep the slug sticky (non-SessionStart)', () => {
        const h = new ReplayHarness()
        h.process(ev({ tab_id: 'tab', event: 'SessionStart', source: 'startup', model: 'claude-opus-4-8' }))
        h.process(ev({ tab_id: 'tab', event: 'PreToolUse', tool_name: 'Bash', ts: 1001 }))
        h.process(ev({ tab_id: 'tab', event: 'PostToolUse', tool_name: 'Bash', ts: 1002 }))
        expect(h.getStatus('tab')?.model).toBe('claude-opus-4-8')
    })
})
