import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import type { AiTool } from './tab-monitor'

/**
 * Cumulative per-tab token usage (input / output), surfaced to the sidebar.
 *
 * No agent's hook payload carries session token totals (verified against each
 * agent's source), so usage is read from the agent's TRANSCRIPT:
 *
 *   - Claude (implemented): each `type:"assistant"` JSONL record carries
 *     `message.usage.{input_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens, output_tokens}` for THAT turn. We sum across
 *     the session. The transcript path arrives in every hook payload
 *     (HookSnapshot.transcriptPath). `inTok` counts what the model processed
 *     as NEW this turn — fresh `input_tokens` + cache CREATION. Cache READ is
 *     tracked separately as `cacheReadTok`: the same growing context re-read
 *     from cache every turn (cheap, billed ~0.1x), so its cumulative total
 *     reaches the hundreds of millions and would dwarf the real input (in > out
 *     by 100x+) if folded in. The sidebar shows it as its own dim "cache"
 *     figure so in/out stay comparable; k/m suffixes keep it legible.
 *
 *   - Codex (implemented): rollout JSONL `event_msg` records periodically
 *     carry `payload.type:"token_count"` with
 *     `payload.info.total_token_usage.{input_tokens,output_tokens}`. That is
 *     already a running total, so we keep the newest complete token_count
 *     record seen in the transcript.
 *
 *   - Gemini (implemented): `~/.gemini/tmp/<project_hash>/chats/*.json`
 *     stores the complete session, and assistant messages carry
 *     `tokens.{input,output,cached,thoughts}`. We locate by `session_id` and
 *     sum `input` / `output` across messages with token blocks.
 *
 *   - opencode (implemented): our shipped plugin copies assistant
 *     `message.updated` `info.tokens.{input,output}` into the per-tab hook log
 *     as running `tokens_in` / `tokens_out` totals. We read the newest complete
 *     totals from `~/.glanceterm/hooks/<tab_id>.log`.
 *
 * Efficiency: the Claude transcript can be many MB. We read INCREMENTALLY —
 * track a byte offset per tab and only parse the bytes appended since the last
 * read, keeping running sums. A path change or file shrink (new session /
 * truncation) resets the offset and sums. Throttled so a busy poll loop
 * doesn't stat/read every tick.
 */

interface ClaudeUsageState {
    /** Transcript path these sums belong to — reset everything if it changes. */
    path: string
    /** Next unread byte offset (advances only past complete lines). */
    offset: number
    inTok: number
    /** Cumulative cache-read tokens — tracked apart from inTok (the headline
     *  input) so the UI can show it as its own dim figure; see
     *  sumClaudeAssistantUsage for why. */
    cacheReadTok: number
    outTok: number
    /** Last non-empty `message.model` seen in the transcript. Claude's hook
     *  events carry the model ONLY on a `startup`/`compact` SessionStart — a
     *  `resume` SessionStart sends an empty model — so a resumed tab never gets
     *  the model via hooks. The transcript records it on every assistant message,
     *  so we surface it here as the fallback that keeps the model chip alive
     *  across resume / auto-resume. Sticky (kept across model-less chunks).
     *  NOTE: tab-monitor uses this ONLY when the hook snapshot's model is empty
     *  (`model = snap.model || usage.model`), so on a live tab whose SessionStart
     *  model is present it does NOT override that — a mid-session `/model` switch
     *  is therefore reflected after a resume, not on the still-running tab. */
    model: string | null
    /** ms of the last read — throttle gate. */
    lastReadAt: number
}

interface CodexUsageState {
    /** Transcript path these totals belong to — reset everything if it changes. */
    path: string
    /** Next unread byte offset (advances only past complete lines). */
    offset: number
    inTok: number
    /** Cumulative cached-input tokens (Codex's cache-read equivalent), tracked
     *  apart from inTok like Claude's cacheReadTok so the sidebar shows it as its
     *  own "cache" figure. */
    cacheReadTok: number
    outTok: number
    /** Whether at least one token_count record has been observed. */
    seen: boolean
    /** ms of the last read — throttle gate. */
    lastReadAt: number
}

