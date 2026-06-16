import { describe, it, expect } from 'vitest'
import {
    dayKey, mergePerDay, totalsInWindow, addTotals, groupBy, grandTotal,
    parseClaudeChunk, parseCodexChunk, parseGeminiFull, parseOpencodeChunk,
    type SessionStat, type PerDay,
} from '../token-stats.service'

// Local-noon ISO so the bucketed LOCAL day is deterministic regardless of the
// runner's timezone (noon ± any UTC offset stays on the same local calendar day
// when read back locally).
const iso = (y: number, mo1: number, d: number, h = 12): string => new Date(y, mo1 - 1, d, h, 0, 0).toISOString()
const day = (y: number, mo1: number, d: number): string => dayKey(new Date(y, mo1 - 1, d, 12, 0, 0).getTime())

describe('dayKey', () => {
    it('formats a valid epoch as local YYYY-MM-DD', () => {
        expect(dayKey(new Date(2026, 5, 16, 12).getTime())).toBe('2026-06-16')
    })
    it('returns "" for missing/invalid timestamps', () => {
        expect(dayKey(NaN)).toBe('')
        expect(dayKey(0)).toBe('')
        expect(dayKey(-1)).toBe('')
    })
})

describe('parseClaudeChunk', () => {
    it('buckets per-turn usage by day; in = input + cache_creation, cache = cache_read, out = output', () => {
        const lines = [
            JSON.stringify({ type: 'assistant', timestamp: iso(2026, 6, 16), sessionId: 's1', cwd: '/w/proj', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 40 } } }),
            JSON.stringify({ type: 'assistant', timestamp: iso(2026, 6, 16), message: { usage: { input_tokens: 2, cache_read_input_tokens: 2000, output_tokens: 8 } } }),
            JSON.stringify({ type: 'user', timestamp: iso(2026, 6, 16), message: {} }),         // skipped
            'not json',                                                                          // skipped
        ].join('\n')
        const r = parseClaudeChunk(lines)
        expect(r.project).toBe('/w/proj')
        expect(r.sessionId).toBe('s1')
        expect(r.turns).toBe(2)
        expect(r.perDay[day(2026, 6, 16)]).toEqual({ inTok: 17, cacheTok: 3000, outTok: 48 })
    })
    it('splits across days', () => {
        const r = parseClaudeChunk([
            JSON.stringify({ type: 'assistant', timestamp: iso(2026, 6, 16), message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
            JSON.stringify({ type: 'assistant', timestamp: iso(2026, 6, 17), message: { usage: { input_tokens: 2, output_tokens: 3 } } }),
        ].join('\n'))
        expect(r.perDay[day(2026, 6, 16)]).toEqual({ inTok: 1, cacheTok: 0, outTok: 1 })
        expect(r.perDay[day(2026, 6, 17)]).toEqual({ inTok: 2, cacheTok: 0, outTok: 3 })
    })
})

describe('parseCodexChunk (running totals → daily deltas)', () => {
    it('attributes the delta vs the previous cumulative to each record day', () => {
        const lines = [
            JSON.stringify({ type: 'event_msg', timestamp: iso(2026, 6, 16), payload: { type: 'token_count', cwd: '/w/cdx', id: 'cx1', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 0 } } } }),
            JSON.stringify({ type: 'event_msg', timestamp: iso(2026, 6, 16), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 900, output_tokens: 250, reasoning_output_tokens: 50 } } } }),
        ].join('\n')
        const r = parseCodexChunk(lines, { inTok: 0, cacheTok: 0, outTok: 0 })
        // rec1: in=1000-600=400, cache=600, out=100 ; rec2: cumIn=600 cumCache=900 cumOut=300 → delta in=200 cache=300 out=200
        expect(r.perDay[day(2026, 6, 16)]).toEqual({ inTok: 600, cacheTok: 900, outTok: 300 })
        expect(r.cumul).toEqual({ inTok: 600, cacheTok: 900, outTok: 300 })
        expect(r.project).toBe('/w/cdx')
        expect(r.sessionId).toBe('cx1')
    })
    it('continues from a prior cumulative (incremental read)', () => {
        const r = parseCodexChunk(
            JSON.stringify({ type: 'event_msg', timestamp: iso(2026, 6, 16), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 400 } } } }),
            { inTok: 600, cacheTok: 900, outTok: 300 },
        )
        // cumIn=1000 cumCache=1000 cumOut=400 → delta in=400 cache=100 out=100
        expect(r.perDay[day(2026, 6, 16)]).toEqual({ inTok: 400, cacheTok: 100, outTok: 100 })
    })
})

