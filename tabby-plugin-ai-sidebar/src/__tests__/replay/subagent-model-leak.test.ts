import { describe, it, expect } from 'vitest'
import { ReplayHarness, TraceEvent } from './harness'
import { TabStatus } from '../../tab-monitor'

/**
 * Regression: the model chip stuck on a SUBAGENT's model. Claude stamps a
 * `model` field not only on SessionStart (the main agent's model) but ALSO on
 * the `Agent`/`Task` tool's Pre/PostToolUse — and there it carries the
 * SUBAGENT's slug (e.g. `sonnet`) with an EMPTY `agent_id`, so the agent_id
 * guard doesn't catch it. The watcher used to feed that straight into
 * stickyModel, pinning the tab's model to the subagent's for the rest of the
 * session (stickyModel only resets on a fresh `startup`, which a long
 * compact/resume session never sees). Observed live: a June `sonnet` subagent
 * left an Opus-4.8 tab reading "sonnet" for two weeks.
 *
 * Fixes under test:
 *   A. Claude's `model` is honored ONLY on SessionStart (tool-event models are
 *      subagents' and ignored). Codex — which stamps its model on every event
 *      by contract — is unrestricted.
 *   B. A `compact` SessionStart HOLDS the displayed status but still refreshes
 *      the model (so a mid-session /model switch and self-healing work), instead
 *      of early-returning and dropping the update.
 */

const TAB = 'aaaaaaaa-0000-4000-8000-modelleak0001'
const ev = (over: Partial<TraceEvent>): TraceEvent => ({
    tab_id: TAB, agent: 'claude', event: 'PreToolUse', ts: 1000, ...over,
})

describe('model chip — subagent-model leak', () => {
    it('A: an Agent-tool event carrying a subagent model does NOT overwrite the tab model', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'SessionStart', source: 'startup', model: 'claude-opus-4-8', ts: 1000 }))
        expect(h.getStatus(TAB)?.model).toBe('claude-opus-4-8')

        // Main agent spawns a sonnet subagent — Claude stamps model:"sonnet" on
        // the Agent tool's Pre/PostToolUse, agent_id empty. Must be ignored.
        h.process(ev({ event: 'PreToolUse', tool_name: 'Agent', model: 'sonnet', agent_id: '', ts: 1001 }))
        expect(h.getStatus(TAB)?.model).toBe('claude-opus-4-8')
        h.process(ev({ event: 'PostToolUse', tool_name: 'Agent', model: 'sonnet', agent_id: '', ts: 1002 }))
        expect(h.getStatus(TAB)?.model).toBe('claude-opus-4-8')

        // A plain tool event with no model must also leave it intact.
        h.process(ev({ event: 'PostToolUse', tool_name: 'Bash', ts: 1003 }))
        expect(h.getStatus(TAB)?.model).toBe('claude-opus-4-8')
    })

    it('B: a compact SessionStart refreshes the model AND holds the status', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-6', ts: 2000 }))
        h.process(ev({ event: 'UserPromptSubmit', ts: 2001 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)

        // Mid-session /model → opus; the new slug rides in on the next compact.
        h.process(ev({ event: 'SessionStart', source: 'compact', model: 'claude-opus-4-8', ts: 2002 }))
        expect(h.getStatus(TAB)?.model).toBe('claude-opus-4-8')   // refreshed (fix B)
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)  // status still held
    })

    it('real-world repro: resume → sonnet subagent → compact opus never sticks on sonnet', () => {
        const h = new ReplayHarness()
        h.process(ev({ event: 'SessionStart', source: 'resume', model: '', ts: 3000 }))   // resume carries empty model
        h.process(ev({ event: 'PreToolUse', tool_name: 'Agent', model: 'sonnet', agent_id: '', ts: 3001 }))
        expect(h.getStatus(TAB)?.model).not.toBe('sonnet')        // leak fixed
        // A compaction later re-asserts the real model.
        h.process(ev({ event: 'SessionStart', source: 'compact', model: 'claude-opus-4-8', ts: 3100 }))
        expect(h.getStatus(TAB)?.model).toBe('claude-opus-4-8')
    })

    it('Codex is unaffected — it stamps its model on every event by contract', () => {
        const h = new ReplayHarness()
        h.process({ tab_id: TAB, agent: 'codex', event: 'PreToolUse', tool_name: 'Bash', model: 'gpt-5.5', ts: 4000 })
        expect(h.getStatus(TAB)?.model).toBe('gpt-5.5')
        // Tracks a switch mid-session (Codex model is authoritative per event).
        h.process({ tab_id: TAB, agent: 'codex', event: 'PostToolUse', tool_name: 'Bash', model: 'gpt-5.5-codex', ts: 4001 })
        expect(h.getStatus(TAB)?.model).toBe('gpt-5.5-codex')
    })
})
