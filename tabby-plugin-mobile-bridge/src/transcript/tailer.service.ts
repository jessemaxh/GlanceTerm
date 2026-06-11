import { Injectable, OnDestroy } from '@angular/core'
import { Subject, Subscription } from 'rxjs'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'

import { HookSnapshot, HookWatcherService } from 'tabby-plugin-ai-sidebar'

/**
 * Single canonical view of what Claude said and did, sourced from
 * `~/.claude/projects/<slug>/<sessionId>.jsonl` — the same transcript
 * Claude Code writes for its own resume / context replay path.
 *
 * Why not hook events: hooks surface state transitions and tool *calls*,
 * but NOT assistant text. To match Claude's official Remote Control UX
 * ("see what Claude is saying on your phone"), we have to read the
 * transcript directly. The jsonl already serialises both `text` and
 * `tool_use` blocks per assistant turn, so one source covers everything
 * we want to forward.
 *
 * Cost: a 2s polling tail per active tab. fs.watch on .jsonl appends is
 * unreliable on macOS (Tabby has its own observed misses), so polling is
 * the simple, robust choice. Reads only the new bytes since the last
 * offset, so the per-tick disk cost is proportional to JUST what Claude
 * wrote in the window — usually a handful of KB or zero.
 *
 * We start each tail at the file's current EOF — replaying every prior
 * message into the Telegram topic on first activation would spam dozens
 * of historical messages from before the binding existed. The contract
 * is "you see what happens FROM NOW", consistent with the official
 * Remote Control "fresh subscription" model.
 */

export type TranscriptEvent =
    | { tabId: string; kind: 'assistant_text'; text: string }
    | { tabId: string; kind: 'tool_use'; toolName: string; summary: string }

const POLL_MS = 2_000

interface TailState {
    filePath: string
    /** Byte offset of the next unread byte. Mirrors HookWatcher's tailOffset
     *  pattern — same robustness against append-only file growth. */
    offset: number
    /** Buffer for a partial last line that arrived mid-write — joined to the
     *  next chunk before parsing. Without this, a Claude write that lands
     *  between our reads can split one JSON line across two polls and both
     *  halves fail JSON.parse. */
    leftover: string
    /** Re-entrancy guard. setInterval fires on a wall-clock cadence and does
     *  not await the previous tick's pollOne — on a slow disk, sleeping
     *  Mac, or many tabs, a tick can take >2 s and the next one will enter
     *  with the same `offset` before the previous write has committed,
     *  double-emitting the same JSON lines as Telegram messages. We skip
     *  re-entry instead of queueing: the next tick that lands AFTER the
     *  busy one finishes will see the up-to-date offset and process any
     *  new bytes. Worst case is a 2 s pause — acceptable for a chat-feed. */
    polling: boolean
}

@Injectable()
export class TranscriptTailerService implements OnDestroy {
    private readonly subject = new Subject<TranscriptEvent>()
    readonly events$ = this.subject.asObservable()

    /** Per-tab tail state. Key = tabId (the GLANCETERM_TAB_ID UUID). */
    private readonly tails = new Map<string, TailState>()

    private readonly subs: Subscription[] = []
    private timer: ReturnType<typeof setInterval> | null = null

    constructor (private hooks: HookWatcherService) {
        this.subs.push(this.hooks.snapshots$.subscribe(map => void this.reconcile(map)))
        // Single timer drives all tails to amortise the wake-up cost. If
        // 100 tabs are active, this is one timer firing every 2s, not 100
        // independent timers fighting the event loop.
        this.timer = setInterval(() => void this.pollAll(), POLL_MS)
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
        if (this.timer) clearInterval(this.timer)
    }

    /**
     * Reconcile observed sessions against tracked tails. For each tab in
     * the latest snapshot:
     *   - If we have no tail and the snapshot has (sessionId, cwd), open a
     *     fresh tail starting at the file's current EOF.
     *   - If we have a tail but its path differs (session id changed because
     *     Claude was restarted in the same tab), repoint it at the new file
     *     starting at EOF.
     *
     * We deliberately DO NOT remove a tab's tail when its snapshot momentarily
     * drops out of the map — Claude's SessionEnd / process death can leave the
     * snapshot in a transient state, and the next snapshot tick brings it
     * back. Leaving the tail running is cheap (stale path → fs.stat ENOENT →
     * skip) and avoids losing the few KB of tail-end output written between
     * SessionEnd and tab close.
     */
    private async reconcile (snapshots: Map<string, HookSnapshot>): Promise<void> {
        for (const [tabId, snap] of snapshots) {
            // Prefer the authoritative path from Claude's hook payload —
            // when the agent has cd'd into a subdir, the cwd-derived slug
            // points to a non-existent directory (Claude anchors the
            // transcript at the dir where it was launched, not the agent's
            // current cwd). Fall back to slug reconstruction only when the
            // hook didn't carry transcript_path (pre-feature log lines,
            // future non-Claude agents we add adapters for).
            let expectedPath: string | null = snap.transcriptPath
            if (!expectedPath) {
                if (!snap.sessionId || !snap.cwd) continue
                expectedPath = this.transcriptPath(snap.cwd, snap.sessionId)
            }
            const existing = this.tails.get(tabId)
            if (existing && existing.filePath === expectedPath) continue
            let offset = 0
            try {
                const stat = await fs.stat(expectedPath)
                offset = stat.size
            } catch {
                // File doesn't exist yet — Claude hasn't written its first
                // message of this session. Skip; next snapshot tick re-tries.
                continue
            }
            this.tails.set(tabId, { filePath: expectedPath, offset, leftover: '', polling: false })
        }
    }

