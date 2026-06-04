import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { AppService, BaseTabComponent } from 'tabby-core'

const POLL_MS = 1000
/** A claude is "working" if its transcript file was touched within this window. */
const ACTIVE_WINDOW_MS = 2_000

export type TabStatus = 'working' | 'idle' | 'no_ai'

/** AI CLI tools we recognize. Add more by extending AI_PATTERNS below. */
export type AiTool = 'claude' | 'codex' | 'opencode' | 'aider'

/**
 * How we identify each AI CLI by its command line. We match the *real*
 * command line (read via `ps`) because Tabby's getChildProcesses().command
 * sometimes contains the tool's version string instead of the executable
 * name (e.g. "2.1.162" instead of "claude").
 *
 * `\b...(\s|$)` lets us catch the bare name at the end of a path
 * (e.g. `/Users/foo/.local/bin/claude`) and at the start of an argv
 * sequence (e.g. `aider --model gpt-4`).
 */
const AI_PATTERNS: Array<{ tool: AiTool; regex: RegExp }> = [
    { tool: 'claude',   regex: /\bclaude(\s|$)/ },
    { tool: 'codex',    regex: /\bcodex(\s|$)/ },
    { tool: 'opencode', regex: /\bopencode(\s|$)/ },
    { tool: 'aider',    regex: /\baider(\s|$)/ },
]

export interface TabState {
    /** Outer tab in app.tabs[]. Pass to AppService.selectTab() to focus. */
    outerTab: BaseTabComponent
    /** Inner tab (= outerTab unless it's inside a split). */
    innerTab: BaseTabComponent
    /** What the user sees in the top tab bar — used as our row label. */
    title: string
    /** Resolved once per tab via async getTruePID(); used for trackBy/debug only. */
    shellPid: number | null
    /** Which AI tool we detected running, if any. */
    aiTool: AiTool | null
    /** The descendant AI process pid, if there is one. */
    aiPid: number | null
    /** Whichever heuristic determined activity, copied for debugging. */
    status: TabStatus
    /** Best-effort cwd of the shell session (used to locate transcript dir). */
    cwd: string | null
    /** Claude session UUID (= jsonl basename) if we found one. */
    sessionId: string | null
    /** ms since we last saw transcript activity, for "Xs ago" labels. */
    lastActiveMs: number | null
}

interface ChildProcessInfo { pid: number; ppid: number; command: string }

/**
 * Polls Tabby tab state once per second to produce a TabState for every
 * terminal tab. Uses Tabby's own `session.getChildProcesses()` instead of
 * shelling out to `ps` — that's the same data path Tabby uses internally
 * and is consistent with what node-pty knows.
 */
@Injectable({ providedIn: 'root' })
export class TabMonitor implements OnDestroy {
    private subject = new BehaviorSubject<TabState[]>([])
    private timer?: NodeJS.Timeout
    private busy = false
    /** Shell PID cache (getTruePID is async; resolve once per tab). */
    private shellPidCache = new WeakMap<BaseTabComponent, number>()
    /** CPU-time samples for AI processes, used to detect "working" via delta. */
    private cpuTimeCache = new Map<number, { cpuSec: number; sampledAt: number }>()

    readonly states$: Observable<TabState[]> = this.subject.asObservable()

    constructor (private app: AppService) {
        // Fire immediately, then poll. void-ignore the Promise since we run on a timer.
        void this.tick()
        this.timer = setInterval(() => { void this.tick() }, POLL_MS)
    }

    ngOnDestroy (): void {
        if (this.timer) {
            clearInterval(this.timer)
        }
    }

    private async tick (): Promise<void> {
        if (this.busy) return
        this.busy = true
        try {
            const tabs = this.collectTerminalTabs()
            // Cap concurrency to keep the renderer responsive even with 30+ tabs.
            const out: TabState[] = []
            const CHUNK = 8
            for (let i = 0; i < tabs.length; i += CHUNK) {
                const chunk = tabs.slice(i, i + CHUNK)
                const results = await Promise.all(chunk.map(t => this.safeMakeState(t)))
                for (const r of results) if (r) out.push(r)
            }
            this.gcCpuCache(out)
            this.subject.next(out)
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[ai-sidebar] tick failed:', e)
        } finally {
            this.busy = false
        }
    }

