import { describe, expect, it } from 'vitest'

import { stickyModel } from '../hook-watcher.service'
import { resolveModel } from '../tab-monitor'

/**
 * Which model slug the sidebar chip shows.
 *
 * The reported bug: switching model mid-session with `/model` left the chip on
 * the old slug indefinitely. Two correct behaviours combined into a wrong one —
 * HookWatcher keeps the SessionStart model STICKY (so the chip survives a resume,
 * whose SessionStart carries an empty model), and makeState let that hook value
 * win over the transcript. Sticky means frozen, so after a switch the chip was
 * pinned to whatever was active when the session began.
 *
 * Verified on a real session before the fix: the transcript moved
 * `claude-opus-4-8` -> `claude-opus-5` while every hook event carried
 * `model: ''` and the chip kept showing the old slug.
 */
describe('resolveModel', () => {
    it('shows the transcript model, which is the one that tracks /model', () => {
        // The exact shape of the reported bug: hook stuck on the session's
        // original model, transcript already on the new one.
        expect(resolveModel('claude-opus-4-8', 'claude-opus-5')).toBe('claude-opus-5')
    })

    it('falls back to the hook before the first assistant turn', () => {
        // A fresh session has a hook model but no transcript record yet.
        expect(resolveModel('claude-opus-5', null)).toBe('claude-opus-5')
        expect(resolveModel('claude-opus-5', undefined)).toBe('claude-opus-5')
    })

    it('keeps the hook value for agents that write no transcript model', () => {
        // Codex and opencode never return one (see computeCodex), and Codex
        // stamps the model on every hook event, so the hook is already fresh.
        expect(resolveModel('gpt-5.5', undefined)).toBe('gpt-5.5')
    })

    it('treats an empty hook model as absent', () => {
        // Claude's `resume` SessionStart sends model: ''.
        expect(resolveModel('', 'claude-opus-5')).toBe('claude-opus-5')
        expect(resolveModel('', null)).toBeNull()
    })

    it('reports null when neither source has one', () => {
        expect(resolveModel(null, null)).toBeNull()
        expect(resolveModel(undefined, undefined)).toBeNull()
    })
})

/**
 * The sticky rule is NOT the bug and must stay: without it the chip blanks on
 * every model-less event, and a resume would clear it permanently. These pin
 * that it keeps doing its job now that the transcript outranks it.
 */
describe('stickyModel still carries the hook value', () => {
    it('keeps the last non-empty slug across model-less events', () => {
        expect(stickyModel('PreToolUse', undefined, '', 'claude-opus-5')).toBe('claude-opus-5')
        expect(stickyModel('Stop', undefined, '', 'claude-opus-5')).toBe('claude-opus-5')
    })

    it('keeps it across a resume SessionStart, which carries no model', () => {
        expect(stickyModel('SessionStart', 'resume', '', 'claude-opus-5')).toBe('claude-opus-5')
    })

    it('drops it on a fresh startup with no model, as a stale-slug guard', () => {
        expect(stickyModel('SessionStart', 'startup', '', 'claude-opus-5')).toBeNull()
    })

    it('takes an incoming slug over the sticky one', () => {
        expect(stickyModel('SessionStart', 'startup', 'claude-opus-5', 'claude-opus-4-8')).toBe('claude-opus-5')
    })
})

/**
 * End to end over the two sources, as the poll loop sees them: a session that
 * starts on one model, switches mid-session, and resumes afterwards.
 */
describe('a mid-session /model switch reaches the chip', () => {
    it('updates once the next assistant turn lands, and survives resume', () => {
        // Session starts: hook carries the slug, transcript has nothing yet.
        let sticky = stickyModel('SessionStart', 'startup', 'claude-opus-4-8', null)
        expect(resolveModel(sticky, null)).toBe('claude-opus-4-8')

        // Ordinary events carry model: '' — sticky holds, transcript agrees.
        sticky = stickyModel('PreToolUse', undefined, '', sticky)
        expect(resolveModel(sticky, 'claude-opus-4-8')).toBe('claude-opus-4-8')

        // User runs /model. Nothing reaches the hooks; the next assistant turn
        // stamps the new slug in the transcript. THIS is the reported bug.
        sticky = stickyModel('Stop', undefined, '', sticky)
        expect(sticky).toBe('claude-opus-4-8')               // hook still stale
        expect(resolveModel(sticky, 'claude-opus-5')).toBe('claude-opus-5')

        // Resume: SessionStart carries no model, so only sticky + transcript
        // remain — the chip must not blank or revert.
        sticky = stickyModel('SessionStart', 'resume', '', sticky)
        expect(resolveModel(sticky, 'claude-opus-5')).toBe('claude-opus-5')
    })
})
