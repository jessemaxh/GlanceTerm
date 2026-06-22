import { describe, it, expect } from 'vitest'
import type { TabStatus } from 'tabby-plugin-ai-sidebar'

import { classifyStatusTransition } from '../status-transition'

/**
 * Regression guard for the mobile-bridge "agent started" push. The high-value
 * case is the permission round-trip: working → needs_permission → working must
 * NOT fire a second `state_transition` ("started") on the resume leg, or every
 * permission approval spams a duplicate, misleading start notification.
 *
 * Status strings below are the raw TabStatus values (see status-transition.ts
 * for why we compare against literals rather than importing the ai-sidebar-
 * bound TabStatus object). The `import type` keeps the pairs honest without a
 * runtime dependency.
 */
describe('classifyStatusTransition', () => {
    it('fires state_transition on a fresh turn (non-working → working)', () => {
        expect(classifyStatusTransition('working', 'idle')).toBe('state_transition')
        expect(classifyStatusTransition('working', 'done')).toBe('state_transition')
        expect(classifyStatusTransition('working', 'no_ai')).toBe('state_transition')
    })

    it('does NOT fire state_transition on needs_permission → working (same turn resuming)', () => {
        // THE FIX: approving a permission prompt resumes the same turn; it is
        // not a new "agent started".
        expect(classifyStatusTransition('working', 'needs_permission')).toBeNull()
    })

    it('fires needs_permission on any → needs_permission', () => {
        expect(classifyStatusTransition('needs_permission', 'working')).toBe('needs_permission')
        expect(classifyStatusTransition('needs_permission', 'idle')).toBe('needs_permission')
    })

    it('fires task_completed only when leaving working for idle/done', () => {
        expect(classifyStatusTransition('idle', 'working')).toBe('task_completed')
        expect(classifyStatusTransition('done', 'working')).toBe('task_completed')
    })

    it('does NOT treat a cancelled permission prompt (needs_permission → idle) as a completed turn', () => {
        expect(classifyStatusTransition('idle', 'needs_permission')).toBeNull()
    })

    it('ignores desktop focus flips and agent teardown', () => {
        expect(classifyStatusTransition('idle', 'done')).toBeNull()    // unfocus
        expect(classifyStatusTransition('done', 'idle')).toBeNull()    // focus
        expect(classifyStatusTransition('no_ai', 'working')).toBeNull() // agent gone
        expect(classifyStatusTransition('no_ai', 'idle')).toBeNull()
    })

    it('a full permission round-trip yields exactly one started + one completed', () => {
        // idle → working (started) → needs_permission (needs) → working (—)
        //      → idle (completed)
        const seq: Array<[TabStatus, TabStatus]> = [
            ['working', 'idle'],
            ['needs_permission', 'working'],
            ['working', 'needs_permission'],
            ['idle', 'working'],
        ]
        const events = seq.map(([s, p]) => classifyStatusTransition(s, p))
        expect(events).toEqual(['state_transition', 'needs_permission', null, 'task_completed'])
        expect(events.filter(e => e === 'state_transition')).toHaveLength(1)
    })
})
