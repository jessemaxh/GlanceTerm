import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
    UsageTrackerService,
    latestCodexTokenUsage,
    latestOpencodeTokenUsage,
    sumClaudeAssistantUsage,
    sumGeminiMessageUsage,
} from '../usage-tracker.service'

const asst = (inT: number, outT: number, cacheRead = 0, cacheCreate = 0) => JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: inT, output_tokens: outT, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate } },
})
const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })
const codexTokenCount = (inT: number, outT: number) => JSON.stringify({
    timestamp: '2026-06-12T04:47:37.468Z',
    type: 'event_msg',
    payload: {
        type: 'token_count',
        info: {
            total_token_usage: {
                input_tokens: inT,
                cached_input_tokens: 40,
                output_tokens: outT,
                reasoning_output_tokens: 7,
                total_tokens: inT + outT,
            },
            last_token_usage: {
                input_tokens: inT,
                cached_input_tokens: 40,
                output_tokens: outT,
                reasoning_output_tokens: 7,
                total_tokens: inT + outT,
            },
        },
    },
})
const geminiChat = (sessionId: string, messages: any[]) => JSON.stringify({
    sessionId,
    projectHash: 'abc123',
    messages,
})
const geminiMessage = (inT: number, outT: number, cached = 0, thoughts = 0) => ({
    type: 'assistant',
    content: 'ok',
    tokens: { input: inT, output: outT, cached, thoughts },
})
const opencodeRecord = (inT: number, outT: number) => JSON.stringify({
    tab_id: '11111111-2222-4333-8444-555555555555',
    agent: 'opencode',
    event: 'working',
    ts: 1781257658,
    tokens_in: inT,
    tokens_out: outT,
})

describe('sumClaudeAssistantUsage', () => {
    it('sums input + output across assistant records and returns the latest model', () => {
        const text = [asst(100, 50), userLine, asst(200, 75)].join('\n')
        expect(sumClaudeAssistantUsage(text)).toEqual({ inTok: 300, cacheReadTok: 0, outTok: 125, model: 'claude-opus-4-8' })
    })

    it('ignores non-assistant lines (no tokens, no model)', () => {
        expect(sumClaudeAssistantUsage([userLine, userLine].join('\n'))).toEqual({ inTok: 0, cacheReadTok: 0, outTok: 0, model: null })
    })

    it('counts cache CREATION in input but tracks cache READ separately', () => {
        // cache creation is new content the model processed → part of `inTok`
        // (100 input + 500 creation = 600). cache read is the re-read of the
        // already-cached context → its own `cacheReadTok` (9_000_000), NOT
        // folded into the input headline (where it would dwarf it 100x+).
        expect(sumClaudeAssistantUsage(asst(100, 50, 9_000_000, 500)))
            .toEqual({ inTok: 600, cacheReadTok: 9_000_000, outTok: 50, model: 'claude-opus-4-8' })
    })

    it('skips malformed lines and lines without usage', () => {
        const text = [
            '{ not json',
            JSON.stringify({ type: 'assistant', message: {} }),   // no usage
            asst(10, 20),
            '',
        ].join('\n')
        expect(sumClaudeAssistantUsage(text)).toEqual({ inTok: 10, cacheReadTok: 0, outTok: 20, model: 'claude-opus-4-8' })
    })

    it('returns zero/null for empty input', () => {
        expect(sumClaudeAssistantUsage('')).toEqual({ inTok: 0, cacheReadTok: 0, outTok: 0, model: null })
    })

    it('model is last-wins and skips the <synthetic> sentinel', () => {
        const m = (model: string) => JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: 1, output_tokens: 1 } } })
        expect(sumClaudeAssistantUsage([m('claude-opus-4-8'), m('claude-sonnet-4-6')].join('\n')).model).toBe('claude-sonnet-4-6')
        // <synthetic> never wins; alone it yields null, and it never overwrites a real model
        expect(sumClaudeAssistantUsage(m('<synthetic>')).model).toBeNull()
        expect(sumClaudeAssistantUsage([m('claude-opus-4-8'), m('<synthetic>')].join('\n')).model).toBe('claude-opus-4-8')
    })
})