interface JsonUsageState {
    path: string
    inTok: number
    /** Gemini cached-input tokens, tracked apart from inTok (Gemini's `input`
     *  INCLUDES the cached portion) so the sidebar shows it as its own figure. */
    cacheReadTok: number
    outTok: number
    seen: boolean
    size: number
    mtimeMs: number
    lastReadAt: number
}

interface GeminiUsageState extends JsonUsageState {
    /** Last `messages[].model` seen in the saved chat. Gemini's hooks never
     *  carry the model (it's nested under `llm_request` on an event we don't
     *  subscribe to — see feature-matrix), so the chat file is the ONLY source.
     *  Sticky; tracks a `/model` switch. */
    model: string | null
    sessionId: string
}

interface LogUsageState {
    path: string
    offset: number
    inTok: number
    /** opencode cache-read tokens (info.tokens.cache.read), when the adapter
     *  reports them — its own figure like Claude/Codex. */
    cacheReadTok: number
    outTok: number
    seen: boolean
    lastReadAt: number
}

export interface UsageSource {
    transcriptPath?: string | null
    sessionId?: string | null
    tabId?: string | null
}

/** Minimum gap between transcript reads per tab. Usage changes at most once
 *  per turn (seconds-to-minutes apart); 6 s keeps the sidebar fresh without
 *  re-statting (and, for Gemini, re-parsing) the transcript every poll. */
const USAGE_READ_INTERVAL_MS = 6_000

@Injectable({ providedIn: 'root' })
export class UsageTrackerService {
    private claude = new WeakMap<object, ClaudeUsageState>()
    private codex = new WeakMap<object, CodexUsageState>()
    private gemini = new WeakMap<object, GeminiUsageState>()
    private opencode = new WeakMap<object, LogUsageState>()

    /**
     * Cumulative {inTok, outTok} for this tab, or null if unavailable
     * (unsupported agent, no transcript yet, throttled-with-no-prior-value).
     * `key` is any stable per-tab object (the inner tab component).
     */
    async compute (
        key: object,
        tool: AiTool | null,
        source: string | null | UsageSource,
    ): Promise<{ inTok: number; outTok: number; cacheReadTok?: number; model?: string | null } | null> {
        const src = normalizeUsageSource(source)
        if (tool === 'claude' && src.transcriptPath) {
            return this.computeClaude(key, src.transcriptPath)
        }
        if (tool === 'codex' && src.transcriptPath) {
            return this.computeCodex(key, src.transcriptPath)
        }
        if (tool === 'gemini' && src.sessionId) {
            return this.computeGemini(key, src.sessionId)
        }
        if (tool === 'opencode' && src.tabId) {
            return this.computeOpencode(key, src.tabId)
        }
        return null
    }

    /** Drop a tab's state (e.g. on close) so it can't leak — WeakMap already
     *  collects closed tabs, but callers may clear eagerly. */
    forget (key: object): void {
        this.claude.delete(key)
        this.codex.delete(key)
        this.gemini.delete(key)
        this.opencode.delete(key)
    }

