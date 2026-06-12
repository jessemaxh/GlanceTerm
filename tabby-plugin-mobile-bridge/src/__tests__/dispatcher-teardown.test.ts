import { describe, it, expect } from 'vitest'

import { isUnrecoverableStartError, MessagingError } from '../backends/types'

/**
 * The classifier decides whether a backend-start failure tears the binding
 * down (back to unbound) or is retried on the next bindings$ emission.
 * Getting this wrong in either direction is bad: classifying a transient
 * blip as unrecoverable nukes a good binding; classifying an unrecoverable
 * credential failure as transient re-creates the permanent failing-retry
 * loop that fed the OOM.
 */
describe('isUnrecoverableStartError', () => {
    it('tears down on auth_failed (keystore decrypt fail / revoked token)', () => {
        expect(isUnrecoverableStartError(
            new MessagingError('auth_failed', 'keystore read failed (re-pair to recover)'),
        )).toBe(true)
    })

    it('does NOT tear down on transient kinds', () => {
        for (const kind of ['rate_limited', 'unknown', 'thread_closed', 'thread_not_found', 'permission_denied'] as const) {
            expect(isUnrecoverableStartError(new MessagingError(kind, 'x'))).toBe(false)
        }
    })

    it('does NOT tear down on chat_not_found (bot may be re-added) — stays retryable', () => {
        expect(isUnrecoverableStartError(new MessagingError('chat_not_found', 'x'))).toBe(false)
    })

    it('does NOT tear down on a plain Error or non-error (be conservative)', () => {
        expect(isUnrecoverableStartError(new Error('network down'))).toBe(false)
        expect(isUnrecoverableStartError('boom')).toBe(false)
        expect(isUnrecoverableStartError(null)).toBe(false)
        expect(isUnrecoverableStartError(undefined)).toBe(false)
    })
})