describe('latestCodexTokenUsage', () => {
    it('returns the newest token_count running total', () => {
        const text = [
            JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
            codexTokenCount(100, 50),
            codexTokenCount(300, 75),
        ].join('\n')
        // in = input - cached (40); cache = cached; out = output + reasoning (7)
        expect(latestCodexTokenUsage(text)).toEqual({ inTok: 260, cacheReadTok: 40, outTok: 82 })
    })

    it('skips malformed and non-token records', () => {
        const text = [
            '{ not json',
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
        ].join('\n')
        expect(latestCodexTokenUsage(text)).toBeNull()
    })
})

describe('sumGeminiMessageUsage', () => {
    it('sums explicit Gemini input/output token fields', () => {
        const text = geminiChat('600336a0-b038-4cb7-8322-a418ebdc2ab5', [
            geminiMessage(100, 50, 40, 7),   // input INCLUDES cached(40); thoughts(7) → out
            { type: 'user', content: 'hi' },
            geminiMessage(200, 75),
        ])
        // m1: in=100-40=60 cache=40 out=50+7=57 ; m2: in=200 cache=0 out=75
        expect(sumGeminiMessageUsage(text)).toEqual({ inTok: 260, cacheReadTok: 40, outTok: 132, model: null })
    })

    it('returns zero/null for malformed or token-less saved chats', () => {
        expect(sumGeminiMessageUsage('{ not json')).toEqual({ inTok: 0, cacheReadTok: 0, outTok: 0, model: null })
        expect(sumGeminiMessageUsage(JSON.stringify({ messages: [{ type: 'user' }] }))).toEqual({ inTok: 0, cacheReadTok: 0, outTok: 0, model: null })
    })

    it('returns the newest message model (last-wins) in the same pass', () => {
        const raw = geminiChat('s', [
            { ...geminiMessage(10, 5), model: 'gemini-2.5-flash' },
            { ...geminiMessage(10, 5), model: 'gemini-2.5-pro' },
        ])
        expect(sumGeminiMessageUsage(raw).model).toBe('gemini-2.5-pro')
    })
})

describe('latestOpencodeTokenUsage', () => {
    it('returns the newest opencode running total', () => {
        const text = [
            JSON.stringify({ agent: 'opencode', event: 'working' }),
            opencodeRecord(100, 50),
            opencodeRecord(300, 75),
        ].join('\n')
        expect(latestOpencodeTokenUsage(text)).toEqual({ inTok: 300, cacheReadTok: 0, outTok: 75 })
    })

    it('skips malformed and non-opencode records', () => {
        const text = [
            '{ not json',
            JSON.stringify({ agent: 'claude', tokens_in: 100, tokens_out: 50 }),
        ].join('\n')
        expect(latestOpencodeTokenUsage(text)).toBeNull()
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

    it('returns null when there is no transcript path', async () => {
        expect(await new UsageTrackerService().compute({}, 'claude', null)).toBeNull()
    })

    it('sums the transcript on first read', async () => {
        fs.writeFileSync(tx, [asst(100, 50), userLine, asst(200, 75)].join('\n') + '\n')
        const u = await new UsageTrackerService().compute({}, 'claude', tx)
        expect(u).toEqual({ inTok: 300, cacheReadTok: 0, outTok: 125, model: 'claude-opus-4-8' })
    })

    it('accumulates incrementally as the transcript grows (byte-offset read)', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 100, cacheReadTok: 0, outTok: 50, model: 'claude-opus-4-8' })

        // Append a second turn; advance past the throttle so the next call reads.
        fs.appendFileSync(tx, asst(200, 75) + '\n')
        vi.advanceTimersByTime(7_000)   // > USAGE_READ_INTERVAL_MS (6 s)
        // Only the NEW bytes are parsed and added — not a re-sum of the whole file.
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 300, cacheReadTok: 0, outTok: 125, model: 'claude-opus-4-8' })
    })

    it('does not re-read within the throttle window (returns the cached value)', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 100, cacheReadTok: 0, outTok: 50, model: 'claude-opus-4-8' })
        // Append but do NOT advance the clock → throttled, stale value returned.
        fs.appendFileSync(tx, asst(999, 999) + '\n')
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 100, cacheReadTok: 0, outTok: 50, model: 'claude-opus-4-8' })
    })

    it('resets when the transcript path changes (new session)', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        expect(await svc.compute(key, 'claude', tx)).toEqual({ inTok: 100, cacheReadTok: 0, outTok: 50, model: 'claude-opus-4-8' })

        const tx2 = path.join(tmp, 'session2.jsonl')
        fs.writeFileSync(tx2, asst(7, 3) + '\n')
        vi.advanceTimersByTime(5_000)
        expect(await svc.compute(key, 'claude', tx2)).toEqual({ inTok: 7, cacheReadTok: 0, outTok: 3, model: 'claude-opus-4-8' })
    })

    it('keeps the model sticky when a later chunk has no assistant line', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        expect((await svc.compute(key, 'claude', tx))?.model).toBe('claude-opus-4-8')

        // Append only user lines (no model) → the chip must NOT blank.
        fs.appendFileSync(tx, userLine + '\n')
        vi.advanceTimersByTime(7_000)
        expect((await svc.compute(key, 'claude', tx))?.model).toBe('claude-opus-4-8')
    })
})

