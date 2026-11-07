import { describe, expect, it } from 'vitest'

import { PROMPT_INTERVAL_MS, shouldPrompt } from '../auto-update.service'

describe('update-ready prompt throttle', () => {
    const now = 1_790_000_000_000

    it('prompts when it has never prompted', () => {
        expect(shouldPrompt(null, now)).toBe(true)
    })

    it('stays quiet within a day of the last prompt', () => {
        expect(shouldPrompt(now - 6 * 3_600_000, now)).toBe(false)
        expect(shouldPrompt(now - PROMPT_INTERVAL_MS + 1, now)).toBe(false)
    })

    it('prompts again once a day has passed', () => {
        expect(shouldPrompt(now - PROMPT_INTERVAL_MS, now)).toBe(true)
    })

    it('treats a last-prompt time in the future as stale', () => {
        expect(shouldPrompt(now + 3_600_000, now)).toBe(true)
    })
})
