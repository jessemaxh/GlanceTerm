import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'

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
 *     (HookSnapshot.transcriptPath). Cache read/creation tokens ARE counted
 *     as input: for a Claude agent they are the bulk of the input (the whole
 *     context is re-read from cache each turn), so excluding them made "in" a
 *     tiny residue and showed an abnormal in < out. Cumulative cache-read can
 *     reach the hundreds of millions — that is the real input volume, and the
 *     k/m-suffixed display keeps it legible.
 *
 *   - Codex / Gemini / opencode (deferred): sources are known (Codex rollout
 *     `~/.codex/sessions/.../rollout-*-<id>.jsonl` last `token_count` line's
 *     `total_token_usage` — a running total; Gemini `~/.gemini/tmp/<hash>/
 *     chats/*.jsonl` `message.tokens`; opencode `message.updated`
 *     `info.tokens.{input,output}` summed in the plugin). Add a branch in
 *     `compute()` (or, for opencode, carry it in the hook log like `model`).
 *     See docs/feature-matrix.md.
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
    outTok: number
    /** ms of the last read — throttle gate. */
    lastReadAt: number
}

/** Minimum gap between transcript reads per tab. Usage changes at most once
 *  per turn (seconds-to-minutes apart); 4 s keeps the sidebar fresh without
 *  re-statting a multi-MB file every 1.5 s poll. */
const USAGE_READ_INTERVAL_MS = 4_000

@Injectable({ providedIn: 'root' })
export class UsageTrackerService {
    private claude = new WeakMap<object, ClaudeUsageState>()

    /**
     * Cumulative {inTok, outTok} for this tab, or null if unavailable
     * (unsupported agent, no transcript yet, throttled-with-no-prior-value).
     * `key` is any stable per-tab object (the inner tab component).
     */
    async compute (
        key: object,
        tool: AiTool | null,
        transcriptPath: string | null,
    ): Promise<{ inTok: number; outTok: number } | null> {
        if (tool === 'claude' && transcriptPath) {
            return this.computeClaude(key, transcriptPath)
        }
        // Codex / Gemini / opencode: deferred — see class doc.
        return null
    }

    /** Drop a tab's state (e.g. on close) so it can't leak — WeakMap already
     *  collects closed tabs, but callers may clear eagerly. */
    forget (key: object): void {
        this.claude.delete(key)
    }

    private async computeClaude (
        key: object,
        path: string,
    ): Promise<{ inTok: number; outTok: number } | null> {
        let st = this.claude.get(key)
        const now = Date.now()

        // New tab, or the session's transcript changed → start fresh.
        if (!st || st.path !== path) {
            st = { path, offset: 0, inTok: 0, outTok: 0, lastReadAt: 0 }
            this.claude.set(key, st)
        }

        // Throttle: return the last computed value between reads.
        if (now - st.lastReadAt < USAGE_READ_INTERVAL_MS) {
            return st.offset > 0 || st.lastReadAt > 0
                ? { inTok: st.inTok, outTok: st.outTok }
                : null
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
            st.offset = 0; st.inTok = 0; st.outTok = 0
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
                        st.outTok += delta.outTok
                        st.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
                    }
                } finally {
                    await fh.close()
                }
            } catch {
                /* transient read error — keep prior sums, retry next interval */
            }
        }
        return { inTok: st.inTok, outTok: st.outTok }
    }
}

/**
 * Sum the input side (`input_tokens` + `cache_creation_input_tokens` +
 * `cache_read_input_tokens`) and `output_tokens` across the `type:"assistant"`
 * records in a chunk of Claude transcript NDJSON. Pure; exported for tests.
 * Non-assistant lines, malformed lines, and missing usage are skipped. Cache
 * tokens ARE summed into the input total (see UsageTrackerService doc).
 */
export function sumClaudeAssistantUsage (text: string): { inTok: number; outTok: number } {
    let inTok = 0
    let outTok = 0
    for (const line of text.split('\n')) {
        if (!line) continue
        // Cheap pre-filter to skip the many non-assistant lines without a parse.
        if (!line.includes('"usage"')) continue
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        if (rec?.type !== 'assistant') continue
        const u = rec?.message?.usage
        if (!u) continue
        // Input = ALL tokens fed to the model that turn: the new uncached
        // input PLUS cache creation/read. For a Claude agent the cache-read
        // portion is the bulk of the input (the whole growing context is
        // re-read from cache every turn); excluding it made "in" a tiny
        // residue and produced the abnormal in < out display. This matches
        // the input-token total Anthropic's console / `/cost` report.
        if (typeof u.input_tokens === 'number') inTok += u.input_tokens
        if (typeof u.cache_creation_input_tokens === 'number') inTok += u.cache_creation_input_tokens
        if (typeof u.cache_read_input_tokens === 'number') inTok += u.cache_read_input_tokens
        if (typeof u.output_tokens === 'number') outTok += u.output_tokens
    }
    return { inTok, outTok }
}