describe('UsageTrackerService.compute (Codex transcript)', () => {
    let tmp: string
    let tx: string

    beforeEach(() => {
        vi.useFakeTimers()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-usage-codex-'))
        tx = path.join(tmp, 'rollout.jsonl')
    })
    afterEach(() => {
        vi.useRealTimers()
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ }
    })

    it('returns null when there is no transcript path', async () => {
        expect(await new UsageTrackerService().compute({}, 'codex', null)).toBeNull()
    })

    it('returns null until a token_count record appears', async () => {
        fs.writeFileSync(tx, JSON.stringify({ type: 'response_item', payload: { type: 'message' } }) + '\n')
        expect(await new UsageTrackerService().compute({}, 'codex', tx)).toBeNull()
    })

    it('reads the latest token_count running total on first read', async () => {
        fs.writeFileSync(tx, [codexTokenCount(100, 50), codexTokenCount(300, 75)].join('\n') + '\n')
        const u = await new UsageTrackerService().compute({}, 'codex', tx)
        expect(u).toEqual({ inTok: 260, cacheReadTok: 40, outTok: 82 })
    })

    it('updates incrementally as the transcript grows', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, codexTokenCount(100, 50) + '\n')
        expect(await svc.compute(key, 'codex', tx)).toEqual({ inTok: 60, cacheReadTok: 40, outTok: 57 })

        fs.appendFileSync(tx, codexTokenCount(300, 75) + '\n')
        vi.advanceTimersByTime(7_000)   // > USAGE_READ_INTERVAL_MS (6 s)
        expect(await svc.compute(key, 'codex', tx)).toEqual({ inTok: 260, cacheReadTok: 40, outTok: 82 })
    })

    it('does not re-read within the throttle window (returns the cached value)', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, codexTokenCount(100, 50) + '\n')
        expect(await svc.compute(key, 'codex', tx)).toEqual({ inTok: 60, cacheReadTok: 40, outTok: 57 })

        fs.appendFileSync(tx, codexTokenCount(999, 999) + '\n')
        expect(await svc.compute(key, 'codex', tx)).toEqual({ inTok: 60, cacheReadTok: 40, outTok: 57 })
    })

    // No Codex transcript-model test: Codex gets its model from hooks (snap.model)
    // on every event, so UsageTracker reads no model for it — see computeCodex.
})

