import { afterEach, describe, expect, it, vi } from 'vitest'

import { debugLog } from '../debug-log.service'
import { DriftDetector, DriftEvent, KNOWN_CLAUDE_TOOLS } from '../drift-detector'
import { ReplayHarness, TraceEvent } from './replay/harness'

const TAB = 'tab-drift-0000'
const S = 1000

const ev = (e: Partial<DriftEvent>): DriftEvent => ({
    tabId: TAB, event: 'PreToolUse', toolName: 'Bash', agentId: '', agentType: '',
    smResult: '', source: '', at: 0, ...e,
})
const live = { tracked: false, workflowRunning: false }
const kinds = (d: DriftDetector, e: DriftEvent, ctx = live) => d.observe(e, ctx).map(f => f.kind)
const text = (d: DriftDetector, e: DriftEvent, ctx = live) => d.observe(e, ctx).map(f => f.message).join(' | ')

describe('DriftDetector — untracked subagent activity', () => {
    it('reports a re-woken agent that was not re-counted (the 2026-10 SendMessage change)', () => {
        const d = new DriftDetector()
        d.observe(ev({ event: 'SubagentStop', agentId: 'ad445c223fd587a4a', toolName: '', at: 1000 * S }), live)
        d.observe(ev({ event: 'PostToolUse', toolName: 'SendMessage', at: 1600 * S, smResult: 'resumed' }), live)
        expect(text(d, ev({ agentId: 'ad445c223fd587a4a', agentType: 'aiartgen-flutter', at: 1620 * S }))).toContain('resumed-uncounted')
    })

    it('reports activity after a stop with no resume as active-after-stop', () => {
        const d = new DriftDetector()
        d.observe(ev({ event: 'SubagentStop', agentId: 'a1', toolName: '', at: 1000 * S }), live)
        expect(text(d, ev({ agentId: 'a1', at: 1300 * S }))).toContain('active-after-stop')
    })

    it('reports an agent that never had a spawn signal', () => {
        const d = new DriftDetector()
        expect(text(d, ev({ agentId: 'a2', at: 1000 * S }))).toContain('never-spawned')
    })

    it('stays silent for a tracked agent', () => {
        const d = new DriftDetector()
        expect(kinds(d, ev({ agentId: 'a3', at: 1 }), { tracked: true, workflowRunning: false })).toEqual([])
    })

    it('ignores a trailing event within 60 s of the stop', () => {
        // 26% of real agents emit one more tool event right after their stop.
        const d = new DriftDetector()
        d.observe(ev({ event: 'SubagentStop', agentId: 'a4', toolName: '', at: 1000 * S }), live)
        expect(kinds(d, ev({ agentId: 'a4', at: 1059 * S }))).toEqual([])
    })

    it('ignores workflow agents, which are tracked separately', () => {
        const d = new DriftDetector()
        expect(kinds(d, ev({ agentId: 'w1', at: 1 }), { tracked: false, workflowRunning: true })).toEqual([])
        expect(kinds(d, ev({ agentId: 'w2', agentType: 'workflow-subagent', at: 1 }))).toEqual([])
    })

    it('reports the same agent once per stop, not on every event', () => {
        const d = new DriftDetector()
        expect(kinds(d, ev({ agentId: 'a5', at: 1 * S }))).toEqual(['untracked'])
        expect(kinds(d, ev({ agentId: 'a5', at: 2 * S }))).toEqual([])
        // A fresh stop is a fresh episode and may be reported again.
        d.observe(ev({ event: 'SubagentStop', agentId: 'a5', toolName: '', at: 10 * S }), live)
        expect(kinds(d, ev({ agentId: 'a5', at: 200 * S }))).toEqual(['untracked'])
    })

    it('does not blame a SendMessage sent before the stop', () => {
        const d = new DriftDetector()
        d.observe(ev({ event: 'PostToolUse', toolName: 'SendMessage', at: 990 * S, smResult: 'queued' }), live)
        d.observe(ev({ event: 'SubagentStop', agentId: 'a6', toolName: '', at: 1000 * S }), live)
        expect(text(d, ev({ agentId: 'a6', at: 1061 * S }))).toContain('active-after-stop')
    })

    it('forgets stops at a fresh session but not at compaction', () => {
        const d = new DriftDetector()
        d.observe(ev({ event: 'SubagentStop', agentId: 'a7', toolName: '', at: 1000 * S }), live)
        d.observe(ev({ event: 'SessionStart', toolName: '', source: 'compact', at: 1100 * S }), live)
        expect(text(d, ev({ agentId: 'a7', at: 1200 * S }))).toContain('active-after-stop')

        const e = new DriftDetector()
        e.observe(ev({ event: 'SubagentStop', agentId: 'a8', toolName: '', at: 1000 * S }), live)
        e.observe(ev({ event: 'SessionStart', toolName: '', source: 'startup', at: 1100 * S }), live)
        expect(text(e, ev({ agentId: 'a8', at: 1200 * S }))).toContain('never-spawned')
    })
})

