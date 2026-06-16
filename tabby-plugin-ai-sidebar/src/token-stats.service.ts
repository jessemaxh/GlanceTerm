import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import type { AiTool } from './tab-monitor'

/**
 * All-time / windowed token-usage aggregation across EVERY on-disk agent
 * transcript — the data behind the standalone "Token Usage" settings page.
 * Distinct from UsageTrackerService (which tracks only the live, currently-open
 * tabs): this one scans the whole history so totals survive `/clear` (each
 * cleared Claude session is its own transcript → counted as a separate session,
 * summed back together per project here).
 *
 * Metric convention matches the sidebar: `in` = fresh input + cache CREATION;
 * `cache` = cache READ; `out` = output.
 *
 * Per-day buckets (local date) make arbitrary time windows (Today / 7d / range)
 * a sum-of-days. A persistent incremental cache (~/.glanceterm/token-stats.json)
 * keyed by file path keeps re-scans cheap: unchanged files reuse cached buckets,
 * grown files read only appended bytes, closed sessions are never re-read.
 *
 * Sources + shapes verified 2026-06-16 (see internal/todo-token-stats.md):
 *   - Claude:  ~/.claude/projects/<proj>/<session>.jsonl (+ <session>/subagents/*.jsonl)
 *   - Codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   - Gemini:  ~/.gemini/tmp/<hash>/chats/*.json
 *   - opencode: ~/.glanceterm/hooks/<tab>.log  (history partial — only existing logs)
 */

export interface DayBucket { inTok: number; cacheTok: number; outTok: number }
export type PerDay = Record<string, DayBucket>

/** One session's lifetime usage, day-bucketed. `project` is a cwd (Claude/Codex)
 *  or a project hash (Gemini) or '' (unknown). */
export interface SessionStat {
    agent: AiTool
    sessionId: string
    project: string
    perDay: PerDay
    turns: number
    lastActive: number    // ms epoch of the newest record seen
}

export interface Totals { inTok: number; cacheTok: number; outTok: number }

/** Per-file cache row persisted to disk. `cumul` is the last running-total seen
 *  (Codex/opencode report cumulative figures; Claude/Gemini are per-turn → null). */
interface FileEntry {
    agent: AiTool
    project: string
    sessionId: string
    mtimeMs: number
    size: number
    offset: number
    perDay: PerDay
    turns: number
    lastActive: number
    cumul: Totals | null
}

const CACHE_FILE = 'token-stats.json'
const CACHE_VERSION = 1

@Injectable({ providedIn: 'root' })
export class TokenStatsService {
    /** path → cached per-file aggregation. Loaded from disk once, persisted after scans. */
    private cache = new Map<string, FileEntry>()
    private loaded = false
    /** Shared in-flight scan: concurrent callers (e.g. reopening the modal mid-scan)
     *  await the SAME scan and get the full result, not a partial snapshot. */
    private scanInFlight: Promise<SessionStat[]> | null = null

    /** Load the persisted cache (idempotent). */
    private async load (): Promise<void> {
        if (this.loaded) return
        this.loaded = true
        try {
            const raw = await fs.readFile(path.join(glanceDir(), CACHE_FILE), 'utf8')
            const parsed = JSON.parse(raw)
            if (parsed?.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') {
                for (const [k, v] of Object.entries(parsed.files as Record<string, FileEntry>)) {
                    this.cache.set(k, v)
                }
            }
        } catch { /* no cache yet / unreadable → start empty */ }
    }