    private async computeClaude (
        key: object,
        path: string,
    ): Promise<{ inTok: number; cacheReadTok: number; outTok: number; model: string | null } | null> {
        let st = this.claude.get(key)
        const now = Date.now()

        // New tab, or the session's transcript changed → start fresh.
        if (!st || st.path !== path) {
            st = { path, offset: 0, inTok: 0, cacheReadTok: 0, outTok: 0, model: null, lastReadAt: 0 }
            this.claude.set(key, st)
        }

        // Throttle: return the last computed value between reads.
        if (now - st.lastReadAt < USAGE_READ_INTERVAL_MS) {
            return st.offset > 0 || st.lastReadAt > 0
                ? { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok, model: st.model }
                : null
        }
        st.lastReadAt = now

        let size: number
        try {
            size = (await fs.stat(path)).size
        } catch {
            return null   // transcript not present (yet)
        }

        // File shrank (truncated / replaced) → re-read from the top. Reset the
        // model too: a replaced transcript may belong to a different model, and
        // the re-read below restores it from the new content.
        if (size < st.offset) {
            st.offset = 0; st.inTok = 0; st.cacheReadTok = 0; st.outTok = 0; st.model = null
        }
        if (size > st.offset) {
            try {
                const fh = await fs.open(path, 'r')
                try {
                    const len = size - st.offset
                    const buf = Buffer.allocUnsafe(len)
                    await fh.read(buf, 0, len, st.offset)
                    const text = buf.toString('utf8')
                    // Only advance past COMPLETE lines; a trailing partial line
                    // is left for the next read (offset stops at the last \n).
                    const lastNl = text.lastIndexOf('\n')
                    if (lastNl >= 0) {
                        const complete = text.slice(0, lastNl)
                        const delta = sumClaudeAssistantUsage(complete)
                        st.inTok += delta.inTok
                        st.cacheReadTok += delta.cacheReadTok
                        st.outTok += delta.outTok
                        // Model rides the same assistant records we just summed
                        // (one pass). Keep the prior value if this chunk had no
                        // assistant line so the chip never blanks mid-session.
                        if (delta.model) st.model = delta.model
                        st.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
                    }
                } finally {
                    await fh.close()
                }
            } catch {
                /* transient read error — keep prior sums, retry next interval */
            }
        }
        return { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok, model: st.model }
    }

    private async computeCodex (
        key: object,
        path: string,
    ): Promise<{ inTok: number; cacheReadTok: number; outTok: number } | null> {
        // NOTE: no transcript model fallback here, unlike Claude/Gemini. Codex
        // stamps `.model` on every hook event (including its own SessionStart),
        // so the hook snapshot always carries it whenever a snapshot exists — and
        // tab-monitor only calls compute() WHEN a snapshot exists. A rollout
        // fallback would be dead code (it could only fire if a Codex snapshot had
        // an empty model, which never happens). The only blank-model case — a
        // resumed Codex tab with zero hook events yet — has no snapshot, so
        // compute() isn't called and there's no transcript path to read anyway.
        let st = this.codex.get(key)
        const now = Date.now()

        // New tab, or the session's transcript changed → start fresh.
        if (!st || st.path !== path) {
            st = { path, offset: 0, inTok: 0, cacheReadTok: 0, outTok: 0, seen: false, lastReadAt: 0 }
            this.codex.set(key, st)
        }

        // Throttle: return the last computed value between reads.
        if (now - st.lastReadAt < USAGE_READ_INTERVAL_MS) {
            return st.seen ? { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok } : null
        }
        st.lastReadAt = now

        let size: number
        try {
            size = (await fs.stat(path)).size
        } catch {
            return null   // transcript not present (yet)
        }

        // File shrank (truncated / replaced) → re-read from the top.
        if (size < st.offset) {
            st.offset = 0; st.inTok = 0; st.cacheReadTok = 0; st.outTok = 0; st.seen = false
        }
        if (size > st.offset) {
            try {
                const fh = await fs.open(path, 'r')
                try {
                    const len = size - st.offset
                    const buf = Buffer.allocUnsafe(len)
                    await fh.read(buf, 0, len, st.offset)
                    const text = buf.toString('utf8')
                    // Only advance past COMPLETE lines; a trailing partial line
                    // is left for the next read (offset stops at the last \n).
                    const lastNl = text.lastIndexOf('\n')
                    if (lastNl >= 0) {
                        const complete = text.slice(0, lastNl)
                        const latest = latestCodexTokenUsage(complete)
                        if (latest) {
                            st.inTok = latest.inTok
                            st.cacheReadTok = latest.cacheReadTok
                            st.outTok = latest.outTok
                            st.seen = true
                        }
                        st.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
                    }
                } finally {
                    await fh.close()
                }
            } catch {
                /* transient read error — keep prior totals, retry next interval */
            }
        }
        return st.seen ? { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok } : null
    }

