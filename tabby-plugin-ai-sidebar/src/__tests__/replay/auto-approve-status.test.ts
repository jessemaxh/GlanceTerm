import { describe, expect, it } from 'vitest'

import { ReplayHarness } from './harness'
import { TabStatus } from '../../tab-monitor'

const TAB = 'cfca823d-0000-0000-0000-00000000AUTO'

/**
 * End-to-end watcher coverage for the auto-approve status override
 * (HookWatcher.processEvent). Pins the bug where a long-running, auto-approved
 * tool left the sidebar row stuck on `needs_permission` ("needs you") for the
 * tool's entire runtime: the handler stamps an auto-approved PermissionRequest
 * with `auto_approved:1` and the watcher must render it as `working`, since the
 * grant is instant and the user is never actually blocked.
 *
 * The fixture mirrors the real on-disk trace that surfaced the bug: a
 * permission-gated Bash that ran ~120 s before PostToolUse landed.
 */
describe('HookWatcher — auto-approved PermissionRequest → working', () => {
    it('renders an auto-approved (auto_approved:1) PermissionRequest as working, not needs_permission', () => {
        const h = new ReplayHarness()
        // PreToolUse (working) → PermissionRequest auto-approved. Without the
        // override this lands on needs_permission and stays there until the
        // tool finishes (PostToolUse), which can be minutes later.
        h.process({ tab_id: TAB, agent: 'claude', event: 'PreToolUse', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_316_663 })
        h.process({ tab_id: TAB, agent: 'claude', event: 'PermissionRequest', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_316_663, auto_approved: 1 })

        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
    })

    it('still renders a NON-auto-approved PermissionRequest as needs_permission (relay / local prompt)', () => {
        const h = new ReplayHarness()
        h.process({ tab_id: TAB, agent: 'claude', event: 'PreToolUse', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_316_663 })
        // No auto_approved field → genuine user-gated request.
        h.process({ tab_id: TAB, agent: 'claude', event: 'PermissionRequest', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_316_663 })

        expect(h.getStatus(TAB)?.status).toBe(TabStatus.NeedsPermission)
    })

    it('applies the override to codex too (same event name, agent-agnostic)', () => {
        const h = new ReplayHarness()
        h.process({ tab_id: TAB, agent: 'codex', event: 'PermissionRequest', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_316_663, auto_approved: 1 })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
    })

    it('PostToolUse after the auto-approved run keeps the row working (full cycle)', () => {
        const h = new ReplayHarness()
        h.process({ tab_id: TAB, agent: 'claude', event: 'PreToolUse', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_316_663 })
        h.process({ tab_id: TAB, agent: 'claude', event: 'PermissionRequest', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_316_663, auto_approved: 1 })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
        // ~120 s later the tool finishes.
        h.process({ tab_id: TAB, agent: 'claude', event: 'PostToolUse', tool_name: 'Bash', session_id: 's', cwd: '/repo', ts: 1_781_316_783 })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)
    })
})