    private async persist (): Promise<void> {
        const files: Record<string, FileEntry> = {}
        for (const [k, v] of this.cache) files[k] = v
        try {
            await fs.mkdir(glanceDir(), { recursive: true })
            // Atomic: write a temp then rename over the target, so a crash mid-write
            // can't truncate token-stats.json (which load() would discard → full re-scan).
            const target = path.join(glanceDir(), CACHE_FILE)
            const tmp = `${target}.tmp`
            await fs.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, files }))
            await fs.rename(tmp, target)
        } catch { /* best-effort */ }
    }

    /**
     * Scan all sources and return one SessionStat per transcript file. Re-uses
     * the persistent cache so only changed/active files are re-read. `onProgress`
     * fires as (done, total) for first-scan progress. Concurrency-safe: a second
     * call while a scan is running awaits the SAME scan.
     */
    async scan (onProgress?: (done: number, total: number) => void): Promise<SessionStat[]> {
        await this.load()
        if (this.scanInFlight) return this.scanInFlight
        this.scanInFlight = this.doScan(onProgress)
        try { return await this.scanInFlight } finally { this.scanInFlight = null }
    }

    private async doScan (onProgress?: (done: number, total: number) => void): Promise<SessionStat[]> {
        const files = await this.enumerate()
        const seen = new Set<string>()
        let done = 0
        let changed = false
        for (const f of files) {
            seen.add(f.path)
            try { if (await this.ingestFile(f.agent, f.path)) changed = true } catch { /* skip unreadable file */ }
            onProgress?.(++done, files.length)
            // Yield to the event loop periodically so a big first scan doesn't
            // freeze the renderer between progress repaints.
            if (done % 25 === 0) await new Promise<void>(r => setTimeout(r, 0))
        }
        // Drop cache rows for files that no longer exist (deleted transcripts).
        for (const k of [...this.cache.keys()]) if (!seen.has(k)) { this.cache.delete(k); changed = true }
        if (changed) await this.persist()
        return this.snapshot()
    }

    /** Current cached sessions without re-scanning. */
    snapshot (): SessionStat[] {
        const out: SessionStat[] = []
        for (const e of this.cache.values()) {
            out.push({ agent: e.agent, sessionId: e.sessionId, project: e.project, perDay: e.perDay, turns: e.turns, lastActive: e.lastActive })
        }
        return out
    }

    /** Enumerate every candidate transcript across all agents. */
    private async enumerate (): Promise<Array<{ agent: AiTool; path: string }>> {
        const out: Array<{ agent: AiTool; path: string }> = []
        // Claude — projects/<proj>/*.jsonl plus per-session subagents/*.jsonl
        for (const proj of await safeReaddir(path.join(homeDir(), '.claude', 'projects'))) {
            const projDir = path.join(homeDir(), '.claude', 'projects', proj)
            for (const name of await safeReaddir(projDir)) {
                if (name.endsWith('.jsonl')) out.push({ agent: 'claude', path: path.join(projDir, name) })
                else {
                    const subDir = path.join(projDir, name, 'subagents')
                    for (const sub of await safeReaddir(subDir)) {
                        if (sub.endsWith('.jsonl')) out.push({ agent: 'claude', path: path.join(subDir, sub) })
                    }
                }
            }
        }
        // Codex — sessions/YYYY/MM/DD/rollout-*.jsonl
        await walkJsonl(path.join(homeDir(), '.codex', 'sessions'), p => {
            if (p.endsWith('.jsonl')) out.push({ agent: 'codex', path: p })
        })
        // Gemini — tmp/<hash>/chats/*.json
        const tmpRoot = path.join(homeDir(), '.gemini', 'tmp')
        for (const proj of await safeReaddir(tmpRoot)) {
            const chatsDir = path.join(tmpRoot, proj, 'chats')
            for (const name of await safeReaddir(chatsDir)) {
                if (name.endsWith('.json')) out.push({ agent: 'gemini', path: path.join(chatsDir, name) })
            }
        }
        // opencode — our per-tab hook logs (only ones that actually carry tokens)
        const hooksDir = path.join(glanceDir(), 'hooks')
        for (const name of await safeReaddir(hooksDir)) {
            if (name.endsWith('.log')) out.push({ agent: 'opencode', path: path.join(hooksDir, name) })
        }
        return out
    }

    /** Read (incrementally where possible) one file into the cache. Returns true
     *  if the cache entry was created/updated, so the caller persists only on change. */
    private async ingestFile (agent: AiTool, p: string): Promise<boolean> {
        let stat: Awaited<ReturnType<typeof fs.stat>>
        try { stat = await fs.stat(p) } catch { return false }
        const prev = this.cache.get(p)
        // Unchanged since last scan → keep cached row.
        if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) return false

        if (agent === 'gemini') {
            // Whole-file JSON; re-parse on any change.
            const text = await fs.readFile(p, 'utf8')
            const r = parseGeminiFull(text)
            this.cache.set(p, {
                agent, project: r.project, sessionId: r.sessionId || path.basename(p, '.json'),
                mtimeMs: stat.mtimeMs, size: stat.size, offset: stat.size,
                perDay: r.perDay, turns: r.turns, lastActive: r.lastTs, cumul: null,
            })
            return true
        }

        // NDJSON (Claude/Codex/opencode) — incremental from prev.offset.
        let entry: FileEntry = prev ?? {
            agent, project: '', sessionId: '', mtimeMs: 0, size: 0, offset: 0,
            perDay: {}, turns: 0, lastActive: 0,
            cumul: agent === 'codex' || agent === 'opencode' ? { inTok: 0, cacheTok: 0, outTok: 0 } : null,
        }
        // File shrank, or was rewritten in place (mtime changed but size didn't
        // grow past our offset) → start over so the new content is re-read.
        if (stat.size < entry.offset || (prev && prev.mtimeMs !== stat.mtimeMs && stat.size <= entry.offset)) {
            entry = { ...entry, offset: 0, perDay: {}, turns: 0, lastActive: 0, cumul: entry.cumul ? { inTok: 0, cacheTok: 0, outTok: 0 } : null }
        }
        if (stat.size > entry.offset) {
            const fh = await fs.open(p, 'r')
            try {
                const len = stat.size - entry.offset
                const buf = Buffer.allocUnsafe(len)
                await fh.read(buf, 0, len, entry.offset)
                const text = buf.toString('utf8')
                const lastNl = text.lastIndexOf('\n')
                if (lastNl >= 0) {
                    const complete = text.slice(0, lastNl)
                    // Claude is per-turn; Codex/opencode report running totals (carry
                    // a `cumul` for the next incremental read). Split the branches so
                    // the cumul-bearing union stays well-typed.
                    if (agent === 'claude') {
                        applyChunk(entry, parseClaudeChunk(complete))
                    } else {
                        const r = agent === 'codex'
                            ? parseCodexChunk(complete, entry.cumul!)
                            : parseOpencodeChunk(complete, entry.cumul!)
                        applyChunk(entry, r)
                        entry.cumul = r.cumul
                    }
                    entry.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')
                }
            } finally {
                await fh.close()
            }
        }
        entry.mtimeMs = stat.mtimeMs
        entry.size = stat.size
        if (!entry.sessionId) entry.sessionId = path.basename(p).replace(/\.(jsonl|log)$/, '')
        this.cache.set(p, entry)
        return true
    }
}

