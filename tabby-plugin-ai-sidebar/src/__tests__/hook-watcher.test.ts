import { describe, it, expect } from 'vitest'

import {
    reduceSubagentSet,
    stickyModel,
    SubagentEvent,
} from '../hook-watcher.service'

/**
 * Helper: reduce a sequence of events from an empty set, returning the
 * final state. Mirrors what `processEvent` does at runtime.
 */
function run (events: SubagentEvent[]): ReadonlySet<string> {
    return events.reduce<ReadonlySet<string>>(reduceSubagentSet, new Set())
}

describe('stickyModel', () => {
    it('takes a non-empty incoming model (Claude SessionStart slug)', () => {
        expect(stickyModel('SessionStart', 'startup', 'claude-opus-4-8', null)).toBe('claude-opus-4-8')
    })
    it('keeps the sticky model on a model-less RESUME SessionStart (the bug fix)', () => {
        // Claude sends model='' on source:resume — must NOT wipe the chip.
        expect(stickyModel('SessionStart', 'resume', '', 'claude-opus-4-8')).toBe('claude-opus-4-8')
    })
    it('keeps the sticky model on a model-less COMPACT SessionStart', () => {
        expect(stickyModel('SessionStart', 'compact', '', 'claude-opus-4-8')).toBe('claude-opus-4-8')
    })
    it('keeps the sticky across the flood of model-less non-SessionStart events', () => {
        expect(stickyModel('PostToolUse', undefined, '', 'claude-opus-4-8')).toBe('claude-opus-4-8')
        expect(stickyModel('Stop', undefined, undefined, 'claude-opus-4-8')).toBe('claude-opus-4-8')
    })
    it('resets to null ONLY on a fresh model-less startup (stale-slug guard)', () => {
        expect(stickyModel('SessionStart', 'startup', '', 'gpt-5.5')).toBe(null)
    })
    it('a real startup re-sends its own model, overriding any stale sticky', () => {
        expect(stickyModel('SessionStart', 'startup', 'gpt-5.5', 'claude-opus-4-8')).toBe('gpt-5.5')
    })
    it('null prev + model-less continuation stays null', () => {
        expect(stickyModel('PreToolUse', undefined, '', null)).toBe(null)
    })
})