describe('DriftDetector — new tools', () => {
    it('reports a built-in tool it has never seen, once', () => {
        const d = new DriftDetector()
        expect(text(d, ev({ toolName: 'SomeNewTool', at: 1 }))).toContain('SomeNewTool')
        expect(kinds(d, ev({ toolName: 'SomeNewTool', at: 2 }))).toEqual([])
    })

    it('stays silent for known tools and MCP tools', () => {
        const d = new DriftDetector()
        expect(kinds(d, ev({ toolName: 'Bash', at: 1 }))).toEqual([])
        expect(kinds(d, ev({ toolName: 'mcp__github__create_issue', at: 1 }))).toEqual([])
    })

    it('knows every tool seen in real logs when this was written', () => {
        for (const t of ['Bash', 'Read', 'WebFetch', 'Write', 'Edit', 'WebSearch', 'Agent', 'SubagentHandback',
            'SendMessage', 'Monitor', 'ToolSearch', 'TaskStop', 'SendUserFile', 'ScheduleWakeup',
            'AskUserQuestion', 'Skill', 'PushNotification', 'ReadNotifications', 'Workflow']) {
            expect(KNOWN_CLAUDE_TOOLS.has(t)).toBe(true)
        }
    })
})

describe('DriftDetector — SendMessage result format', () => {
    it('reports an unrecognised SendMessage result', () => {
        const d = new DriftDetector()
        expect(kinds(d, ev({ event: 'PostToolUse', toolName: 'SendMessage', smResult: 'unknown', at: 1 }))).toEqual(['sendmessage'])
    })

    it('stays silent for resumed, queued and error results', () => {
        const d = new DriftDetector()
        for (const r of ['resumed', 'queued', 'error']) {
            expect(kinds(d, ev({ event: 'PostToolUse', toolName: 'SendMessage', smResult: r, at: 1 }))).toEqual([])
        }
    })
})

/**
 * The wiring. A detector that is never called detects nothing, and the last two
 * fixes both shipped logic whose call site no test reached. These drive the real
 * HookWatcher with the real event sequence from the 2026-10 bug and assert that
 * a `[drift]` line is written — and that it is not written once the resume is
 * signalled properly.
 */
describe('HookWatcher writes [drift] lines', () => {
    afterEach(() => { vi.restoreAllMocks() })

    const tev = (e: Partial<TraceEvent>): TraceEvent => ({ tab_id: TAB, agent: 'claude', event: 'PostToolUse', ts: 0, ...e } as TraceEvent)
    const run = (resumedId: string) => {
        const spy = vi.spyOn(debugLog, 'log')
        const h = new ReplayHarness()
        const id = 'ad445c223fd587a4a'
        h.process(tev({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: id, ts: 1000 }))
        h.process(tev({ event: 'PreToolUse', tool_name: 'Bash', agent_id: id, ts: 1005 }))
        h.process(tev({ event: 'SubagentStop', agent_id: id, ts: 1100 }))
        h.process(tev({ event: 'PostToolUse', tool_name: 'SendMessage', resumed_agent_id: resumedId, sm_result: resumedId ? 'resumed' : 'unknown', ts: 1600 } as Partial<TraceEvent>))
        h.process(tev({ event: 'PreToolUse', tool_name: 'Bash', agent_id: id, ts: 1620 }))
        return spy.mock.calls.filter(c => c[1] === 'drift').map(c => String(c[2]))
    }

    it('flags a re-woken agent the counter missed', () => {
        const lines = run('')
        expect(lines.some(l => l.includes('resumed-uncounted'))).toBe(true)
        expect(lines.some(l => l.startsWith('sendmessage'))).toBe(true)
    })

    it('is silent when the resume is counted', () => {
        expect(run('ad445c223fd587a4a')).toEqual([])
    })
})
