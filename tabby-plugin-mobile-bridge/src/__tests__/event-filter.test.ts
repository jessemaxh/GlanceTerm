import { describe, it, expect } from 'vitest'

import { hasStatusUpdates, nextStatusFilter, STATUS_EVENT_TYPES } from '../binding/event-filter'

/**
 * Guards the status-updates toggle against the reported bug: flipping it must
 * not silently clobber unrelated allowlist entries (tool_use, task_failed, …)
 * or the "empty = defaults (assistant_text only)" sentinel.
 */
describe('event-filter status toggle', () => {
    describe('hasStatusUpdates', () => {
        it('reads the state_transition sentinel', () => {
            expect(hasStatusUpdates([])).toBe(false)
            expect(hasStatusUpdates(['assistant_text'])).toBe(false)
            expect(hasStatusUpdates(['assistant_text', 'state_transition'])).toBe(true)
        })
    })

    describe('nextStatusFilter — turning ON', () => {
        it('seeds the assistant_text baseline from an empty (=defaults) filter', () => {
            expect(nextStatusFilter([])).toEqual([
                'assistant_text', 'needs_permission', 'task_completed', 'state_transition',
            ])
        })

        it('preserves unrelated allowlist entries (the reported bug)', () => {
            const out = nextStatusFilter(['assistant_text', 'tool_use', 'task_failed'])
            expect(out).toContain('tool_use')
            expect(out).toContain('task_failed')
            for (const e of STATUS_EVENT_TYPES) expect(out).toContain(e)
            expect(out.length).toBe(new Set(out).size) // no duplicates
        })

        it('respects an explicit allowlist that deliberately omits assistant_text', () => {
            const out = nextStatusFilter(['tool_use'])
            expect(out).not.toContain('assistant_text')
            expect(out).toContain('tool_use')
            for (const e of STATUS_EVENT_TYPES) expect(out).toContain(e)
        })
    })

    describe('nextStatusFilter — turning OFF', () => {
        it('collapses an only-baseline filter back to [] (defaults)', () => {
            expect(nextStatusFilter([
                'assistant_text', 'needs_permission', 'task_completed', 'state_transition',
            ])).toEqual([])
        })

        it('removes only the status events, preserving custom entries', () => {
            const out = nextStatusFilter([
                'assistant_text', 'tool_use', 'task_failed',
                'needs_permission', 'task_completed', 'state_transition',
            ])
            expect(out).toEqual(['assistant_text', 'tool_use', 'task_failed'])
        })

        it('keeps a no-assistant_text custom remainder as an explicit list', () => {
            expect(nextStatusFilter([
                'tool_use', 'needs_permission', 'task_completed', 'state_transition',
            ])).toEqual(['tool_use'])
        })
    })

    it('round-trips ON→OFF back to defaults for an empty filter', () => {
        expect(nextStatusFilter(nextStatusFilter([]))).toEqual([])
    })

    it('round-trips ON→OFF preserving a custom allowlist', () => {
        const original = ['assistant_text', 'tool_use']
        const on = nextStatusFilter(original)
        expect(hasStatusUpdates(on)).toBe(true)
        expect(nextStatusFilter(on)).toEqual(original)
    })
})