    private async safeMakeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): Promise<TabState | null> {
        try {
            return await this.makeState(t)
        } catch (e) {
            // Per-tab failure shouldn't kill the whole sidebar.
            // eslint-disable-next-line no-console
            console.error('[ai-sidebar] makeState failed for tab:', t.outer?.title, e)
            return null
        }
    }

    private async makeState (
        t: { outer: BaseTabComponent; inner: BaseTabComponent },
    ): Promise<TabState | null> {
        const sess: any = (t.inner as any).session
        if (!sess || typeof sess.getChildProcesses !== 'function') {
            return null // not a terminal tab (settings, plugin tabs, etc.)
        }

        // 1. Cache shell PID (only needed for display).
        let shellPid = this.shellPidCache.get(t.inner) ?? null
        if (shellPid === null) {
            try {
                const pid = await sess.pty?.getTruePID?.()
                if (typeof pid === 'number' && pid > 0) {
                    shellPid = pid
                    this.shellPidCache.set(t.inner, pid)
                }
            } catch { /* swallow */ }
        }

        // 2. Direct list of child processes from Tabby (same data path Tabby uses).
        //    Tabby's `command` field is unreliable — for `claude` it returns
        //    the *version string* ("2.1.162"), not the executable name. Re-read
        //    the real command line via `ps` using the pids Tabby gave us.
        let children: ChildProcessInfo[] = []
        try {
            children = await sess.getChildProcesses() ?? []
        } catch { /* swallow */ }
        const realCmds = realCommandsFor(children.map(c => c.pid))

        // 3. Walk children, find first matching AI tool.
        let aiTool: AiTool | null = null
        let aiPid: number | null = null
        for (const c of children) {
            const real = realCmds.get(c.pid) ?? c.command
            const match = AI_PATTERNS.find(p => p.regex.test(real))
            if (match) {
                aiTool = match.tool
                aiPid = c.pid
                break
            }
        }

        // 4. cwd: prefer reportedCWD (cheap), fall back to getWorkingDirectory.
        let cwd: string | null = typeof sess.reportedCWD === 'string' && sess.reportedCWD
            ? sess.reportedCWD
            : null
        if (!cwd && typeof sess.getWorkingDirectory === 'function') {
            try { cwd = await sess.getWorkingDirectory() } catch { /* swallow */ }
        }

        // 5. Activity probe — tool-specific.
        let status: TabStatus = 'no_ai'
        let sessionId: string | null = null
        let lastActiveMs: number | null = null
        if (aiTool === 'claude') {
            const probe = probeTranscriptActivity(cwd)
            sessionId = probe.sessionId
            lastActiveMs = probe.ageMs
            status = probe.ageMs !== null && probe.ageMs < ACTIVE_WINDOW_MS
                ? 'working'
                : 'idle'
        } else if (aiTool && aiPid !== null) {
            // For non-claude tools, use CPU-time delta to distinguish working
            // from idle. We sample `ps -o time=` once per poll and compare
            // against the previous sample.
            status = this.probeCpuActivity(aiPid)
        }

        return {
            outerTab: t.outer,
            innerTab: t.inner,
            title: t.outer.customTitle || t.outer.title || `(tab ${shellPid ?? '?'})`,
            shellPid,
            aiTool,
            aiPid,
            cwd,
            status,
            sessionId,
            lastActiveMs,
        }
    }

    private probeCpuActivity (pid: number): TabStatus {
        const now = Date.now()
        const cur = cpuSecondsOf(pid)
        const prev = this.cpuTimeCache.get(pid)
        this.cpuTimeCache.set(pid, { cpuSec: cur, sampledAt: now })
        if (cur < 0 || !prev) {
            return 'idle'
        }
        const wallElapsedMs = now - prev.sampledAt
        const cpuDelta = cur - prev.cpuSec
        // If the process burned >2% of wall time in CPU during this window,
        // treat as working. Threshold tuned by hand for `aider` / `codex`.
        return cpuDelta * 1000 / Math.max(wallElapsedMs, 1) > 0.02
            ? 'working'
            : 'idle'
    }

    private gcCpuCache (states: TabState[]): void {
        const alive = new Set<number>()
        for (const s of states) {
            if (s.aiPid !== null) alive.add(s.aiPid)
        }
        for (const pid of this.cpuTimeCache.keys()) {
            if (!alive.has(pid)) this.cpuTimeCache.delete(pid)
        }
    }

    private collectTerminalTabs (): Array<{ outer: BaseTabComponent; inner: BaseTabComponent }> {
        const out: Array<{ outer: BaseTabComponent; inner: BaseTabComponent }> = []
        for (const outer of this.app.tabs) {
            if (isSplit(outer)) {
                const leaves = outer.getAllTabs()
                if (leaves.length === 0) {
                    continue // restored placeholder, no real terminal yet
                }
                for (const inner of leaves) {
                    out.push({ outer, inner })
                }
            } else {
                out.push({ outer, inner: outer })
            }
        }
        return out
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Duck-typed split detection. We can't use `instanceof SplitTabComponent`:
 * plugin and Tabby load tabby-core via separate module realms, so the class
 * reference our `import` resolves to is NOT the same constructor that Tabby
 * actually constructed the tab with → `instanceof` is always false. Checking
 * for the public `getAllTabs()` method is the reliable substitute.
 */
function isSplit (t: any): t is { getAllTabs(): BaseTabComponent[] } {
    return t && typeof t.getAllTabs === 'function'
}

/**
 * One `ps` call to get the real command line for a batch of pids.
 * Used to work around Tabby's getChildProcesses returning bogus `command`
 * values (e.g. the version string `2.1.162` for the `claude` CLI).
 */
function realCommandsFor (pids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    if (pids.length === 0) return out
    try {
        const psOut = execSync(`ps -p ${pids.join(',')} -o pid=,command=`, {
            encoding: 'utf8',
            timeout: 500,
        })
        for (const line of psOut.split('\n')) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/)
            if (m) out.set(parseInt(m[1], 10), m[2].trim())
        }
    } catch { /* swallow */ }
    return out
}

