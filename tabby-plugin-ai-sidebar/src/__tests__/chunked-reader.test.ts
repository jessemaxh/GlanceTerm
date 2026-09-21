import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
    makeReadBudget,
    MAX_WHOLE_FILE_BYTES,
    READ_BUDGET_BYTES,
    READ_CHUNK_BYTES,
    scanFileLines,
} from '../chunked-reader'

/**
 * The shipped bug these cover: both usage readers pulled the whole unread range
 * into one buffer and called `toString()`. V8 caps a string at ~512 MB, so on a
 * real 830 MB Claude transcript that threw `Cannot create a string longer than
 * 0x1fffffe8 characters`, the throw was swallowed as "unreadable file", and the
 * session's tokens vanished permanently — the next attempt restarts at offset 0
 * and fails on the same allocation.
 */
describe('chunked-reader constants', () => {
    // The boundary tests below all inject a tiny chunk size, so none of them
    // would notice READ_CHUNK_BYTES being raised back above V8's limit — which
    // is exactly the shipped bug. Assert the production value directly; a
    // fixture large enough to catch it would have to be 512 MB.
    it('keeps a slice well under V8 max string length', () => {
        expect(READ_CHUNK_BYTES).toBeLessThan(0x1fffffe8)
        expect(READ_CHUNK_BYTES).toBeGreaterThan(0)
    })

    it('lets a poll cover several whole chunks', () => {
        expect(READ_BUDGET_BYTES).toBeGreaterThan(READ_CHUNK_BYTES)
        // A budget that is not a whole number of chunks would end every poll on
        // a short read, which the scanner treats as "unfinished line, stop".
        expect(READ_BUDGET_BYTES % READ_CHUNK_BYTES).toBe(0)
    })

    it('keeps the whole-file ceiling under V8 max string length', () => {
        expect(MAX_WHOLE_FILE_BYTES).toBeLessThan(0x1fffffe8)
    })
})

