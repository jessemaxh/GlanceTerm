import { Injectable, OnDestroy } from '@angular/core'
import { Observable, Subject, Subscription } from 'rxjs'

import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TabMonitor, TabState } from 'tabby-plugin-ai-sidebar'

import type { TranscriptEvent } from './tailer.service'

/**
 * Best-effort "what did the agent just say" source for line-mode AI
 * agents — opt-in via the `GLANCETERM_PTY_MIRROR=1` environment variable
 * because the v1 implementation has a fundamental limitation that makes
 * it useless for the agents most users care about.
 *
 * **Why it's opt-in:** modern interactive AI agents (Codex, Aider,
 * Goose, Claude Code's TUI) run the terminal in raw mode + alt-screen
 * and rewrite the entire visible region on every keystroke. The PTY
 * output stream is the post-redraw screen content, NOT the agent's
 * logical reply text. ANSI-stripping that stream gives you the input
 * prompt + status bar + syntax-highlighted command + assistant reply
 * all flattened into one unreadable blob.
 *
 * For Claude, use {@link TranscriptTailerService} which reads the
 * structured jsonl. For Codex / Aider / Goose / future agents, the
 * right answer is a per-agent adapter that knows the transcript file
 * shape — those don't exist yet (see Block 4 of
 * docs/todo-mobile-bridge-v2.md).
 *
 * The code stays in-tree as a fallback for line-mode tools that DON'T
 * use alt-screen (rare but exist — simple chat shells, single-shot
 * agents) and as a starting point for the per-agent work. Set
 * `GLANCETERM_PTY_MIRROR=1` to enable; expect noisy output on any
 * proper TUI.
 *
 * Per enabled tab:
 *   1. Subscribe to the inner session's `output$`
 *   2. ANSI-strip + collapse control chars
 *   3. Debounce 1.2 s so a redraw burst lands as one event
 *   4. Emit accumulated buffer as `assistant_text` TranscriptEvent
 *
 * Tap scope: tabs whose `aiTool` is defined AND not 'claude'. Claude
 * has its own structured path; raw shells (`aiTool` undefined) would
 * stream `ls` output to the phone.
 */
@Injectable()
export class PtyTailerService implements OnDestroy {
    /** Quiet window before a chunk is considered "settled" and emitted.
     *  Lower = chatter; higher = laggy. 1.2 s is roughly Claude's natural
     *  inter-token gap during a streaming reply. */
    private static readonly DEBOUNCE_MS = 1_200
    /** Per-event size cap. Lark / Telegram both choke around 4 KB
     *  per chat bubble; we cap a touch tighter so the truncation
     *  marker fits within their respective rate-limit budgets. */
    private static readonly MAX_BYTES_PER_EVENT = 3_500

    private readonly subject = new Subject<TranscriptEvent>()
    readonly events$: Observable<TranscriptEvent> = this.subject.asObservable()

    /** Per-tab tap state. Key = tabId (the GLANCETERM_TAB_ID UUID). */
    private readonly taps = new Map<string, TapState>()
    private readonly subs: Subscription[] = []
    /** Frozen at construct time so a runtime env change doesn't half-flip
     *  the subscription state. Restart GlanceTerm to toggle. */
    private readonly enabled = process.env.GLANCETERM_PTY_MIRROR === '1'

    constructor (private monitor: TabMonitor) {
        if (!this.enabled) {
            // Opt-out is the default — log once so a user expecting it
            // ON notices and can flip the env var. Logging at construct
            // time means the message lands in the dev-tools console
            // shortly after launch, when the user is looking.
            // eslint-disable-next-line no-console
            console.log(
                '[mobile-bridge:pty-tailer] disabled (default). '
                + 'Set GLANCETERM_PTY_MIRROR=1 to enable raw PTY mirror '
                + 'for non-Claude agents — expect noisy output on alt-screen TUIs.',
            )
            return
        }
        // eslint-disable-next-line no-console
        console.log('[mobile-bridge:pty-tailer] enabled via GLANCETERM_PTY_MIRROR=1')
        this.subs.push(this.monitor.states$.subscribe(states => this.reconcile(states)))
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
        // App shutdown — drop pending buffers; we won't be around to
        // send them anyway.
        for (const t of this.taps.values()) this.teardownTap(t, /* drop */ true)
        this.taps.clear()
    }

    /**
     * Reconcile observed tab states against tracked taps. A tab earns a
     * tap when:
     *   - its `aiTool` is set (some agent is running)
     *   - its `aiTool` is NOT 'claude' (TranscriptTailer owns Claude)
     *   - its innerTab is a BaseTerminalTabComponent (we need session)
     *   - its session has a `glancetermTabId` env id (so the dispatcher
     *     can correlate back to the sidebar's identity / topic cache)
     *
     * Any of those conditions failing means we tear down the tap if we
     * had one. Re-evaluated on every states$ emission — cheap because
     * the inner Map lookups are O(1) and tab counts are tiny.
     */
    private reconcile (states: TabState[]): void {
        const seen = new Set<string>()
        for (const state of states) {
            const tabId = this.tabIdOf(state)
            if (!tabId) continue
            const shouldTap = this.shouldTap(state)
            if (shouldTap) {
                seen.add(tabId)
                if (!this.taps.has(tabId)) {
                    this.setupTap(tabId, state)
                }
            } else if (this.taps.has(tabId)) {
                // aiTool transitioned away (e.g. 'codex' → 'claude'). Drop
                // the pending buffer entirely — flushing it would emit a
                // PTY-sourced event tagged with the now-Claude tabId,
                // which the dispatcher would route to the Claude topic
                // even though the content is raw PTY noise.
                const t = this.taps.get(tabId)!
                this.teardownTap(t, /* drop */ true)
                this.taps.delete(tabId)
            }
        }
        // Tabs that disappeared from states$ entirely (closed): final
        // flush so an in-flight burst isn't lost on tab close.
        for (const [tabId, t] of [...this.taps]) {
            if (!seen.has(tabId)) {
                this.teardownTap(t, /* drop */ false)
                this.taps.delete(tabId)
            }
        }
    }

