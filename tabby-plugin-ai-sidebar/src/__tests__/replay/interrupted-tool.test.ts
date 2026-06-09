import { describe, expect, it } from 'vitest'

import { ReplayHarness } from './harness'
import { TabStatus } from '../../tab-monitor'

const TAB = 'c47db5dd-0000-0000-0000-000000000002'

describe('replay — interrupted tool calls', () => {
    it('maps PostToolUse(interrupted=true) to idle when Claude does not fire Stop', () => {
        const h = new ReplayHarness()

        h.process({
            tab_id: TAB,
            agent: 'claude',
            event: 'UserPromptSubmit',
            session_id: 's1',
            cwd: '/repo',
            ts: 1_781_010_000,
        })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)

        h.process({
            tab_id: TAB,
            agent: 'claude',
            event: 'PostToolUse',
            tool_name: 'Bash',
            session_id: 's1',
            cwd: '/repo',
            ts: 1_781_010_010,
            interrupted: 1,
        })

        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
    })
})