describe('scanFileLines', () => {
    let tmp = ''
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-chunk-')) })
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ } })

    const write = (name: string, body: string | Buffer): string => {
        const p = path.join(tmp, name)
        fs.writeFileSync(p, body)
        return p
    }
    const run = async (file: string, chunk: number, offset = 0, budgetBytes?: number) => {
        const seen: string[] = []
        const size = fs.statSync(file).size
        const budget = makeReadBudget(budgetBytes ?? READ_BUDGET_BYTES)
        const next = await scanFileLines(file, offset, size, t => seen.push(t), budget, chunk)
        return { next, size, budget, lines: seen.join('\n').split('\n').filter(Boolean) }
    }

    it('reads every line when the file spans many chunks', async () => {
        const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`)
        const f = write('many.jsonl', lines.join('\n') + '\n')
        const { next, size, lines: got } = await run(f, 24)
        expect(got).toEqual(lines)
        expect(next).toBe(size)
    })

    it('never splits a line across two slices', async () => {
        const f = write('split.jsonl', 'aaaa\nbbbb\ncccc\n')
        const { lines } = await run(f, 7)
        expect(lines).toEqual(['aaaa', 'bbbb', 'cccc'])
    })

    it('leaves a trailing partial line for the next read', async () => {
        const f = write('partial.jsonl', 'aaaa\nbbbb\ncc')
        const { next, lines } = await run(f, 1024)
        expect(lines).toEqual(['aaaa', 'bbbb'])
        expect(next).toBe('aaaa\nbbbb\n'.length)
    })

    it('resumes from a given offset without re-emitting earlier lines', async () => {
        const f = write('resume.jsonl', 'aaaa\nbbbb\ncccc\n')
        const { lines } = await run(f, 8, 'aaaa\n'.length)
        expect(lines).toEqual(['bbbb', 'cccc'])
    })

    it('does not stall on a line longer than one chunk', async () => {
        const f = write('huge.jsonl', 'a'.repeat(300) + '\nkeep-me\n')
        const { next, size, lines } = await run(f, 32)
        expect(next).toBe(size)
        expect(lines).toContain('keep-me')
    })

    it('returns the starting offset for a file it cannot open', async () => {
        // Non-zero start, so this cannot pass by coincidence with `return 0`.
        expect(await scanFileLines(path.join(tmp, 'nope.jsonl'), 7, 99, () => { /* */ })).toBe(7)
    })

    // ── multi-byte content ───────────────────────────────────────────────────
    // Every earlier fixture was ASCII, which is why re-encoding a decoded string
    // to advance the offset looked correct: U+FFFD from a split character is
    // 3 bytes wide, so the count overshoots only on non-ASCII input.

    it('counts bytes exactly for multi-byte content at every chunk size', async () => {
        const body = '日本語テキスト\n漢字かな\nEND\n'
        const f = write('cjk.jsonl', body)
        const size = Buffer.byteLength(body, 'utf8')
        // Longest line, newline included. Below this a line is legitimately
        // skipped as oversized; at or above it nothing may be lost.
        const longest = Buffer.byteLength('日本語テキスト\n', 'utf8')
        for (let chunk = 4; chunk <= size + 4; chunk++) {
            const { next, lines } = await run(f, chunk)
            // The property that matters at EVERY chunk size: the offset is
            // byte-exact and can never run past the end of the file.
            expect(next).toBeLessThanOrEqual(size)
            if (chunk >= longest) {
                expect(next).toBe(size)
                expect(lines).toEqual(['日本語テキスト', '漢字かな', 'END'])
            }
        }
    })

    it('never advances past EOF when an oversized line is multi-byte', async () => {
        // The skip branch advances by raw bytes and can land mid-character; the
        // next slice then opens with orphan continuation bytes. Re-encoding the
        // decoded text reported more bytes than were read, pushing the offset
        // past EOF — which callers read as "file truncated" and answer by
        // zeroing the session's totals, on every poll, forever.
        const body = '中'.repeat(100) + '\nkeep-1\nkeep-2\n'
        const f = write('cjk-huge.jsonl', body)
        const size = Buffer.byteLength(body, 'utf8')
        for (let chunk = 8; chunk <= 80; chunk++) {
            const { next } = await run(f, chunk)
            expect(next).toBeLessThanOrEqual(size)
        }
    })

    it('keeps records that follow an oversized multi-byte line', async () => {
        const body = '中'.repeat(100) + '\nkeep-1\nkeep-2\n'
        const f = write('cjk-after.jsonl', body)
        // Chunk comfortably larger than the following records, so only the
        // oversized line itself is lost.
        const { lines } = await run(f, 64)
        expect(lines).toContain('keep-2')
    })

    it('handles emoji (surrogate pairs) split across a boundary', async () => {
        const body = '😀😀😀\n😀x\nEND\n'
        const f = write('emoji.jsonl', body)
        const size = Buffer.byteLength(body, 'utf8')
        const longest = Buffer.byteLength('😀😀😀\n', 'utf8')
        for (let chunk = 4; chunk <= size + 2; chunk++) {
            const { next, lines } = await run(f, chunk)
            expect(next).toBeLessThanOrEqual(size)
            if (chunk >= longest) {
                expect(next).toBe(size)
                expect(lines).toEqual(['😀😀😀', '😀x', 'END'])
            }
        }
    })

    // ── budget ───────────────────────────────────────────────────────────────

    it('stops at the budget and reports an offset short of the end', async () => {
        const f = write('budget.jsonl', Array.from({ length: 50 }, (_, i) => `l-${i}`).join('\n') + '\n')
        const { next, size, budget } = await run(f, 8, 0, 24)
        expect(next).toBeGreaterThan(0)
        expect(next).toBeLessThan(size)
        expect(budget.left).toBeLessThanOrEqual(0)
    })

    it('finishes the file across successive budgeted polls, losing nothing', async () => {
        const lines = Array.from({ length: 60 }, (_, i) => `l-${i}`)
        const f = write('polls.jsonl', lines.join('\n') + '\n')
        const size = fs.statSync(f).size
        const got: string[] = []
        let off = 0
        for (let poll = 0; poll < 40 && off < size; poll++) {
            const before = off
            off = await scanFileLines(f, off, size, t => got.push(t), makeReadBudget(16), 8)
            expect(off).toBeGreaterThan(before)   // always makes progress
        }
        expect(off).toBe(size)
        expect(got.join('\n').split('\n').filter(Boolean)).toEqual(lines)
    })

    it('never reads more than the budget, even below one chunk', async () => {
        // Without clamping the read length to the remaining allowance, each
        // file may still take a whole chunk once the budget is nearly spent —
        // so the per-poll cap silently becomes budget + chunk x files, which is
        // the unbounded behaviour this budget exists to prevent.
        const f = write('tight.jsonl', 'ab\ncd\nef\n')
        const { next } = await run(f, 8, 0, 5)
        expect(next).toBe(3)
    })

    it('shares one budget across several files', async () => {
        const a = write('a.jsonl', 'aaaa\nbbbb\n')
        const b = write('b.jsonl', 'cccc\ndddd\n')
        const budget = makeReadBudget(8)
        const seen: string[] = []
        await scanFileLines(a, 0, fs.statSync(a).size, t => seen.push(t), budget, 8)
        const afterFirst = budget.left
        await scanFileLines(b, 0, fs.statSync(b).size, t => seen.push(t), budget, 8)
        // The first file exhausted the allowance, so the second read no bytes —
        // per-file budgets are what let one poll consume 969 MB.
        expect(afterFirst).toBeLessThanOrEqual(0)
        expect(seen.join('\n')).not.toContain('cccc')
    })

    // ── short reads / recycled buffers ───────────────────────────────────────

    it('ignores bytes past the end when size overstates the file', async () => {
        // allocUnsafe returns recycled memory; anything past bytesRead is a
        // previous read's leftovers and must never be emitted or counted.
        const f = write('short.jsonl', 'aaaa\n')
        const seen: string[] = []
        const next = await scanFileLines(f, 0, 4096, t => seen.push(t), makeReadBudget(), 8)
        expect(seen.join('')).toBe('aaaa')
        expect(next).toBe(5)
    })

    it('keeps the progress made when a consumer throws mid-file', async () => {
        const f = write('throws.jsonl', 'aaaa\nbbbb\ncccc\n')
        let n = 0
        const next = await scanFileLines(f, 0, fs.statSync(f).size, () => {
            n++
            if (n === 2) {
                throw new Error('boom')
            }
        }, makeReadBudget(), 8)
        // First slice was consumed and folded in by the caller; the offset must
        // reflect that and no more, or those bytes are read twice and counted
        // twice.
        expect(next).toBe(5)
    })

    it('makes no progress on an empty range', async () => {
        const f = write('empty.jsonl', '')
        expect(await scanFileLines(f, 0, 0, () => { /* */ })).toBe(0)
    })
})