describe('UsageTrackerService.compute (Gemini saved chat)', () => {
    let oldHome: string | undefined
    let oldUserProfile: string | undefined
    let tmp: string
    let tx: string
    const sessionId = '600336a0-b038-4cb7-8322-a418ebdc2ab5'

    beforeEach(() => {
        vi.useFakeTimers()
        oldHome = process.env.HOME
        oldUserProfile = process.env.USERPROFILE
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-usage-gemini-'))
        process.env.HOME = tmp
        process.env.USERPROFILE = tmp
        tx = path.join(tmp, '.gemini', 'tmp', 'projecthash', 'chats', 'session-2026-06-12T13-00-600336a0.json')
        fs.mkdirSync(path.dirname(tx), { recursive: true })
    })
    afterEach(() => {
        process.env.HOME = oldHome
        process.env.USERPROFILE = oldUserProfile
        vi.useRealTimers()
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ }
    })

    it('locates the saved chat by session id and sums message tokens', async () => {
        fs.writeFileSync(tx, geminiChat(sessionId, [geminiMessage(100, 50), geminiMessage(200, 75)]))
        const u = await new UsageTrackerService().compute({}, 'gemini', { sessionId })
        expect(u).toEqual({ inTok: 300, cacheReadTok: 0, outTok: 125, model: null })
    })

    it('returns cached Gemini usage inside the throttle window', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, geminiChat(sessionId, [geminiMessage(100, 50)]))
        expect(await svc.compute(key, 'gemini', { sessionId })).toEqual({ inTok: 100, cacheReadTok: 0, outTok: 50, model: null })

        fs.writeFileSync(tx, geminiChat(sessionId, [geminiMessage(999, 999)]))
        expect(await svc.compute(key, 'gemini', { sessionId })).toEqual({ inTok: 100, cacheReadTok: 0, outTok: 50, model: null })
    })

    it('surfaces the model from a message.model (hooks never carry it)', async () => {
        fs.writeFileSync(tx, geminiChat(sessionId, [{ ...geminiMessage(100, 50), model: 'gemini-2.5-pro' }]))
        const u = await new UsageTrackerService().compute({}, 'gemini', { sessionId })
        expect(u).toEqual({ inTok: 100, cacheReadTok: 0, outTok: 50, model: 'gemini-2.5-pro' })
    })

    it('returns the model even when no tokens were seen (does not drop it on !seen)', async () => {
        // A model-bearing message with no `tokens` block — the chat is Gemini's
        // ONLY model source, so a zero-token chat must still surface the chip.
        fs.writeFileSync(tx, geminiChat(sessionId, [{ type: 'assistant', content: 'ok', model: 'gemini-2.5-pro' }]))
        const u = await new UsageTrackerService().compute({}, 'gemini', { sessionId })
        expect(u).toEqual({ inTok: 0, cacheReadTok: 0, outTok: 0, model: 'gemini-2.5-pro' })
    })
})

describe('UsageTrackerService.compute (opencode hook log)', () => {
    let oldHome: string | undefined
    let oldUserProfile: string | undefined
    let tmp: string
    let log: string
    const tabId = '11111111-2222-4333-8444-555555555555'

    beforeEach(() => {
        vi.useFakeTimers()
        oldHome = process.env.HOME
        oldUserProfile = process.env.USERPROFILE
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-usage-opencode-'))
        process.env.HOME = tmp
        process.env.USERPROFILE = tmp
        log = path.join(tmp, '.glanceterm', 'hooks', `${tabId}.log`)
        fs.mkdirSync(path.dirname(log), { recursive: true })
    })
    afterEach(() => {
        process.env.HOME = oldHome
        process.env.USERPROFILE = oldUserProfile
        vi.useRealTimers()
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ }
    })

    it('reads the latest opencode token total from the hook log', async () => {
        fs.writeFileSync(log, [opencodeRecord(100, 50), opencodeRecord(300, 75)].join('\n') + '\n')
        const u = await new UsageTrackerService().compute({}, 'opencode', { tabId })
        expect(u).toEqual({ inTok: 300, cacheReadTok: 0, outTok: 75 })
    })

    it('updates incrementally as the hook log grows', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(log, opencodeRecord(100, 50) + '\n')
        expect(await svc.compute(key, 'opencode', { tabId })).toEqual({ inTok: 100, cacheReadTok: 0, outTok: 50 })

        fs.appendFileSync(log, opencodeRecord(300, 75) + '\n')
        vi.advanceTimersByTime(7_000)   // > USAGE_READ_INTERVAL_MS (6 s)
        expect(await svc.compute(key, 'opencode', { tabId })).toEqual({ inTok: 300, cacheReadTok: 0, outTok: 75 })
    })
})