    private async computeGemini (
        key: object,
        sessionId: string,
    ): Promise<{ inTok: number; cacheReadTok: number; outTok: number; model: string | null } | null> {
        let st = this.gemini.get(key)
        const now = Date.now()

        if (!st || st.sessionId !== sessionId) {
            const chatPath = await findGeminiChatPath(sessionId)
            if (!chatPath) return null
            st = { sessionId, path: chatPath, inTok: 0, cacheReadTok: 0, outTok: 0, model: null, seen: false, size: -1, mtimeMs: -1, lastReadAt: 0 }
            this.gemini.set(key, st)
        }

        if (now - st.lastReadAt < USAGE_READ_INTERVAL_MS) {
            return (st.seen || st.model) ? { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok, model: st.model } : null
        }
        st.lastReadAt = now

        let stat
        try {
            stat = await fs.stat(st.path)
        } catch {
            this.gemini.delete(key)
            return null
        }

        if (stat.size === st.size && stat.mtimeMs === st.mtimeMs) {
            return (st.seen || st.model) ? { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok, model: st.model } : null
        }

        try {
            const raw = await fs.readFile(st.path, 'utf8')
            // One JSON.parse / one message loop yields both tokens and model.
            const usage = sumGeminiMessageUsage(raw)
            st.inTok = usage.inTok
            st.cacheReadTok = usage.cacheReadTok
            st.outTok = usage.outTok
            st.seen = usage.inTok > 0 || usage.cacheReadTok > 0 || usage.outTok > 0
            // Whole-file read → the parse result IS the complete truth, so assign
            // (not "keep prior if non-null"): if a rewrite drops the model, the
            // chip clears rather than showing a slug no longer in the file. Unlike
            // the incremental Claude reader, there's no earlier chunk to preserve.
            st.model = usage.model
            st.size = stat.size
            st.mtimeMs = stat.mtimeMs
        } catch {
            /* Gemini may be rewriting the JSON; keep prior totals, retry later. */
        }

        return (st.seen || st.model) ? { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok, model: st.model } : null
    }

    private async computeOpencode (
        key: object,
        tabId: string,
    ): Promise<{ inTok: number; cacheReadTok: number; outTok: number } | null> {
        const logPath = path.join(homeDir(), '.glanceterm', 'hooks', `${tabId}.log`)
        let st = this.opencode.get(key)
        const now = Date.now()

        if (!st || st.path !== logPath) {
            st = { path: logPath, offset: 0, inTok: 0, cacheReadTok: 0, outTok: 0, seen: false, lastReadAt: 0 }
            this.opencode.set(key, st)
        }

        if (now - st.lastReadAt < USAGE_READ_INTERVAL_MS) {
            return st.seen ? { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok } : null
        }
        st.lastReadAt = now

        let size: number
        try {
            size = (await fs.stat(logPath)).size
        } catch {
            return null
        }

        if (size < st.offset) {
            st.offset = 0; st.inTok = 0; st.cacheReadTok = 0; st.outTok = 0; st.seen = false
        }
        if (size > st.offset) {
            try {
                const fh = await fs.open(logPath, 'r')
                try {
                    const len = size - st.offset
                    const buf = Buffer.allocUnsafe(len)
                    await fh.read(buf, 0, len, st.offset)
                    const text = buf.toString('utf8')
                    const lastNl = text.lastIndexOf('\n')
                    if (lastNl >= 0) {
                        const complete = text.slice(0, lastNl)
                        const latest = latestOpencodeTokenUsage(complete)
                        if (latest) {
                            st.inTok = latest.inTok
                            st.cacheReadTok = latest.cacheReadTok
                            st.outTok = latest.outTok
                            st.seen = true
                        }
                        st.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
                    }
                } finally {
                    await fh.close()
                }
            } catch {
                /* transient read error — keep prior totals, retry next interval */
            }
        }

        return st.seen ? { inTok: st.inTok, cacheReadTok: st.cacheReadTok, outTok: st.outTok } : null
    }
}

