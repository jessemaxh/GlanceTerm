import { describe, expect, it } from 'vitest'

import { isNestedClaudeEvent, parseClaudePid } from '../hook-watcher.service'
import { TabStatus } from '../tab-monitor'
import { ReplayHarness, TraceEvent } from './replay/harness'

/**
 * A claude launched BY a tab's own agent (a subagent running `claude -p` from
 * its Bash tool) inherits the tab's GLANCETERM_TAB_ID, so its hook events land
 * in that tab's log. Before this fix they rewrote the tab: on a real tab, five
 * times in two days, the nested `SessionStart(startup)` wiped a still-working
 * subagent from the count, the nested `SessionEnd` turned the row into "shell"
 * while the tab's claude was alive, and the nested session id / transcript /
 * model replaced the tab's own.
 *
 * The replay below is that incident, from the real log: owner session 4b5b2598
 * (claude pid 12443) with a background aiartgen-flutter agent working, and a
 * reviewer `claude -p` (session 8ea43521) started by that agent.
 */

const TAB = 'a6429df5-8cb3-4323-81f6-40b433fd1e79'
const OWNER = 12443
const NESTED = 51234
const MAIN_SESSION = '4b5b2598-fcd0-4dfa-98a0-07b51f855689'
const NESTED_SESSION = '8ea43521-22c6-4c21-9f8f-9d44bb980c53'
const MAIN_TX = `/Users/u/.claude/projects/-Users-u-work-aiartgen/${MAIN_SESSION}.jsonl`
const NESTED_TX = `/Users/u/.claude/projects/-Users-u-work-aiartgen-AIArtFlutter/${NESTED_SESSION}.jsonl`
const FLUTTER = 'a5e1045c27de4bded'

const ev = (e: Partial<TraceEvent> & { claude_pid?: string }): TraceEvent => ({
    tab_id: TAB, agent: 'claude', event: 'PostToolUse', ts: 0, ...e,
} as TraceEvent)
const main = (e: Partial<TraceEvent>) => ev({ session_id: MAIN_SESSION, transcript_path: MAIN_TX, claude_pid: String(OWNER), ...e } as Partial<TraceEvent>)
const nested = (e: Partial<TraceEvent>) => ev({ session_id: NESTED_SESSION, transcript_path: NESTED_TX, claude_pid: String(NESTED), cwd: '/Users/u/work/aiartgen/AIArtFlutter', ...e } as Partial<TraceEvent>)

/** Owner session running, a background subagent spawned and working, main
 *  agent idle waiting for it — the state just before the nested claude starts. */
function ownerWithBackgroundAgent (opts: { ownerAlive?: boolean, setOwner?: boolean } = {}) {
    const h = new ReplayHarness()
    h.watcher.isPidAlive = () => opts.ownerAlive ?? true
    if (opts.setOwner ?? true) {
        h.watcher.setTabOwnerPid(TAB, OWNER)
    }
    h.process(main({ event: 'SessionStart', source: 'resume', ts: 1000 } as Partial<TraceEvent>))
    h.process(main({ event: 'UserPromptSubmit', ts: 1010 }))
    h.process(main({ event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: FLUTTER, ts: 1020 }))
    h.process(main({ event: 'Stop', ts: 1030 }))
    h.process(ev({ event: 'PreToolUse', tool_name: 'Bash', agent_id: FLUTTER, claude_pid: String(OWNER), ts: 1040 } as Partial<TraceEvent>))
    return h
}