/**
 * Chunked reading.
 *
 * A transcript is read into a JS string to be parsed, and V8 caps a string at
 * ~512 MB. Reading a whole file at once therefore THREW on a real 830 MB Claude
 * transcript (`Cannot create a string longer than 0x1fffffe8 characters`), the
 * throw was swallowed by the reader's catch, and that tab's token figures
 * silently vanished for good — a restart re-read from offset 0 and failed on
 * the same line again. These cover the slicing that replaced it.
 *
 * `scanLines` takes an injectable chunk size so the boundary cases can be
 * exercised with byte-sized fixtures instead of a 32 MB one.
 */
describe('UsageTrackerService.scanLines', () => {
    let tmp = ''
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-usage-chunk-')) })
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ } })

    const write = (name: string, body: string): string => {
        const p = path.join(tmp, name)
        fs.writeFileSync(p, body)
        return p
    }
    /** Collect every complete line the scanner emits, across all slices. */
    const run = async (file: string, chunk: number, offset = 0) => {
        const svc = new UsageTrackerService()
        const seen: string[] = []
        const size = fs.statSync(file).size
        const next = await svc.scanLines(file, offset, size, t => seen.push(t), chunk)
        return { next, lines: seen.join('\n').split('\n').filter(Boolean) }
    }

    it('reads every line when the file spans many chunks', async () => {
        const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`)
        const f = write('many.jsonl', lines.join('\n') + '\n')
        // 24 bytes forces a boundary mid-line over and over.
        const { next, lines: got } = await run(f, 24)
        expect(got).toEqual(lines)
        expect(next).toBe(fs.statSync(f).size)
    })

    it('never splits a line across two slices', async () => {
        const f = write('split.jsonl', 'aaaa\nbbbb\ncccc\n')
        // 7 bytes lands inside "bbbb" on the second read.
        const { lines } = await run(f, 7)
        expect(lines).toEqual(['aaaa', 'bbbb', 'cccc'])
    })

    it('leaves a trailing partial line for the next read', async () => {
        const f = write('partial.jsonl', 'aaaa\nbbbb\ncc')
        const { next, lines } = await run(f, 1024)
        expect(lines).toEqual(['aaaa', 'bbbb'])
        // Offset stops after the last newline, not at EOF, so the unfinished
        // record is re-read once it is complete.
        expect(next).toBe('aaaa\nbbbb\n'.length)
    })

    it('resumes from a given offset without re-emitting earlier lines', async () => {
        const f = write('resume.jsonl', 'aaaa\nbbbb\ncccc\n')
        const { lines } = await run(f, 8, 'aaaa\n'.length)
        expect(lines).toEqual(['bbbb', 'cccc'])
    })

    it('does not stall on a line longer than one chunk', async () => {
        // The huge line cannot be assembled, but the scan must still finish and
        // the following records must survive.
        const f = write('huge.jsonl', 'a'.repeat(300) + '\nkeep-me\n')
        const { next, lines } = await run(f, 32)
        expect(next).toBe(fs.statSync(f).size)
        expect(lines).toContain('keep-me')
    })

    it('returns the starting offset for a file it cannot open', async () => {
        const svc = new UsageTrackerService()
        expect(await svc.scanLines(path.join(tmp, 'nope.jsonl'), 0, 10, () => { /* */ })).toBe(0)
    })

    it('sums a Claude transcript identically whether chunked or not', async () => {
        const body = Array.from({ length: 40 }, () => asst(10, 3, 5, 2)).join('\n') + '\n'
        const f = write('claude.jsonl', body)
        const whole = sumClaudeAssistantUsage(body)
        // Bigger than one record, far smaller than the file → real boundaries.
        const { lines } = await run(f, 300)
        const chunked = sumClaudeAssistantUsage(lines.join('\n'))
        expect(chunked).toEqual(whole)
        expect(chunked.inTok).toBe(40 * 12)
    })
})
