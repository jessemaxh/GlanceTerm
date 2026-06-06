import { describe, it, expect } from 'vitest'

import {
    reduceSubagentQueue,
    SUBAGENT_PAIR_MIN_AGE_MS,
    SUBAGENT_PAIR_MAX_AGE_MS,
    SubagentEvent,
} from '../hook-watcher.service'

/**
 * Helper: reduce a sequence of events from an empty queue, returning the
 * final state. Mirrors what `processEvent` does at runtime.
 */
function run (events: SubagentEvent[]): readonly number[] {
    return events.reduce<readonly number[]>(reduceSubagentQueue, [])
}

describe('reduceSubagentQueue', () => {
    describe('spawn', () => {
        it('appends to an empty queue', () => {
            expect(reduceSubagentQueue([], { kind: 'spawn', at: 1000 }))
                .toEqual([1000])
        })

        it('appends to a non-empty queue in order', () => {
            const q = reduceSubagentQueue([1000], { kind: 'spawn', at: 2000 })
            expect(q).toEqual([1000, 2000])
        })

        it('does not mutate the input', () => {
            const input: readonly number[] = [1000]
            const out = reduceSubagentQueue(input, { kind: 'spawn', at: 2000 })
            expect(input).toEqual([1000])
            expect(out).not.toBe(input)
        })
    })

    describe('stop', () => {
        it('is a no-op on an empty queue', () => {
            const empty: readonly number[] = []
            const q = reduceSubagentQueue(empty, { kind: 'stop', at: 50_000 })
            expect(q).toBe(empty)  // identity-preserving
        })

        it('drops a stop that arrives <MIN ms after the oldest spawn (instant-ACK noise)', () => {
            const before: readonly number[] = [1000]
            const stopAt = 1000 + SUBAGENT_PAIR_MIN_AGE_MS - 1
            const after = reduceSubagentQueue(before, { kind: 'stop', at: stopAt })
            expect(after).toBe(before)
        })

        it('drops a stop that arrives >MAX ms after the oldest spawn', () => {
            const before: readonly number[] = [1000]
            const stopAt = 1000 + SUBAGENT_PAIR_MAX_AGE_MS + 1
            const after = reduceSubagentQueue(before, { kind: 'stop', at: stopAt })
            expect(after).toBe(before)
        })

        it('pops the oldest when stop arrives exactly at MIN', () => {
            const after = reduceSubagentQueue([1000], { kind: 'stop', at: 1000 + SUBAGENT_PAIR_MIN_AGE_MS })
            expect(after).toEqual([])
        })

        it('pops the oldest when stop arrives exactly at MAX', () => {
            const after = reduceSubagentQueue([1000], { kind: 'stop', at: 1000 + SUBAGENT_PAIR_MAX_AGE_MS })
            expect(after).toEqual([])
        })

        it('pops the oldest when stop is comfortably mid-band', () => {
            const after = reduceSubagentQueue([1000, 50_000], { kind: 'stop', at: 200_000 })
            expect(after).toEqual([50_000])
        })

        it('preserves the rest of the queue when popping the oldest', () => {
            const after = reduceSubagentQueue(
                [10_000, 30_000, 50_000],
                { kind: 'stop', at: 200_000 },
            )
            expect(after).toEqual([30_000, 50_000])
        })

        it('does not pop a younger spawn when the oldest is out of band', () => {
            // Oldest at 1000 is 600s away (way past MAX); even though the
            // newer spawn at 540_000 would be in band, the reducer only
            // checks the oldest, not the newest.
            const before: readonly number[] = [1000, 540_000]
            const stopAt = 600_000
            const after = reduceSubagentQueue(before, { kind: 'stop', at: stopAt })
            expect(after).toBe(before)
        })
    })

    describe('reset', () => {
        it('clears a non-empty queue', () => {
            expect(reduceSubagentQueue([1000, 2000, 3000], { kind: 'reset' })).toEqual([])
        })

        it('is identity-preserving on an empty queue', () => {
            const empty: readonly number[] = []
            expect(reduceSubagentQueue(empty, { kind: 'reset' })).toBe(empty)
        })
    })

    describe('sequence: classic 4-spawn / 3-stop interleaving (synthetic)', () => {
        // 4 spawns 30s apart from T=10s, stops 200s after each — all in band,
        // each pops the corresponding oldest. Final queue empty.
        it('drains cleanly when every stop pairs', () => {
            const final = run([
                { kind: 'spawn', at: 10_000 },
                { kind: 'spawn', at: 40_000 },
                { kind: 'spawn', at: 70_000 },
                { kind: 'spawn', at: 100_000 },
                { kind: 'stop',  at: 210_000 },  // age 200s → pops 10_000
                { kind: 'stop',  at: 240_000 },  // age 200s → pops 40_000
                { kind: 'stop',  at: 270_000 },  // age 200s → pops 70_000
            ])
            expect(final).toEqual([100_000])  // one spawn left, never paired
        })
    })

    describe('sequence: gmailClient real-world trace (commit message data)', () => {
        // From the engineering review commit message: 4 spawns + multiple
        // SubagentStops. The queue's documented end-state under the
        // chosen MIN=30s, MAX=4min window is 2 spawns left over (the
        // claim that the fix shows "more than nothing" for the real bug
        // even if it doesn't perfectly track reality).
        it('matches the documented final queue length of 2', () => {
            // Timestamps from the actual log, in ms. Pre-window spurious
            // stops first (all rejected because queue is empty), then the
            // real interleaved spawns and stops.
            const events: SubagentEvent[] = [
                // 5 spurious stops with no preceding spawn — all no-op
                { kind: 'stop',  at: 1_780_749_103_000 },
                { kind: 'stop',  at: 1_780_749_392_000 },
                { kind: 'stop',  at: 1_780_750_882_000 },
                { kind: 'stop',  at: 1_780_751_108_000 },
                { kind: 'stop',  at: 1_780_751_801_000 },
                // Spawn 1 + cluster of stops
                { kind: 'spawn', at: 1_780_752_825_000 },
                { kind: 'stop',  at: 1_780_753_033_000 },  // age 208s — in band → pops spawn 1
                { kind: 'stop',  at: 1_780_753_044_000 },  // queue empty → no-op
                { kind: 'stop',  at: 1_780_753_825_000 },  // queue empty → no-op
                // Spawn 2 + cluster of stops
                { kind: 'spawn', at: 1_780_754_106_000 },
                { kind: 'stop',  at: 1_780_754_300_000 },  // age 194s — in band → pops spawn 2
                { kind: 'stop',  at: 1_780_754_423_000 },  // queue empty → no-op
                { kind: 'stop',  at: 1_780_755_641_000 },  // queue empty → no-op
                // Spawn 3 + cluster of stops
                { kind: 'spawn', at: 1_780_755_743_000 },
                { kind: 'stop',  at: 1_780_756_028_000 },  // age 285s — OUT of band (>MAX=240s) → no-op, spawn 3 stays
                // Spawn 4 + cluster of stops
                { kind: 'spawn', at: 1_780_757_070_000 },
                { kind: 'stop',  at: 1_780_757_086_000 },  // age 16s — UNDER min (instant ACK) → no-op
                { kind: 'stop',  at: 1_780_757_325_000 },  // oldest is spawn 3 (1583s old) → OUT of band → no-op
                { kind: 'stop',  at: 1_780_757_443_000 },  // oldest is spawn 3 (1700s old) → OUT of band → no-op
            ]
            const final = run(events)
            expect(final.length).toBe(2)  // Spawn 3 and Spawn 4 both stuck
            expect(final).toEqual([1_780_755_743_000, 1_780_757_070_000])
        })
    })

    describe('sequence: degenerate "0 spawns / many stops" (glanceterm trace)', () => {
        // No spawns at all, several spurious stops. Pre-fix the plain
        // counter went to 0 (already 0). Post-fix it stays at 0. The
        // important property: queue length never goes negative, never
        // gains a phantom entry from a stop.
        it('queue stays empty and never accumulates phantom entries', () => {
            const final = run([
                { kind: 'stop', at: 1_780_749_861_000 },
                { kind: 'stop', at: 1_780_749_936_000 },
                { kind: 'stop', at: 1_780_752_583_000 },
                { kind: 'stop', at: 1_780_754_328_000 },
            ])
            expect(final).toEqual([])
        })
    })

    describe('sequence: reset clears mid-flight queue', () => {
        it('drops queued spawns on SessionStart/End', () => {
            const final = run([
                { kind: 'spawn', at: 1000 },
                { kind: 'spawn', at: 2000 },
                { kind: 'reset' },
                { kind: 'spawn', at: 3000 },
            ])
            expect(final).toEqual([3000])
        })
    })
})