describe('events from a nested claude', () => {
    it('reproduces the incident without the fix: count wiped, row reads "shell"', () => {
        // Same sequence with no owner known — today's behaviour.
        const h = ownerWithBackgroundAgent({ setOwner: false })
        expect(h.getSubagentInFlight(TAB)).toBe(1)
        h.process(nested({ event: 'SessionStart', source: 'startup', ts: 1100 } as Partial<TraceEvent>))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
        h.process(nested({ event: 'SessionEnd', ts: 1500 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.NoAi)
    })

    it('keeps the background agent counted through a nested SessionStart', () => {
        const h = ownerWithBackgroundAgent()
        h.process(nested({ event: 'SessionStart', source: 'startup', ts: 1100 } as Partial<TraceEvent>))
        expect(h.getSubagentInFlight(TAB)).toBe(1)
    })

    it('does not turn the row into "shell" on a nested SessionEnd', () => {
        const h = ownerWithBackgroundAgent()
        const before = h.getStatus(TAB)?.status
        h.process(nested({ event: 'SessionStart', source: 'startup', ts: 1100 } as Partial<TraceEvent>))
        h.process(nested({ event: 'UserPromptSubmit', ts: 1101 }))
        h.process(nested({ event: 'PreToolUse', tool_name: 'Bash', ts: 1102 }))
        h.process(nested({ event: 'SessionEnd', ts: 1500 }))
        expect(h.getStatus(TAB)?.status).not.toBe(TabStatus.NoAi)
        expect(h.getStatus(TAB)?.status).toBe(before)
    })

    it("keeps the tab's own session id, transcript and model", () => {
        // The session id feeds auto-resume and the transcript feeds the token
        // chip: both pointed at the finished reviewer before this fix.
        const h = ownerWithBackgroundAgent()
        h.process(main({ event: 'SessionStart', source: 'compact', model: 'claude-opus-5-5', ts: 1050 } as Partial<TraceEvent>))
        h.process(nested({ event: 'SessionStart', source: 'startup', model: 'claude-sonnet-5', ts: 1100 } as Partial<TraceEvent>))
        h.process(nested({ event: 'PostToolUse', tool_name: 'Bash', ts: 1200 }))
        const s = h.getStatus(TAB)
        expect(s?.sessionId).toBe(MAIN_SESSION)
        expect(s?.transcriptPath).toBe(MAIN_TX)
        expect(s?.model).toBe('claude-opus-5-5')
    })

    it("still follows the tab's own claude afterwards", () => {
        const h = ownerWithBackgroundAgent()
        h.process(nested({ event: 'SessionEnd', ts: 1500 }))
        h.process(main({ event: 'UserPromptSubmit', ts: 1600 }))
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
        h.process(ev({ event: 'SubagentStop', agent_id: FLUTTER, claude_pid: String(OWNER), ts: 1700 } as Partial<TraceEvent>))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })
})

describe('falls back to the old behaviour when unsure', () => {
    it('without a claude_pid (older Claude)', () => {
        const h = ownerWithBackgroundAgent()
        h.process(ev({ event: 'SessionStart', source: 'startup', session_id: NESTED_SESSION, ts: 1100 } as Partial<TraceEvent>))
        expect(h.getSubagentInFlight(TAB)).toBe(0)
    })

    it('when the owner has exited — a new claude started in the tab', () => {
        // TabMonitor has not polled yet, so the owner is still the old pid,
        // but that process is gone: the new claude's events must apply.
        const h = ownerWithBackgroundAgent({ ownerAlive: false })
        h.process(nested({ event: 'SessionStart', source: 'startup', ts: 1100 } as Partial<TraceEvent>))
        expect(h.getStatus(TAB)?.sessionId).toBe(NESTED_SESSION)
    })

    it('for agents other than claude', () => {
        const h = new ReplayHarness()
        h.watcher.isPidAlive = () => true
        h.watcher.setTabOwnerPid(TAB, OWNER)
        h.process(ev({ agent: 'codex', event: 'SessionStart', session_id: 'c1', claude_pid: String(NESTED), ts: 1000 } as Partial<TraceEvent>))
        expect(h.getStatus(TAB)?.sessionId).toBe('c1')
    })
})

describe('isNestedClaudeEvent', () => {
    const alive = () => true
    const dead = () => false
    it('is nested only when a different pid fires while the owner lives', () => {
        expect(isNestedClaudeEvent(NESTED, OWNER, alive)).toBe(true)
        expect(isNestedClaudeEvent(OWNER, OWNER, alive)).toBe(false)
        expect(isNestedClaudeEvent(NESTED, OWNER, dead)).toBe(false)
        expect(isNestedClaudeEvent(null, OWNER, alive)).toBe(false)
        expect(isNestedClaudeEvent(NESTED, undefined, alive)).toBe(false)
    })
})

describe('parseClaudePid', () => {
    it('accepts positive integers only', () => {
        expect(parseClaudePid('12443')).toBe(12443)
        expect(parseClaudePid('')).toBeNull()
        expect(parseClaudePid('0')).toBeNull()
        expect(parseClaudePid('12a')).toBeNull()
        expect(parseClaudePid(undefined)).toBeNull()
        expect(parseClaudePid(12443)).toBeNull()
    })
})
