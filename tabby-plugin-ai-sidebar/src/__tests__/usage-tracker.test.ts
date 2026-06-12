import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { UsageTrackerService, sumClaudeAssistantUsage } from '../usage-tracker.service'

const asst = (inT: number, outT: number, cacheRead = 0, cacheCreate = 0) => JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: inT, output_tokens: outT, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate } },
})
const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })

describe('sumClaudeAssistantUsage', () => {
    it('sums input + output across assistant records', () => {
        const text = [asst(100, 50), userLine, asst(200, 75)].join('\n')
        expect(sumClaudeAssistantUsage(text)).toEqual({ inTok: 300, outTok: 125 })
    })

    it('ignores non-assistant lines', () => {
        expect(sumClaudeAssistantUsage([userLine, userLine].join('\n'))).toEqual({ inTok: 0, outTok: 0 })
    })

    it('INCLUDES cache read/creation in the input total', () => {
        // cache-read + cache-creation are the bulk of a Claude turn's input
        // (the whole context is re-read from cache each turn), so they MUST be
        // counted: 100 input + 9_000_000 cache-read + 500 cache-creation.
        expect(sumClaudeAssistantUsage(asst(100, 50, 9_000_000, 500))).toEqual({ inTok: 9_000_600, outTok: 50 })
    })

    it('skips malformed lines and lines without usage', () => {
        const text = [
            '{ not json',
            JSON.stringify({ type: 'assistant', message: {} }),   // no usage
            asst(10, 20),
            '',
        ].join('\n')
        expect(sumClaudeAssistantUsage(text)).toEqual({ inTok: 10, outTok: 20 })
    })

    it('returns zero for empty input', () => {
        expect(sumClaudeAssistantUsage('')).toEqual({ inTok: 0, outTok: 0 })
    })
})

describe('UsageTrackerService.compute (Claude transcript)', () => {
    let tmp: string
    let tx: string

    beforeEach(() => {
        vi.useFakeTimers()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-usage-'))
        tx = path.join(tmp, 'session.jsonl')
    })
    afterEach(() => {
        vi.useRealTimers()
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ }
    })

    it('returns null for a non-Claude tool', async () => {
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        expect(await new UsageTrackerService().compute({}, 'codex', tx)).toBeNull()
    })

    it('returns null when there is no transcript path', async () => {
        expect(await new UsageTrackerService().compute({}, 'claude', null)).toBeNull()
    })

    it('sums the transcript on first read', async () => {
        fs.writeFileSync(tx, [asst(100, 50), userLine, asst(200, 75)].join('\n') + '\n')
        const u = await new UsageTrackerService().compute({}, 'claude', tx)
        expect(u).toEqual({ inTok: 300, outTok: 125 })
    })

    it('accumulates incrementally as the transcript grows (byte-offset read)', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 100, outTok: 50 })

        // Append a second turn; advance past the throttle so the next call reads.
        fs.appendFileSync(tx, asst(200, 75) + '\n')
        vi.advanceTimersByTime(5_000)
        // Only the NEW bytes are parsed and added — not a re-sum of the whole file.
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 300, outTok: 125 })
    })

    it('does not re-read within the throttle window (returns the cached value)', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 100, outTok: 50 })
        // Append but do NOT advance the clock → throttled, stale value returned.
        fs.appendFileSync(tx, asst(999, 999) + '\n')
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 100, outTok: 50 })
    })

    it('resets when the transcript path changes (new session)', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 100, outTok: 50 })

        const tx2 = path.join(tmp, 'session2.jsonl')
        fs.writeFileSync(tx2, asst(7, 3) + '\n')
        vi.advanceTimersByTime(5_000)
        expect(await svc.compute(key, 'claude', tx2)).toEqual({ inTok: 7, outTok: 3 })
    })
})