/**
 * Cumulative CPU seconds consumed by the given pid. Format from `ps -o time=`:
 * `MM:SS.HH` (or `HH:MM:SS` for processes that have used > 60min CPU).
 * Returns -1 on lookup failure.
 */
function cpuSecondsOf (pid: number): number {
    try {
        const out = execSync(`ps -p ${pid} -o time=`, {
            encoding: 'utf8',
            timeout: 300,
        }).trim()
        return parsePsTime(out)
    } catch {
        return -1
    }
}

function parsePsTime (s: string): number {
    // Accept formats:  "MM:SS.HH" | "HH:MM:SS.HH" | "D-HH:MM:SS"
    let days = 0
    if (s.includes('-')) {
        const [d, rest] = s.split('-', 2)
        days = parseInt(d, 10) || 0
        s = rest
    }
    const parts = s.split(':')
    if (parts.length === 2) {
        // MM:SS(.HH)
        return parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
    }
    if (parts.length === 3) {
        return days * 86400 + parseInt(parts[0], 10) * 3600
            + parseInt(parts[1], 10) * 60 + parseFloat(parts[2])
    }
    return -1
}

/**
 * Find the most recently modified `.jsonl` under the Claude projects dir
 * matching this cwd. Returns its age (ms) and the session id.
 *
 * Claude encodes cwd as `/Users/foo/bar` → `-Users-foo-bar`.
 */
function probeTranscriptActivity (
    cwd: string | null,
): { ageMs: number | null; sessionId: string | null } {
    if (!cwd) return { ageMs: null, sessionId: null }
    const encoded = cwd.replace(/\//g, '-')
    const dir = path.join(os.homedir(), '.claude', 'projects', encoded)
    let bestAgeMs: number | null = null
    let bestSession: string | null = null
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.jsonl')) continue
            try {
                const stat = fs.statSync(path.join(dir, f))
                const age = Date.now() - stat.mtimeMs
                if (bestAgeMs === null || age < bestAgeMs) {
                    bestAgeMs = age
                    bestSession = f.replace(/\.jsonl$/, '')
                }
            } catch { /* skip */ }
        }
    } catch { /* dir missing — no transcripts for this cwd */ }
    return { ageMs: bestAgeMs, sessionId: bestSession }
}