describe('reduceSubagentSet', () => {
    describe('spawn', () => {
        it('adds a new id to an empty set', () => {
            const out = reduceSubagentSet(new Set(), { kind: 'spawn', agentId: 'a1' })
            expect([...out]).toEqual(['a1'])
        })

        it('adds distinct ids cumulatively', () => {
            const out = run([
                { kind: 'spawn', agentId: 'a1' },
                { kind: 'spawn', agentId: 'a2' },
            ])
            expect([...out].sort()).toEqual(['a1', 'a2'])
        })

        it('is identity-preserving when the id is already tracked', () => {
            const before = new Set(['a1'])
            const after = reduceSubagentSet(before, { kind: 'spawn', agentId: 'a1' })
            expect(after).toBe(before)
        })

        it('does not mutate the input on insert', () => {
            const input: ReadonlySet<string> = new Set(['a1'])
            const out = reduceSubagentSet(input, { kind: 'spawn', agentId: 'a2' })
            expect([...input]).toEqual(['a1'])
            expect(out).not.toBe(input)
        })
    })

    describe('stop', () => {
        it('is identity-preserving on an empty set', () => {
            const empty: ReadonlySet<string> = new Set()
            const out = reduceSubagentSet(empty, { kind: 'stop', agentId: 'a1' })
            expect(out).toBe(empty)
        })

        it('removes the matching id when present (real subagent completion)', () => {
            const before = new Set(['a1', 'a2'])
            const after = reduceSubagentSet(before, { kind: 'stop', agentId: 'a1' })
            expect([...after].sort()).toEqual(['a2'])
        })

        it('is identity-preserving when the id is not tracked (phantom SubagentStop)', () => {
            const before: ReadonlySet<string> = new Set(['a1'])
            const after = reduceSubagentSet(before, { kind: 'stop', agentId: 'aPHANTOM' })
            expect(after).toBe(before)
        })

        it('does not mutate the input on remove', () => {
            const input: ReadonlySet<string> = new Set(['a1', 'a2'])
            const out = reduceSubagentSet(input, { kind: 'stop', agentId: 'a1' })
            expect([...input].sort()).toEqual(['a1', 'a2'])
            expect(out).not.toBe(input)
        })
    })

    describe('reset', () => {
        it('clears a non-empty set', () => {
            expect([...reduceSubagentSet(new Set(['a1', 'a2', 'a3']), { kind: 'reset' })]).toEqual([])
        })

        it('is identity-preserving on an empty set', () => {
            const empty: ReadonlySet<string> = new Set()
            expect(reduceSubagentSet(empty, { kind: 'reset' })).toBe(empty)
        })
    })

    describe('sequence: classic spawn / stop interleaving', () => {
        it('drains cleanly when every stop matches a spawn', () => {
            const final = run([
                { kind: 'spawn', agentId: 'a1' },
                { kind: 'spawn', agentId: 'a2' },
                { kind: 'spawn', agentId: 'a3' },
                { kind: 'stop',  agentId: 'a2' },
                { kind: 'stop',  agentId: 'a1' },
            ])
            expect([...final]).toEqual(['a3'])  // a3 never matched a stop
        })
    })

    describe('sequence: real-world ACK pattern (the bug this rewrite fixes)', () => {
        // The reviewer-agent trace from c47db5dd-* hook log: PreToolUse(Agent)
        // returns spawn_agent_id=aR. ~1s after main Stop a phantom SubagentStop
        // fires with agent_id=aPHANTOM (no agent_type, never spawned by us);
        // 153s later the real SubagentStop fires with agent_id=aR.
        //
        // The old timestamp-window heuristic incorrectly popped aR on the
        // phantom Stop (35s gap fell inside the [30s, 4min] band), then had
        // nothing to pop when the real Stop arrived. The new id-based logic
        // drops the phantom (its id was never tracked) and pops aR on the
        // real Stop. Result: counter > 0 across the full subagent runtime.
        it('phantom stop is dropped; counter stays > 0 until real stop pops', () => {
            const state1 = run([
                { kind: 'spawn', agentId: 'aR' },             // PostToolUse(Agent) spawn_agent_id
                { kind: 'stop',  agentId: 'aPHANTOM' },       // unrelated SubagentStop
            ])
            expect([...state1]).toEqual(['aR'])               // aR still live ✓

            const state2 = reduceSubagentSet(state1, { kind: 'stop', agentId: 'aR' })
            expect([...state2]).toEqual([])                   // real completion pops
        })
    })

    describe('sequence: passive-liveness recovery from missed spawn', () => {
        // We missed the PostToolUse(Agent) spawn (stale cold-load), but the
        // subagent's first tool call carries top-level agent_id=aMissed.
        // The processEvent caller dispatches that as a spawn event; the set
        // catches up. When SubagentStop eventually fires with the same id,
        // we pair correctly.
        it('passive spawn followed by stop drains', () => {
            const final = run([
                { kind: 'spawn', agentId: 'aMissed' },        // synthesized from PreToolUse w/ agent_id
                { kind: 'stop',  agentId: 'aMissed' },
            ])
            expect([...final]).toEqual([])
        })
    })

    describe('sequence: reset clears mid-flight set', () => {
        it('drops live ids on SessionStart/End and accepts new spawns after', () => {
            const final = run([
                { kind: 'spawn', agentId: 'a1' },
                { kind: 'spawn', agentId: 'a2' },
                { kind: 'reset' },
                { kind: 'spawn', agentId: 'a3' },
            ])
            expect([...final]).toEqual(['a3'])
        })
    })
})
