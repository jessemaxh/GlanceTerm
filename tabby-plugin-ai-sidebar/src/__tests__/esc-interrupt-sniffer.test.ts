import { describe, expect, it } from 'vitest'

import { feedEscSniffer, EscSnifferState, ESC_TIMEOUT_MS } from '../esc-interrupt.service'

/**
 * Drive the sniffer with a fake clock so we can assert the disambiguator
 * without real timers. `pending` holds the in-flight arm-callback; we
 * fire it manually with `flush()`.
 */
function makeClock () {
    let pending: { fn: () => void; ms: number } | null = null
    return {
        setTimer: ((fn: () => void, ms: number) => {
            pending = { fn, ms }
            return { __token: true } as any
        }) as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
        clearTimer: ((_h: ReturnType<typeof setTimeout>) => {
            pending = null
        }) as (h: ReturnType<typeof setTimeout>) => void,
        flush () {
            const p = pending
            pending = null
            p?.fn()
        },
        hasPending () { return pending !== null },
        pendingMs () { return pending?.ms ?? null },
    }
}

const ESC = new Uint8Array([0x1b])
const CSI_A = new Uint8Array([0x1b, 0x5b, 0x41])                  // ↑ as one chunk (typical paste)
const ALT_X = new Uint8Array([0x1b, 0x78])                        // Alt+X as one chunk
const PLAIN_TEXT = new Uint8Array([0x68, 0x69])                   // "hi"
const TAIL_AFTER_ESC = new Uint8Array([0x5b, 0x41])               // "[A" — arrow tail when ESC arrived alone

describe('feedEscSniffer', () => {
    it('fires after bare ESC + timeout', () => {
        const state: EscSnifferState = { timer: null }
        const clock = makeClock()
        let fired = 0
        feedEscSniffer(state, ESC, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        expect(clock.hasPending()).toBe(true)
        expect(clock.pendingMs()).toBe(ESC_TIMEOUT_MS)
        expect(fired).toBe(0)
        clock.flush()
        expect(fired).toBe(1)
    })

    it('does NOT fire when a paste delivers ESC + CSI as one chunk (arrow key shape)', () => {
        const state: EscSnifferState = { timer: null }
        const clock = makeClock()
        let fired = 0
        feedEscSniffer(state, CSI_A, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        expect(clock.hasPending()).toBe(false)
        clock.flush() // no-op
        expect(fired).toBe(0)
    })

    it('does NOT fire when a paste delivers ESC + letter as one chunk (Alt+X shape)', () => {
        const state: EscSnifferState = { timer: null }
        const clock = makeClock()
        let fired = 0
        feedEscSniffer(state, ALT_X, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        expect(clock.hasPending()).toBe(false)
        expect(fired).toBe(0)
    })

    it('cancels pending fire when CSI tail arrives within the window', () => {
        const state: EscSnifferState = { timer: null }
        const clock = makeClock()
        let fired = 0
        feedEscSniffer(state, ESC, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        expect(clock.hasPending()).toBe(true)
        // Tail of the arrow-key sequence arrives — split into a second chunk
        // (xterm.js often emits the prefix-byte separately from the rest of
        // a CSI sequence when keys are pressed in quick succession).
        feedEscSniffer(state, TAIL_AFTER_ESC, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        expect(clock.hasPending()).toBe(false)
        expect(fired).toBe(0)
    })

    it('ignores plain text', () => {
        const state: EscSnifferState = { timer: null }
        const clock = makeClock()
        let fired = 0
        feedEscSniffer(state, PLAIN_TEXT, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        expect(clock.hasPending()).toBe(false)
        expect(fired).toBe(0)
    })

    it('handles two bare ESCs back-to-back as two fires when each times out', () => {
        const state: EscSnifferState = { timer: null }
        const clock = makeClock()
        let fired = 0
        // First ESC — fire it
        feedEscSniffer(state, ESC, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        clock.flush()
        expect(fired).toBe(1)
        // Second ESC — fire it
        feedEscSniffer(state, ESC, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        clock.flush()
        expect(fired).toBe(2)
    })

    it('rapid second ESC arrives before the first times out — first canceled, second armed', () => {
        const state: EscSnifferState = { timer: null }
        const clock = makeClock()
        let fired = 0
        feedEscSniffer(state, ESC, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        feedEscSniffer(state, ESC, () => { fired++ }, ESC_TIMEOUT_MS, clock.setTimer, clock.clearTimer)
        // Only one timer should be pending — the second one. We don't
        // care which "logical" ESC it represents, only that exactly one
        // confirm fires when it elapses.
        expect(clock.hasPending()).toBe(true)
        clock.flush()
        expect(fired).toBe(1)
    })
})