/**
 * Sum the per-turn usage across the `type:"assistant"` records in a chunk of
 * Claude transcript NDJSON, into three buckets: `inTok` (`input_tokens` +
 * `cache_creation_input_tokens`), `cacheReadTok` (`cache_read_input_tokens`,
 * kept apart — see UsageTrackerService doc), and `outTok` (`output_tokens`).
 * Also returns `model` — the newest `message.model` across the assistant records
 * in the chunk (last-wins; the `<synthetic>` sentinel and empty values skipped),
 * captured in the SAME pass since it rides the same record as `usage`. Claude's
 * hooks carry the model only on a `startup`/`compact` SessionStart (a `resume`
 * one sends an empty model), so this is the source that keeps the chip alive
 * across resume. Pure; exported for tests. Non-assistant / malformed / usage-less
 * lines are skipped.
 */
export function sumClaudeAssistantUsage (text: string): { inTok: number; cacheReadTok: number; outTok: number; model: string | null } {
    let inTok = 0
    let cacheReadTok = 0
    let outTok = 0
    let model: string | null = null
    for (const line of text.split('\n')) {
        if (!line) continue
        // Cheap pre-filter to skip the many non-assistant lines without a parse.
        // Assistant records carry both `usage` and `model`, so one filter serves both.
        if (!line.includes('"usage"')) continue
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        if (rec?.type !== 'assistant') continue
        const mdl = rec?.message?.model
        if (typeof mdl === 'string' && mdl && mdl !== '<synthetic>') model = mdl
        const u = rec?.message?.usage
        if (!u) continue
        // `inTok` = the input the model actually had to PROCESS as new content
        // this turn: fresh uncached input + cache CREATION. cache READ is summed
        // separately into `cacheReadTok` — it's the same growing context re-read
        // from cache every turn (cheap, billed at ~0.1x), so over a long agentic
        // session its cumulative total dwarfs everything (e.g. 360m read vs ~6m
        // real input). Folding it into `inTok` made the headline meaningless
        // (in ≫ out by 100x+); the sidebar now shows it as its own dim "cache"
        // figure so `in`/`out` stay comparable while the cache volume is visible.
        if (typeof u.input_tokens === 'number') inTok += u.input_tokens
        if (typeof u.cache_creation_input_tokens === 'number') inTok += u.cache_creation_input_tokens
        if (typeof u.cache_read_input_tokens === 'number') cacheReadTok += u.cache_read_input_tokens
        if (typeof u.output_tokens === 'number') outTok += u.output_tokens
    }
    return { inTok, cacheReadTok, outTok, model }
}

/**
 * Return the newest Codex `token_count` running total in a chunk of rollout
 * JSONL, or null if none. Pure; exported for tests. Malformed lines and
 * partial/non-token records are skipped. (No model is read here — see
 * computeCodex for why the rollout model would be dead code.)
 */
export function latestCodexTokenUsage (text: string): { inTok: number; cacheReadTok: number; outTok: number } | null {
    let latest: { inTok: number; cacheReadTok: number; outTok: number } | null = null
    for (const line of text.split('\n')) {
        if (!line) continue
        if (!line.includes('"token_count"')) continue
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        if (rec?.type !== 'event_msg' || rec?.payload?.type !== 'token_count') continue
        const u = rec?.payload?.info?.total_token_usage
        if (!u) continue
        if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') continue
        // `input_tokens` INCLUDES the cached portion; split it out so `in` is the
        // fresh input and `cache` is the cache-read (matches Claude + the Token
        // Usage page). `output_tokens` excludes reasoning — fold it into `out`.
        const cache = typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : 0
        const reasoning = typeof u.reasoning_output_tokens === 'number' ? u.reasoning_output_tokens : 0
        latest = {
            inTok: Math.max(0, u.input_tokens - cache),
            cacheReadTok: cache,
            outTok: u.output_tokens + reasoning,
        }
    }
    return latest
}

