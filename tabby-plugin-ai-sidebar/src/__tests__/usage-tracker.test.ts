import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { READ_CHUNK_BYTES } from '../chunked-reader'
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
 * Coverage for the PRODUCTION chunking path.
 *
 * The boundary tests in chunked-reader.test.ts all inject a tiny chunk size, so
 * none of them exercises `READ_CHUNK_BYTES` itself, and every other fixture in
 * this file is a few hundred bytes — far under one slice. These use fixtures
 * that genuinely span several production-sized chunks, so the cross-slice
 * accumulator, the model carry-over and the Codex "last slice wins" rule are
 * actually executed rather than merely described in a comment.
 */
describe('usage across production-sized chunks', () => {
    let tmp = ''
    beforeEach(() => {
        vi.useFakeTimers()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-usage-big-'))
    })
    afterEach(() => {
        vi.useRealTimers()
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ }
    })

    /** Filler that parses but carries no usage, sized to push past one chunk. */
    const filler = (bytes: number): string => {
        const one = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(512) } }) + '\n'
        return one.repeat(Math.ceil(bytes / one.length))
    }
    const MULTI_CHUNK = READ_CHUNK_BYTES * 2 + 1024

    it('sums Claude records that land in different chunks', async () => {
        const tx = path.join(tmp, 'big.jsonl')
        // One record at each end, so a per-slice result that overwrites instead
        // of accumulating loses one of them.
        fs.writeFileSync(tx, asst(100, 50) + '\n' + filler(MULTI_CHUNK) + asst(200, 75) + '\n')
        const u = await new UsageTrackerService().compute({}, 'claude', tx)
        expect(u).toEqual({ inTok: 300, cacheReadTok: 0, outTok: 125, model: 'claude-opus-4-8' })
    })

    it('carries the Claude model across chunks that contain no assistant record', async () => {
        const tx = path.join(tmp, 'model.jsonl')
        // Model appears only in the FIRST slice; later slices must not blank it.
        fs.writeFileSync(tx, asst(10, 5) + '\n' + filler(MULTI_CHUNK))
        const u = await new UsageTrackerService().compute({}, 'claude', tx)
        expect(u?.model).toBe('claude-opus-4-8')
        expect(u?.inTok).toBe(10)
    })

    it('keeps the newest Codex total when it is not in the last chunk', async () => {
        const rollout = path.join(tmp, 'rollout.jsonl')
        // "Last slice wins" must not mean "last slice with no record wins null".
        fs.writeFileSync(rollout, codexTokenCount(100, 50) + '\n' + filler(MULTI_CHUNK))
        const u = await new UsageTrackerService().compute({}, 'codex', rollout)
        // Same transformation the single-read tests assert: input less the
        // cached portion, output plus reasoning.
        expect(u).toEqual({ inTok: 60, cacheReadTok: 40, outTok: 57 })
    })
})

/**
 * Subagent fold-in. Claude writes each subagent's turns to its own file under
 * `<session>/subagents/`, and those totals are a majority of a real session's
 * usage — yet nothing in the repo exercised this path, so deleting the whole
 * loop, or never advancing its per-file offsets (double-counting every poll),
 * both passed the suite.
 */
describe('compute (Claude) — subagent transcripts', () => {
    let tmp = ''
    let tx = ''
    let subDir = ''
    beforeEach(() => {
        vi.useFakeTimers()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-usage-sub-'))
        tx = path.join(tmp, 'session.jsonl')
        subDir = path.join(tmp, 'session', 'subagents')
        fs.mkdirSync(subDir, { recursive: true })
    })
    afterEach(() => {
        vi.useRealTimers()
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* */ }
    })

    it('folds subagent usage into the session total', async () => {
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), asst(30, 10) + '\n')
        const u = await new UsageTrackerService().compute({}, 'claude', tx)
        expect(u?.inTok).toBe(130)
        expect(u?.outTok).toBe(60)
    })

    it('does not re-count a subagent file that has not grown', async () => {
        const svc = new UsageTrackerService()
        const key = {}
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), asst(30, 10) + '\n')
        expect((await svc.compute(key, 'claude', tx))?.inTok).toBe(130)

        vi.advanceTimersByTime(7_000)
        expect((await svc.compute(key, 'claude', tx))?.inTok).toBe(130)

        // A genuine append is counted once, not from the top.
        fs.appendFileSync(path.join(subDir, 'agent-1.jsonl'), asst(5, 1) + '\n')
        vi.advanceTimersByTime(7_000)
        expect((await svc.compute(key, 'claude', tx))?.inTok).toBe(135)
    })

    it('ignores files in the subagents dir that are not agent transcripts', async () => {
        fs.writeFileSync(tx, asst(100, 50) + '\n')
        fs.writeFileSync(path.join(subDir, 'notes.txt'), asst(999, 999) + '\n')
        const u = await new UsageTrackerService().compute({}, 'claude', tx)
        expect(u?.inTok).toBe(100)
    })
})

describe('latestOpencodeTokenUsage — carry across slices', () => {
    const rec = (o: Record<string, unknown>) => JSON.stringify({ agent: 'opencode', ...o })

    it('fills a field omitted by a later record from an earlier SLICE', () => {
        // opencode emits `tokens_cache` only when non-zero, and the missing
        // field is filled from the previous record. Split across slices that
        // carry-over used to reset, so a chunked read reported cache 0 where a
        // single read reported the real figure.
        const first = latestOpencodeTokenUsage(rec({ tokens_in: 10, tokens_out: 2, tokens_cache: 900 }))
        expect(first?.cacheReadTok).toBe(900)
        const second = latestOpencodeTokenUsage(rec({ tokens_in: 20, tokens_out: 4 }), first)
        expect(second).toEqual({ inTok: 20, cacheReadTok: 900, outTok: 4 })
    })

    it('reports nothing for a slice with no records, even when seeded', () => {
        const seed = { inTok: 1, cacheReadTok: 2, outTok: 3 }
        expect(latestOpencodeTokenUsage('{"agent":"claude"}\nnot json\n', seed)).toBeNull()
    })
})