// ─────────────────────────── pure parsers (exported for tests) ───────────────

/** Local YYYY-MM-DD for an epoch ms; '' when the timestamp is missing/invalid
 *  (such usage still counts in all-time totals but is excluded from dated windows). */
export function dayKey (tsMs: number): string {
    if (!Number.isFinite(tsMs) || tsMs <= 0) return ''
    const d = new Date(tsMs)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

function addToDay (perDay: PerDay, day: string, inTok: number, cacheTok: number, outTok: number): void {
    const b = (perDay[day] ??= { inTok: 0, cacheTok: 0, outTok: 0 })
    b.inTok += inTok; b.cacheTok += cacheTok; b.outTok += outTok
}

/** Merge `src` day buckets into `dst` (mutates dst). */
export function mergePerDay (dst: PerDay, src: PerDay): void {
    for (const [day, b] of Object.entries(src)) addToDay(dst, day, b.inTok, b.cacheTok, b.outTok)
}

export function parseClaudeChunk (text: string): { perDay: PerDay; turns: number; lastTs: number; project: string; sessionId: string } {
    const perDay: PerDay = {}
    let turns = 0, lastTs = 0, project = '', sessionId = ''
    for (const line of text.split('\n')) {
        if (!line || !line.includes('"usage"')) continue
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        if (rec?.type !== 'assistant') continue
        const u = rec?.message?.usage
        if (!u) continue
        const ts = Date.parse(rec.timestamp ?? '')
        if (!project && typeof rec.cwd === 'string') project = rec.cwd
        if (!sessionId && typeof rec.sessionId === 'string') sessionId = rec.sessionId
        const inTok = (num(u.input_tokens)) + num(u.cache_creation_input_tokens)
        addToDay(perDay, dayKey(ts), inTok, num(u.cache_read_input_tokens), num(u.output_tokens))
        turns++
        if (ts > lastTs) lastTs = ts
    }
    return { perDay, turns, lastTs, project, sessionId }
}

export function parseCodexChunk (text: string, prev: Totals): { perDay: PerDay; turns: number; lastTs: number; project: string; sessionId: string; cumul: Totals } {
    const perDay: PerDay = {}
    let turns = 0, lastTs = 0, project = '', sessionId = ''
    const cumul: Totals = { ...prev }
    for (const line of text.split('\n')) {
        if (!line) continue
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        // Best-effort cwd/session id from the rollout's meta record.
        if (!project && typeof rec?.payload?.cwd === 'string') project = rec.payload.cwd
        if (!sessionId && typeof rec?.payload?.id === 'string') sessionId = rec.payload.id
        if (rec?.type !== 'event_msg' || rec?.payload?.type !== 'token_count') continue
        const u = rec?.payload?.info?.total_token_usage
        if (!u) continue
        const ts = Date.parse(rec.timestamp ?? '')
        const cumCache = num(u.cached_input_tokens)
        const cumIn = Math.max(0, num(u.input_tokens) - cumCache) // fresh (non-cached) input
        const cumOut = num(u.output_tokens) + num(u.reasoning_output_tokens)
        addToDay(perDay, dayKey(ts),
            delta(cumIn, cumul.inTok),
            delta(cumCache, cumul.cacheTok),
            delta(cumOut, cumul.outTok))
        cumul.inTok = cumIn; cumul.cacheTok = cumCache; cumul.outTok = cumOut
        turns++
        if (ts > lastTs) lastTs = ts
    }
    return { perDay, turns, lastTs, project, sessionId, cumul }
}

export function parseGeminiFull (text: string): { perDay: PerDay; turns: number; lastTs: number; project: string; sessionId: string } {
    const perDay: PerDay = {}
    let turns = 0, lastTs = 0
    let parsed: any
    try { parsed = JSON.parse(text) } catch { return { perDay, turns, lastTs, project: '', sessionId: '' } }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
    for (const m of messages) {
        const t = m?.tokens
        if (!t) continue
        const ts = Date.parse(m?.timestamp ?? '')
        // Gemini's `input` INCLUDES `cached` (verified: input+output+thoughts==total),
        // unlike Claude (input excludes cache). Subtract so cache isn't double-counted.
        // `thoughts` (reasoning) is generated output — fold it into out (mirrors
        // Codex's reasoning_output_tokens), else output is badly undercounted.
        addToDay(perDay, dayKey(ts),
            Math.max(0, num(t.input) - num(t.cached)),
            num(t.cached),
            num(t.output) + num(t.thoughts) + num(t.tool))
        turns++
        if (ts > lastTs) lastTs = ts
    }
    return { perDay, turns, lastTs, project: typeof parsed?.projectHash === 'string' ? parsed.projectHash : '', sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : '' }
}

export function parseOpencodeChunk (text: string, prev: Totals): { perDay: PerDay; turns: number; lastTs: number; project: string; sessionId: string; cumul: Totals } {
    const perDay: PerDay = {}
    let turns = 0, lastTs = 0
    const cumul: Totals = { ...prev }
    for (const line of text.split('\n')) {
        if (!line || (!line.includes('"tokens_in"') && !line.includes('"tokens_out"'))) continue
        let rec: any
        try { rec = JSON.parse(line) } catch { continue }
        if (rec?.agent !== 'opencode') continue
        const cumIn = typeof rec.tokens_in === 'number' ? rec.tokens_in : cumul.inTok
        const cumOut = typeof rec.tokens_out === 'number' ? rec.tokens_out : cumul.outTok
        // The opencode adapter writes `ts` as Unix SECONDS (a number), not an ISO
        // string — Date.parse(number) is NaN, which would dump all usage into the
        // undated bucket (excluded from every dated window). Handle the epoch.
        const ts = typeof rec.ts === 'number' ? rec.ts * 1000
            : Date.parse(rec.ts ?? rec.timestamp ?? rec.time ?? '')
        addToDay(perDay, dayKey(ts), delta(cumIn, cumul.inTok), 0, delta(cumOut, cumul.outTok))
        cumul.inTok = cumIn; cumul.outTok = cumOut
        turns++
        if (ts > lastTs) lastTs = ts
    }
    return { perDay, turns, lastTs, project: '', sessionId: '', cumul }
}

// ─────────────────────────── aggregation (exported for tests) ────────────────

/** Sum one session's day buckets within [fromDay, toDay] (inclusive, '' bounds =
 *  open). Undated usage (day '') is included only when no bounds are given. */
export function totalsInWindow (perDay: PerDay, fromDay = '', toDay = ''): Totals {
    const t: Totals = { inTok: 0, cacheTok: 0, outTok: 0 }
    const windowed = fromDay !== '' || toDay !== ''
    for (const [day, b] of Object.entries(perDay)) {
        if (day === '') { if (!windowed) { t.inTok += b.inTok; t.cacheTok += b.cacheTok; t.outTok += b.outTok } ; continue }
        if (fromDay && day < fromDay) continue
        if (toDay && day > toDay) continue
        t.inTok += b.inTok; t.cacheTok += b.cacheTok; t.outTok += b.outTok
    }
    return t
}

export function addTotals (a: Totals, b: Totals): Totals {
    return { inTok: a.inTok + b.inTok, cacheTok: a.cacheTok + b.cacheTok, outTok: a.outTok + b.outTok }
}

export interface GroupRow { key: string; totals: Totals; turns: number; sessions: number; lastActive: number }

/** Roll sessions up by a key (agent or project) within a window. */
export function groupBy (sessions: SessionStat[], by: 'agent' | 'project', fromDay = '', toDay = ''): GroupRow[] {
    const map = new Map<string, GroupRow>()
    for (const s of sessions) {
        const key = by === 'agent' ? s.agent : (s.project || '(unknown)')
        const t = totalsInWindow(s.perDay, fromDay, toDay)
        if (t.inTok === 0 && t.cacheTok === 0 && t.outTok === 0) continue
        const row = map.get(key) ?? { key, totals: { inTok: 0, cacheTok: 0, outTok: 0 }, turns: 0, sessions: 0, lastActive: 0 }
        row.totals = addTotals(row.totals, t)
        row.turns += s.turns
        row.sessions += 1
        if (s.lastActive > row.lastActive) row.lastActive = s.lastActive
        map.set(key, row)
    }
    return [...map.values()].sort((a, b) => b.totals.outTok - a.totals.outTok)
}

/** Grand total across all sessions within a window. */
export function grandTotal (sessions: SessionStat[], fromDay = '', toDay = ''): Totals {
    let t: Totals = { inTok: 0, cacheTok: 0, outTok: 0 }
    for (const s of sessions) t = addTotals(t, totalsInWindow(s.perDay, fromDay, toDay))
    return t
}

// ─────────────────────────── helpers ─────────────────────────────────────────

/** Fold a parsed chunk's buckets/metadata into a cache entry (shared by all
 *  NDJSON agents; cumul is applied by the caller for running-total agents). */
function applyChunk (
    entry: FileEntry,
    r: { perDay: PerDay; turns: number; lastTs: number; project: string; sessionId: string },
): void {
    mergePerDay(entry.perDay, r.perDay)
    entry.turns += r.turns
    if (r.lastTs > entry.lastActive) entry.lastActive = r.lastTs
    if (r.project && !entry.project) entry.project = r.project
    if (r.sessionId && !entry.sessionId) entry.sessionId = r.sessionId
}

function num (v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

/** Running-total delta. A drop (cur < prev) means the cumulative reset (a new
 *  sub-conversation / context reset) — attribute the new value as the delta
 *  rather than clamping to 0 (which would silently drop all post-reset usage). */
function delta (cur: number, prev: number): number { return cur >= prev ? cur - prev : cur }

function homeDir (): string { return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir() }
function glanceDir (): string { return path.join(homeDir(), '.glanceterm') }

async function safeReaddir (dir: string): Promise<string[]> {
    try { return await fs.readdir(dir) } catch { return [] }
}

/** Recursively collect files under `dir` (Codex's YYYY/MM/DD tree), best-effort. */
async function walkJsonl (dir: string, onFile: (p: string) => void): Promise<void> {
    let entries: import('fs').Dirent[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) await walkJsonl(full, onFile)
        else onFile(full)
    }
}
