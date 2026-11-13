import { describe, expect, it } from 'vitest'

import { resolveForeground } from '../tab-monitor'

// Shell 66393 on a tab whose pty proxy was re-created by a window reload while
// claude 20166 was running: truePID latched onto 20166. The user then quit it
// and started claude 45221 (the 2026-11-13 report).
const SHELL = 66393
const snap = (entries: Array<[number, number]>) => ({ pidParent: new Map(entries) })

describe('resolveForeground', () => {
    it('keeps a live truePID', () => {
        const s = snap([[SHELL, 1], [20166, SHELL]])
        expect(resolveForeground(20166, SHELL, s)).toEqual({ pid: 20166, childPids: null })
    })

    it('falls back to the shell and its live children when truePID has died', () => {
        const s = snap([[SHELL, 1], [45221, SHELL], [45300, 45221], [999, 2]])
        expect(resolveForeground(20166, SHELL, s)).toEqual({ pid: SHELL, childPids: [45221] })
    })

    it('returns no children for a dead truePID over an idle shell', () => {
        const s = snap([[SHELL, 1]])
        expect(resolveForeground(20166, SHELL, s)).toEqual({ pid: SHELL, childPids: [] })
    })

    it('does not fall back when the snapshot is empty (cannot tell what died)', () => {
        expect(resolveForeground(20166, SHELL, snap([]))).toEqual({ pid: 20166, childPids: null })
    })

    it('does not fall back when the shell is gone too, or unknown', () => {
        const s = snap([[45221, 7]])
        expect(resolveForeground(20166, SHELL, s)).toEqual({ pid: 20166, childPids: null })
        expect(resolveForeground(20166, null, s)).toEqual({ pid: 20166, childPids: null })
    })
})