    private async pollAll (): Promise<void> {
        for (const [tabId, state] of this.tails) {
            // Skip a busy tail rather than queueing — see TailState.polling.
            if (state.polling) continue
            state.polling = true
            // Catch per-tab so one corrupt transcript can't take down every
            // other tab's tail in the same poll cycle. The .finally clears
            // the guard whether the poll succeeded, threw, or was rejected.
            void this.pollOne(tabId, state)
                .catch(err => {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:transcript] tail error for', tabId, err)
                })
                .finally(() => {
                    state.polling = false
                })
        }
    }

    private async pollOne (tabId: string, state: TailState): Promise<void> {
        let stat: fsSync.Stats
        try { stat = await fs.stat(state.filePath) } catch { return }
        if (stat.size < state.offset) {
            // External truncation / rotation — same response shape as
            // HookWatcher: reset offset and re-read from the new start.
            state.offset = 0
            state.leftover = ''
        }
        if (stat.size === state.offset) return

        const length = stat.size - state.offset
        const fd = await fs.open(state.filePath, 'r')
        let chunk: string
        try {
            const buf = Buffer.alloc(length)
            await fd.read(buf, 0, length, state.offset)
            chunk = buf.toString('utf8')
        } finally {
            await fd.close()
        }
        state.offset = stat.size

        const text = state.leftover + chunk
        let lineStart = 0
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 0x0A /* \n */) {
                const line = text.slice(lineStart, i)
                if (line.length > 0) this.emitLine(tabId, line)
                lineStart = i + 1
            }
        }
        // Whatever's after the last \n is a partial line — carry to next tick.
        state.leftover = text.slice(lineStart)
    }

    private emitLine (tabId: string, line: string): void {
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { return }
        if (typeof parsed !== 'object' || parsed === null) return
        const obj = parsed as Record<string, unknown>
        if (obj.type !== 'assistant') return
        const message = obj.message as Record<string, unknown> | undefined
        const content = message?.content
        if (!Array.isArray(content)) return
        for (const blockRaw of content) {
            const block = blockRaw as Record<string, unknown>
            const bt = block.type
            if (bt === 'text') {
                const txt = block.text
                if (typeof txt === 'string' && txt.trim().length > 0) {
                    this.subject.next({ tabId, kind: 'assistant_text', text: txt.trim() })
                }
            } else if (bt === 'tool_use') {
                const name = block.name
                if (typeof name !== 'string') continue
                const input = (block.input ?? {}) as Record<string, unknown>
                this.subject.next({
                    tabId,
                    kind: 'tool_use',
                    toolName: name,
                    summary: summarizeToolInput(name, input),
                })
            }
            // 'thinking' blocks and other block types are deliberately not
            // forwarded — extended-thinking text is verbose and not part of
            // the user-visible conversation.
        }
    }

    /**
     * `cwd` → `~/.claude/projects/` slug. Claude Code's slugger replaces
     * every `/` with `-` and preserves the leading `/` as a `-`. Verified
     * against the live directory layout under `~/.claude/projects/` —
     * e.g. `/Users/you/work/myproject` → `-Users-you-work-myproject`.
     *
     * Claude's slugger also has rules around dots and other special chars
     * that we don't model here — the simple replace covers the path shapes
     * a typical user's git checkouts produce (alphanumerics + `/` + `-`
     * + `_`). If a path with `.` or other oddities mis-slugs, we'll see
     * an ENOENT on first stat and just skip that session's transcript —
     * worst case is "no message text on phone for that tab," which is
     * the same failure mode as not having the feature at all.
     */
    private transcriptPath (cwd: string, sessionId: string): string {
        const slug = cwd.replace(/\//g, '-')
        return path.join(os.homedir(), '.claude', 'projects', slug, sessionId + '.jsonl')
    }
}

/**
 * One-line summary of a tool call for the phone notification. Lives at
 * module scope so it's pure / unit-testable.
 *
 * Output deliberately short — Telegram chat lines are read at a glance,
 * not studied. Long file paths get truncated to keep the line scannable.
 */
function summarizeToolInput (name: string, input: Record<string, unknown>): string {
    const str = (k: string): string => typeof input[k] === 'string' ? input[k] as string : ''
    const trunc = (s: string, n: number): string => s.length > n ? s.slice(0, n - 1) + '…' : s
    if (name === 'Bash') return trunc(str('command'), 100)
    if (name === 'Read' || name === 'Edit' || name === 'Write'
        || name === 'MultiEdit' || name === 'NotebookEdit') {
        return trunc(str('file_path'), 100)
    }
    if (name === 'Glob' || name === 'Grep') return trunc(str('pattern'), 80)
    if (name === 'WebFetch') return trunc(str('url'), 100)
    if (name === 'WebSearch') return trunc(str('query'), 80)
    if (name === 'Task' || name === 'Agent') {
        return trunc(str('description') || str('subagent_type'), 80)
    }
    if (name === 'TodoWrite') return ''
    return ''
}

/** Exported for unit-test reach without standing up the service. */
export const __test = { summarizeToolInput }
