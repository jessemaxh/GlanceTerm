import { Subscription } from 'rxjs'
import { BaseTabComponent } from 'tabby-core'

/**
 * Wraps one terminal tab and listens to the signals that actually tell us
 * what the AI inside it is doing right now:
 *
 *   - binaryOutput$    every chunk written to the PTY by the AI tool.
 *                      Streaming text, spinner ticks, tool-call results all
 *                      arrive here. If bytes arrived recently, the tool is
 *                      working — no further analysis needed.
 *   - frontend.bell$   `\x07` rang. Most AI tools ring on permission prompts
 *                      and/or task completion (system bell setting), so a
 *                      recent bell biases ambiguous quiet periods toward
 *                      "user attention needed".
 *   - frontend.input$  user keystrokes. Used to "clear" a stale bell flag —
 *                      once the user has typed since the bell, we know
 *                      they've already responded to whatever rang.
 *
 * Subscriptions are best-effort: a freshly constructed tab may not have its
 * `frontend` attached yet (Tabby builds it asynchronously). We retry on the
 * next snapshot() call until everything is wired, then stop checking.
 */
/** Sparkline window — 60 samples at 1 Hz = trailing 1 minute. */
const HISTORY_SIZE = 60

export class SessionWatcher {
    /** Wall-clock ms of the last byte chunk from the PTY. 0 = never. */
    private lastByteAt = 0
    /** Wall-clock ms of the last bell event. 0 = never. */
    private lastBellAt = 0
    /** Wall-clock ms of the last user keystroke. 0 = never. */
    private lastInputAt = 0
    /** Total bytes received over this session (used as a freshness counter). */
    private byteCount = 0

    /** Ring buffer of bytes-per-second samples for the v0.2 sparkline. */
    private byteHistory: number[] = []
    private lastSampleAt = 0
    private lastSampleBytes = 0

    private subs: Subscription[] = []
    private outputAttached = false
    private frontendAttached = false

    constructor (private tab: BaseTabComponent) {
        this.tryAttach()
    }

    /**
     * Idempotent: safe to call every tick. Picks up the output stream and
     * frontend signals as soon as Tabby has constructed them.
     */
    tryAttach (): void {
        const t = this.tab as any
        if (!this.outputAttached && t.binaryOutput$?.subscribe) {
            this.subs.push(t.binaryOutput$.subscribe((buf: Buffer | Uint8Array) => {
                this.lastByteAt = Date.now()
                this.byteCount += buf?.length ?? 0
            }))
            this.outputAttached = true
        }
        if (!this.frontendAttached && t.frontend?.bell$?.subscribe) {
            this.subs.push(t.frontend.bell$.subscribe(() => {
                this.lastBellAt = Date.now()
            }))
            if (t.frontend.input$?.subscribe) {
                this.subs.push(t.frontend.input$.subscribe(() => {
                    this.lastInputAt = Date.now()
                }))
            }
            this.frontendAttached = true
        }
    }

    /**
     * Returns the last ~40 *visible* terminal rows as a single string,
     * already rasterised by xterm.js (no ANSI escapes to strip).
     *
     * We read from `baseY` (top of the unscrolled viewport), NOT
     * `viewportY` — `viewportY` reflects where the user has scrolled to,
     * but we always want the latest screen state regardless of scroll
     * position. Reading lines from scrollback would also re-match old
     * "Working…" text from previous turns and pin status incorrectly.
     */
    readScreenTail (maxRows = 40): string {
        const xterm = (this.tab as any).frontend?.xterm
        if (!xterm?.buffer?.active) return ''
        const buf = xterm.buffer.active
        const rows: number = xterm.rows ?? 24
        // Window of "currently visible" rows, ignoring user scroll position.
        const startAbs = Math.max(0, buf.baseY)
        const endAbs = Math.min(buf.length ?? (startAbs + rows), startAbs + rows)
        // If the rows we care about are fewer than maxRows, that's fine —
        // early-session terminals may have very little content.
        const firstWanted = Math.max(startAbs, endAbs - maxRows)
        const out: string[] = []
        for (let i = firstWanted; i < endAbs; i++) {
            const line = buf.getLine(i)
            if (line) out.push(line.translateToString(true))
        }
        return out.join('\n')
    }

    /**
     * Push one bytes-per-second sample into the ring buffer. Call once per
     * TabMonitor tick (~1Hz). On the first call we just seed the baseline
     * — no sample yet, since we don't know the previous delta.
     */
    sample (now: number = Date.now()): void {
        if (this.lastSampleAt === 0) {
            this.lastSampleAt = now
            this.lastSampleBytes = this.byteCount
            return
        }
        const dtMs = now - this.lastSampleAt
        if (dtMs <= 0) return
        const dBytes = Math.max(0, this.byteCount - this.lastSampleBytes)
        const ratePerSec = dBytes * 1000 / dtMs
        this.byteHistory.push(ratePerSec)
        if (this.byteHistory.length > HISTORY_SIZE) {
            this.byteHistory.shift()
        }
        this.lastSampleAt = now
        this.lastSampleBytes = this.byteCount
    }

    /**
     * Clear the sparkline ring buffer so a follow-up tool's history starts
     * from scratch. Called by TabMonitor when it sees the same tab switch
     * from running tool A directly to tool B (no `no_ai` step between, so
     * the watcher is reused). Output byte timestamps are NOT reset — they
     * still meaningfully say "the PTY produced bytes at time X."
     */
    resetHistory (): void {
        this.byteHistory = []
        this.lastSampleAt = 0
        this.lastSampleBytes = this.byteCount
    }

    snapshot (): WatcherSnapshot {
        return {
            lastByteAt: this.lastByteAt,
            lastBellAt: this.lastBellAt,
            lastInputAt: this.lastInputAt,
            byteCount: this.byteCount,
            byteHistory: this.byteHistory.slice(),
        }
    }

    dispose (): void {
        for (const s of this.subs) s.unsubscribe()
        this.subs = []
        this.outputAttached = false
        this.frontendAttached = false
    }
}

export interface WatcherSnapshot {
    lastByteAt: number
    lastBellAt: number
    lastInputAt: number
    byteCount: number
    /** Trailing bytes-per-second samples, oldest first. Up to 60 entries. */
    byteHistory: number[]
}
