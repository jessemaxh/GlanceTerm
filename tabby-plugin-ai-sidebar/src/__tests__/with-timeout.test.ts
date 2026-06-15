import { describe, it, expect } from 'vitest'
import { withTimeout } from '../tab-monitor'

/**
 * `withTimeout` is the deterministic guard added to TabMonitor.tick()'s hot
 * path: getTruePID / getChildProcesses / getWorkingDirectory / readdir('/proc')
 * round-trip to the pty host or kernel and, when wedged, never settle. Under
 * tick()'s `busy` mutex one such hang freezes EVERY tab's status (busy never
 * clears). These assert the await always settles within the deadline.
 */
describe('withTimeout — a hung PTY-IPC await can never wedge tick()', () => {
    it('resolves to the real value when the promise settles in time', async () => {
        expect(await withTimeout(Promise.resolve(42), 1000, -1)).toBe(42)
    })

    it('resolves to the fallback when the promise NEVER settles (the freeze case)', async () => {
        const wedged = new Promise<number>(() => { /* a zombie pty: never resolves */ })
        const start = Date.now()
        const v = await withTimeout(wedged, 20, -1)
        expect(v).toBe(-1)
        expect(Date.now() - start).toBeLessThan(500) // settled at the deadline, not hung
    })

    it('resolves to the fallback when the promise rejects (no unhandledRejection)', async () => {
        expect(await withTimeout(Promise.reject(new Error('pty died')), 1000, 'fb')).toBe('fb')
    })

    it('a value arriving before the deadline wins over the fallback', async () => {
        const slow = new Promise<string>(res => setTimeout(() => res('value'), 5))
        expect(await withTimeout(slow, 1000, 'fb')).toBe('value')
    })
})
