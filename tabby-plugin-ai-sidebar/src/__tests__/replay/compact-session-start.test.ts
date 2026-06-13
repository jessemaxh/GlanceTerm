import { describe, expect, it } from 'vitest'

import { ReplayHarness } from './harness'
import { TabStatus } from '../../tab-monitor'

const TAB = '17cf6318-0000-0000-0000-0000COMPACT'

/**
 * Watcher coverage for the compact-SessionStart status hold
 * (HookWatcher.processEvent). Pins the bug where an auto-compaction flipped the
 * sidebar row to "ready" mid-turn: Claude fires `SessionStart` with
 * `source:"compact"` after compaction, the adapter maps SessionStart → idle,
 * and because compaction + follow-up thinking fires no tool events for ~60-100 s
 * the row sat on idle while the agent was plainly still working.
 *
 * The fixture mirrors the real trace that surfaced it: a working turn →
 * SubagentStop → compact SessionStart → (long gap) → tools resume.
 */
describe('HookWatcher — compact SessionStart does not flip the row to idle', () => {
    it('holds `working` across a post-compaction SessionStart (source:compact)', () => {
        const h = new ReplayHarness()
        h.process({ tab_id: TAB, agent: 'claude', event: 'UserPromptSubmit', session_id: 's', cwd: '/repo', ts: 1_781_324_900 })
        h.process({ tab_id: TAB, agent: 'claude', event: 'PreToolUse', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_324_980 })
        h.process({ tab_id: TAB, agent: 'claude', event: 'PostToolUse', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_324_985 })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)

        // Auto-compact fires mid-turn. Pre-fix this dropped the row to idle and
        // it stayed there until the next tool event (~66 s later in the wild).
        h.process({ tab_id: TAB, agent: 'claude', event: 'SessionStart', session_id: 's', cwd: '/repo', ts: 1_781_324_992, source: 'compact', model: 'claude-opus-4-8[1m]' })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)

        // …and it stays working when tools resume after the compaction gap.
        h.process({ tab_id: TAB, agent: 'claude', event: 'PreToolUse', tool_name: 'Agent', session_id: 's', cwd: '/repo', ts: 1_781_325_058 })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
    })

    it('a startup SessionStart still surfaces as idle (genuine fresh session)', () => {
        const h = new ReplayHarness()
        h.process({ tab_id: TAB, agent: 'claude', event: 'SessionStart', session_id: 's', cwd: '/repo', ts: 1_781_324_000, source: 'startup', model: 'claude-opus-4-8[1m]' })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
    })

    it('a clear SessionStart still surfaces as idle (/clear → waiting for input)', () => {
        const h = new ReplayHarness()
        h.process({ tab_id: TAB, agent: 'claude', event: 'UserPromptSubmit', session_id: 's', cwd: '/repo', ts: 1_781_324_100 })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
        h.process({ tab_id: TAB, agent: 'claude', event: 'SessionStart', session_id: 's', cwd: '/repo', ts: 1_781_324_200, source: 'clear' })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
    })

    it('a SessionStart with no source still maps to idle (back-compat with old log lines)', () => {
        const h = new ReplayHarness()
        h.process({ tab_id: TAB, agent: 'claude', event: 'UserPromptSubmit', session_id: 's', cwd: '/repo', ts: 1_781_324_300 })
        h.process({ tab_id: TAB, agent: 'claude', event: 'SessionStart', session_id: 's', cwd: '/repo', ts: 1_781_324_400 })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
    })
})