describe('parseGeminiFull', () => {
    it('sums message tokens by day and reads projectHash/sessionId', () => {
        const text = JSON.stringify({
            sessionId: 'g1', projectHash: 'abc123',
            messages: [
                { timestamp: iso(2026, 6, 16), tokens: { input: 100, output: 20, cached: 50 } },
                { timestamp: iso(2026, 6, 16), tokens: { input: 10, output: 5, cached: 5 } },
                { timestamp: iso(2026, 6, 16) },   // no tokens → skipped
            ],
        })
        const r = parseGeminiFull(text)
        expect(r.project).toBe('abc123')
        expect(r.sessionId).toBe('g1')
        expect(r.turns).toBe(2)
        expect(r.perDay[day(2026, 6, 16)]).toEqual({ inTok: 110, cacheTok: 55, outTok: 25 })
    })
    it('returns empty on malformed JSON', () => {
        expect(parseGeminiFull('{oops').turns).toBe(0)
    })
})

describe('parseOpencodeChunk (running totals, in/out only)', () => {
    it('attributes deltas and ignores non-opencode lines', () => {
        const lines = [
            JSON.stringify({ agent: 'opencode', ts: iso(2026, 6, 16), tokens_in: 500, tokens_out: 100 }),
            JSON.stringify({ agent: 'claude', ts: iso(2026, 6, 16), tokens_in: 9, tokens_out: 9 }), // ignored
            JSON.stringify({ agent: 'opencode', ts: iso(2026, 6, 16), tokens_in: 800, tokens_out: 250 }),
        ].join('\n')
        const r = parseOpencodeChunk(lines, { inTok: 0, cacheTok: 0, outTok: 0 })
        expect(r.perDay[day(2026, 6, 16)]).toEqual({ inTok: 800, cacheTok: 0, outTok: 250 })
        expect(r.cumul.inTok).toBe(800)
    })
})

describe('windowing + rollups', () => {
    const perDay: PerDay = {
        '2026-06-14': { inTok: 1, cacheTok: 10, outTok: 100 },
        '2026-06-16': { inTok: 2, cacheTok: 20, outTok: 200 },
        '': { inTok: 5, cacheTok: 50, outTok: 500 },   // undated
    }
    it('totalsInWindow: open window includes undated; dated window excludes it', () => {
        expect(totalsInWindow(perDay)).toEqual({ inTok: 8, cacheTok: 80, outTok: 800 })
        expect(totalsInWindow(perDay, '2026-06-15', '2026-06-17')).toEqual({ inTok: 2, cacheTok: 20, outTok: 200 })
        expect(totalsInWindow(perDay, '2026-06-14', '2026-06-14')).toEqual({ inTok: 1, cacheTok: 10, outTok: 100 })
    })
    it('mergePerDay accumulates', () => {
        const dst: PerDay = { '2026-06-16': { inTok: 1, cacheTok: 1, outTok: 1 } }
        mergePerDay(dst, { '2026-06-16': { inTok: 2, cacheTok: 2, outTok: 2 }, '2026-06-17': { inTok: 3, cacheTok: 3, outTok: 3 } })
        expect(dst['2026-06-16']).toEqual({ inTok: 3, cacheTok: 3, outTok: 3 })
        expect(dst['2026-06-17']).toEqual({ inTok: 3, cacheTok: 3, outTok: 3 })
    })
    it('addTotals sums', () => {
        expect(addTotals({ inTok: 1, cacheTok: 2, outTok: 3 }, { inTok: 4, cacheTok: 5, outTok: 6 })).toEqual({ inTok: 5, cacheTok: 7, outTok: 9 })
    })

    const sessions: SessionStat[] = [
        { agent: 'claude', sessionId: 'a', project: '/w/p1', turns: 3, lastActive: 200, perDay: { '2026-06-16': { inTok: 10, cacheTok: 0, outTok: 100 } } },
        { agent: 'claude', sessionId: 'b', project: '/w/p1', turns: 2, lastActive: 300, perDay: { '2026-06-16': { inTok: 5, cacheTok: 0, outTok: 50 } } },
        { agent: 'codex', sessionId: 'c', project: '/w/p2', turns: 1, lastActive: 100, perDay: { '2026-06-15': { inTok: 7, cacheTok: 0, outTok: 70 } } },
    ]
    it('groupBy agent / project', () => {
        const byAgent = groupBy(sessions, 'agent')
        expect(byAgent.find(r => r.key === 'claude')!.totals).toEqual({ inTok: 15, cacheTok: 0, outTok: 150 })
        expect(byAgent.find(r => r.key === 'claude')!.sessions).toBe(2)
        const byProj = groupBy(sessions, 'project')
        expect(byProj.find(r => r.key === '/w/p1')!.totals.outTok).toBe(150)
        // sorted by outTok desc → p1 (150) before p2 (70)
        expect(byProj[0].key).toBe('/w/p1')
    })
    it('groupBy honours the window (excludes out-of-range sessions)', () => {
        const onlyJun16 = groupBy(sessions, 'project', '2026-06-16', '2026-06-16')
        expect(onlyJun16.map(r => r.key)).toEqual(['/w/p1'])   // p2 (06-15) filtered out
    })
    it('grandTotal sums everything', () => {
        expect(grandTotal(sessions)).toEqual({ inTok: 22, cacheTok: 0, outTok: 220 })
    })
})
