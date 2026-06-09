import { describe, expect, it } from 'vitest'

import { ClaudeHookAdapter } from '../hook-adapters/claude'
import { TabStatus } from '../tab-monitor'

describe('ClaudeHookAdapter status mapping', () => {
    it.each([
        ['Stop', TabStatus.Idle],
        ['StopFailure', TabStatus.Idle],
        ['UserPromptSubmit', TabStatus.Working],
        ['PermissionRequest', TabStatus.NeedsPermission],
    ])('maps %s to %s', (event, expected) => {
        expect(new ClaudeHookAdapter().mapEventToStatus(event)).toBe(expected)
    })

    it('registers StopFailure as a supported hook event', () => {
        expect(new ClaudeHookAdapter().hookEvents().map(e => e.event)).toContain('StopFailure')
    })
})
