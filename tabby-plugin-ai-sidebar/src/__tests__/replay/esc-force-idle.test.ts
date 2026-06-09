import { describe, expect, it } from 'vitest'

import { ReplayHarness } from './harness'
import { TabStatus } from '../../tab-monitor'

const TAB = 'c47db5dd-0000-0000-0000-000000000ESC'

/**
 * Covers the fast path: EscInterruptService observes a bare ESC press on
 * the pty input stream and calls HookWatcher.forceIdle(tabId). This test
 * exercises the watcher half of that contract for both agents we support
 * — agent-agnostic by construction because ESC is a terminal convention,
 * not an agent protocol.
 */
describe('HookWatcher.forceIdle (ESC fast-path target)', () => {
    it('flips a Working claude tab to Idle', () => {
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

        const flipped = h.watcher.forceIdle(TAB, 'user-esc')
        expect(flipped).toBe(true)
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
    })

    it('flips a Working codex tab to Idle (same code path, no per-agent branch)', () => {
        const h = new ReplayHarness()
        h.process({
            tab_id: TAB,
            agent: 'codex',
            event: 'UserPromptSubmit',
            session_id: 's1',
            cwd: '/repo',
            ts: 1_781_010_000,
        })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Working)

        const flipped = h.watcher.forceIdle(TAB, 'user-esc')
        expect(flipped).toBe(true)
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
    })

    it('is a no-op when no snapshot exists yet (fabrication guard)', () => {
        const h = new ReplayHarness()
        const flipped = h.watcher.forceIdle(TAB, 'user-esc')
        expect(flipped).toBe(false)
        expect(h.getStatus(TAB)).toBeNull()
    })

    it('is a no-op when already Idle', () => {
        const h = new ReplayHarness()
        h.process({
            tab_id: TAB,
            agent: 'claude',
            event: 'Stop',
            session_id: 's1',
            cwd: '/repo',
            ts: 1_781_010_000,
        })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.Idle)
        const flipped = h.watcher.forceIdle(TAB, 'user-esc')
        expect(flipped).toBe(false)
    })

    it('refuses to flip NeedsPermission (would hide a real prompt)', () => {
        const h = new ReplayHarness()
        h.process({
            tab_id: TAB,
            agent: 'claude',
            event: 'PermissionRequest',
            session_id: 's1',
            cwd: '/repo',
            ts: 1_781_010_000,
        })
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.NeedsPermission)
        const flipped = h.watcher.forceIdle(TAB, 'user-esc')
        expect(flipped).toBe(false)
        expect(h.getStatus(TAB)?.status).toBe(TabStatus.NeedsPermission)
    })

    it('updates eventAt so the slow-path probe rearms its grace window', () => {
        const h = new ReplayHarness()
        const past = 1_781_010_000
        h.process({
            tab_id: TAB,
            agent: 'claude',
            event: 'UserPromptSubmit',
            session_id: 's1',
            cwd: '/repo',
            ts: past,
        })
        const beforeMs = h.getStatus(TAB)!.eventAt
        const flipped = h.watcher.forceIdle(TAB, 'user-esc')
        expect(flipped).toBe(true)
        const afterMs = h.getStatus(TAB)!.eventAt
        expect(afterMs).toBeGreaterThan(beforeMs)
    })
})