    private shouldTap (state: TabState): boolean {
        if (!state.aiTool) return false
        if (state.aiTool === 'claude') return false
        if (!(state.innerTab instanceof BaseTerminalTabComponent)) return false
        return true
    }

    private tabIdOf (state: TabState): string | null {
        const session = (state.innerTab as unknown as { session?: { glancetermTabId?: string } }).session
        return session?.glancetermTabId ?? null
    }

    private setupTap (tabId: string, state: TabState): void {
        const session = (state.innerTab as unknown as {
            session?: { output$?: Observable<string> }
        }).session
        if (!session?.output$) return

        const tap: TapState = {
            tabId,
            buffer: '',
            debounceTimer: null,
            sub: null,
        }
        tap.sub = session.output$.subscribe(chunk => {
            const cleaned = stripAnsiAndControls(chunk)
            if (!cleaned) return
            tap.buffer += cleaned
            // Cap buffer to MAX_BYTES_PER_EVENT*2 so a runaway logger
            // doesn't grow memory unbounded between debounces. Truncate
            // from the FRONT — the tail is what the user cares about
            // (the most recent agent output).
            if (tap.buffer.length > PtyTailerService.MAX_BYTES_PER_EVENT * 2) {
                tap.buffer = tap.buffer.slice(-PtyTailerService.MAX_BYTES_PER_EVENT * 2)
            }
            if (tap.debounceTimer) clearTimeout(tap.debounceTimer)
            tap.debounceTimer = setTimeout(() => {
                tap.debounceTimer = null
                this.flush(tap)
            }, PtyTailerService.DEBOUNCE_MS)
        })
        this.taps.set(tabId, tap)
    }

    private teardownTap (tap: TapState, drop: boolean): void {
        if (tap.debounceTimer) clearTimeout(tap.debounceTimer)
        tap.sub?.unsubscribe()
        if (drop) {
            // aiTool oscillation tear-down. Pending buffer would mis-route
            // if flushed — discard.
            tap.buffer = ''
            return
        }
        // Tab-close tear-down. Flush whatever's left so a burst in flight
        // when the user closes the tab isn't dropped.
        if (tap.buffer.trim().length > 0) this.flush(tap)
    }

    private flush (tap: TapState): void {
        const trimmed = tap.buffer.trim()
        tap.buffer = ''
        if (!trimmed) return
        const text = trimmed.length > PtyTailerService.MAX_BYTES_PER_EVENT
            ? trimmed.slice(-PtyTailerService.MAX_BYTES_PER_EVENT)
                + `\n…(${trimmed.length - PtyTailerService.MAX_BYTES_PER_EVENT} chars truncated)`
            : trimmed
        this.subject.next({ tabId: tap.tabId, kind: 'assistant_text', text })
    }
}

interface TapState {
    tabId: string
    buffer: string
    debounceTimer: ReturnType<typeof setTimeout> | null
    sub: Subscription | null
}

/**
 * Strip ANSI escape sequences and bare control characters from a raw
 * terminal output chunk. Keeps newlines (those carry semantic meaning
 * in the chat bubble) and printable bytes.
 *
 * Patterns covered (in priority order):
 *   - CSI / SGR escapes: `\x1b[ ... letter` (colours, cursor, etc.)
 *   - OSC sequences: `\x1b]...\x07` or `\x1b]...\x1b\\`  (window title etc.)
 *   - Other ESC-introduced: `\x1b<single-char>` (charset switch, RI, etc.)
 *   - Bare backspace / carriage-return clusters that don't survive in a
 *     non-terminal context — collapsed.
 *
 * We deliberately don't pull in `strip-ansi` (npm pkg) — adds ~30 KB
 * to the bundle for what's ~40 lines of regex. The bot doesn't need
 * paranoid coverage; truncating a stray byte is fine.
 */
function stripAnsiAndControls (s: string): string {
    return s
        // CSI sequences: ESC [ ... <final byte 0x40-0x7E>
        .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
        // OSC sequences: ESC ] ... BEL (0x07) or ESC \
        .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, '')
        // Other ESC + single char (charset, single-shift, etc.)
        .replace(/\x1b[@-Z\\-_]/g, '')
        // Carriage returns without newline → collapse (terminal-only redraw)
        .replace(/\r(?!\n)/g, '')
        // Bare backspaces — rare outside line editing
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}
