import { describe, it, expect, beforeEach } from 'vitest'
import { Subject } from 'rxjs'

import { UnreadService } from '../unread.service'

/**
 * The toolbar / dock badge counts "AI finished, you haven't looked" tabs. The
 * bug: it only cleared on terminal interaction or tab close, so when a ready tab
 * resumed working the badge stuck. clearForWorking() (wired from the notifier's
 * →working transition) is the fix.
 */
describe('UnreadService', () => {
    let svc: UnreadService
    const tab = () => ({}) as any // markReady's armInteractionListener no-ops on a frontend-less stub

    beforeEach(() => {
        svc = new UnreadService({ tabRemoved$: new Subject() } as any)
    })

    it('markReady increments the count and is idempotent', () => {
        const t = tab()
        svc.markReady(t)
        expect(svc.count).toBe(1)
        svc.markReady(t)
        expect(svc.count).toBe(1) // second mark while still unread is a no-op
    })

    it('clearForWorking unsticks a ready tab when it resumes working', () => {
        const t = tab()
        svc.markReady(t)
        expect(svc.count).toBe(1)
        svc.clearForWorking(t)
        expect(svc.count).toBe(0)
        expect(svc.isUnread(t)).toBe(false)
    })

    it('clearForWorking is a no-op for a tab that was never ready', () => {
        svc.clearForWorking(tab())
        expect(svc.count).toBe(0)
    })

    it('two ready tabs; one resumes working → count drops to 1', () => {
        const a = tab(); const b = tab()
        svc.markReady(a)
        svc.markReady(b)
        expect(svc.count).toBe(2)
        svc.clearForWorking(a)
        expect(svc.count).toBe(1)
        expect(svc.isUnread(b)).toBe(true)
    })

    it('a tab can go ready again after resuming working (re-counts)', () => {
        const t = tab()
        svc.markReady(t)
        svc.clearForWorking(t)
        expect(svc.count).toBe(0)
        svc.markReady(t) // next stable working→idle re-arms the badge
        expect(svc.count).toBe(1)
    })
})