/**
 * Sum Gemini CLI saved-chat `message.tokens.{input,output}` values and return
 * the newest `messages[].model` (last-wins) in the SAME pass. Gemini's hooks
 * never carry the model (it's nested under `llm_request` on an unsubscribed
 * event — see feature-matrix), so the saved chat is the ONLY model source, which
 * means `/model` IS tracked here. Gemini's saved JSON also carries `cached` and
 * `thoughts`; those are kept separate by Gemini, so the sidebar's in/out display
 * follows the explicit in/out fields.
 */
export function sumGeminiMessageUsage (text: string): { inTok: number; cacheReadTok: number; outTok: number; model: string | null } {
    let parsed: any
    try { parsed = JSON.parse(text) } catch { return { inTok: 0, cacheReadTok: 0, outTok: 0, model: null } }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
    let inTok = 0, cacheReadTok = 0, outTok = 0
    let model: string | null = null
    for (const msg of messages) {
        if (typeof msg?.model === 'string' && msg.model) model = msg.model
        const t = msg?.tokens
        if (!t) continue
        // Gemini's `input` INCLUDES `cached` → split it out so `in` is fresh and
        // `cache` is the cache-read (matches Claude/Codex + the Token Usage page);
        // `thoughts` (reasoning) and `tool` are generated output → fold into `out`.
        const cached = typeof t.cached === 'number' ? t.cached : 0
        if (typeof t.input === 'number') inTok += Math.max(0, t.input - cached)
        cacheReadTok += cached
        if (typeof t.output === 'number') outTok += t.output
        if (typeof t.thoughts === 'number') outTok += t.thoughts
        if (typeof t.tool === 'number') outTok += t.tool
    }
    return { inTok, cacheReadTok, outTok, model }
}

/**
 * Return the newest opencode token total emitted by our plugin into the per-tab
 * hook log. The plugin writes running totals, so the latest complete record is
 * authoritative.
 */
export function latestOpencodeTokenUsage (text: string): { inTok: number; cacheReadTok: number; outTok: number } | null {
    let latest: { inTok: number; cacheReadTok: number; outTok: number } | null = null
    for (const line of text.split('\n')) {
        if (!line) continue
        if (!line.includes('"tokens_in"') && !line.includes('"tokens_out"')) continue
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        if (rec?.agent !== 'opencode') continue
        const inTok = typeof rec.tokens_in === 'number' ? rec.tokens_in : null
        const outTok = typeof rec.tokens_out === 'number' ? rec.tokens_out : null
        if (inTok === null && outTok === null) continue
        const cacheTok = typeof rec.tokens_cache === 'number' ? rec.tokens_cache : null
        const prev = latest
        latest = {
            inTok: inTok !== null ? inTok : (prev ? prev.inTok : 0),
            cacheReadTok: cacheTok !== null ? cacheTok : (prev ? prev.cacheReadTok : 0),
            outTok: outTok !== null ? outTok : (prev ? prev.outTok : 0),
        }
    }
    return latest
}

function normalizeUsageSource (source: string | null | UsageSource): UsageSource {
    if (typeof source === 'string' || source === null) return { transcriptPath: source }
    return source
}

async function findGeminiChatPath (sessionId: string): Promise<string | null> {
    const short = sessionId.split('-')[0]
    const tmpRoot = path.join(homeDir(), '.gemini', 'tmp')
    let projects: string[]
    try {
        projects = await fs.readdir(tmpRoot)
    } catch {
        return null
    }

    for (const project of projects) {
        const chatsDir = path.join(tmpRoot, project, 'chats')
        let entries: string[]
        try {
            entries = await fs.readdir(chatsDir)
        } catch {
            continue
        }
        for (const entry of entries) {
            if (!entry.endsWith('.json')) continue
            if (short && !entry.includes(short)) continue
            const candidate = path.join(chatsDir, entry)
            try {
                const raw = await fs.readFile(candidate, 'utf8')
                const parsed = JSON.parse(raw)
                if (parsed?.sessionId === sessionId) return candidate
            } catch {
                continue
            }
        }
    }
    return null
}

function homeDir (): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
}
