import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { AppService, ConfigService } from 'tabby-core'

import { TabMonitor, TabState, TabStatus } from './tab-monitor'
import { UnreadService } from './unread.service'

type NotifyKind = 'permission' | 'ready'

/**
 * Fires a system notification when an AI tab transitions into a state that
 * needs the user's attention:
 *
 *   - `needs_permission`      block-on-user prompt (claude y/n menu, etc.)
 *                             fires immediately on the transition.
 *   - `working` → `idle`      AI finished its turn. Also fires immediately —
 *                             the idle-stability gate lives upstream in
 *                             TabMonitor (see IDLE_STABILITY_MS there), so
 *                             by the time the transition reaches us the raw
 *                             hook layer has already been idle long enough
 *                             to be trustworthy.
 *
 * Both notifications are suppressed when the user is already looking at
 * the tab in question — the sidebar's coloured row is enough signal.
 * Clicking either notification focuses the originating tab and brings the
 * window forward.
 *
 * Tabs with non-AI status (`no_ai`) never notify.
 */
@Injectable({ providedIn: 'root' })
export class AttentionNotifierService implements OnDestroy {
    private prevStatus = new WeakMap<object, TabStatus>()
    private sub?: Subscription
    /** Skip the very first emission — every tab "transitions" into its first state. */
    private bootstrapped = false
    /**
     * Per-tab cooldown. AI tools occasionally redraw their permission UI
     * (the prompt line gets cleared and redrawn during fancy menus) and
     * that brief glitch reads to us as needs_permission → idle → needs_
     * permission within ~1 second. Without a cooldown each oscillation
     * fires (or replaces) a notification — at minimum a ding, at worst
     * three. 8s is long enough to absorb the worst flap I've seen, short
     * enough that a genuinely new prompt 10s after the first still notifies.
     */
    private lastFiredAt = new WeakMap<object, number>()
    private readonly COOLDOWN_MS = 8_000

    /**
     * Lazily-created Web Audio context for the working → done chime. Browsers
     * (and Electron) refuse to construct an AudioContext until the page has
     * received a user gesture, so we defer the constructor until the first
     * call to `playReadyChime`. Reused across all subsequent chimes.
     */
    private audio: AudioContext | null = null

    constructor (
        private app: AppService,
        private unread: UnreadService,
        private config: ConfigService,
        monitor: TabMonitor,
    ) {
        this.requestPermissionOnce()
        this.sub = monitor.states$.subscribe(states => this.diff(states))
    }

    ngOnDestroy (): void {
        this.sub?.unsubscribe()
        try { void this.audio?.close() } catch { /* swallow */ }
    }

    private requestPermissionOnce (): void {
        if (typeof Notification === 'undefined') return
        if (Notification.permission === 'default') {
            // Electron grants this automatically on most platforms — call
            // anyway so the promise is settled and any future state checks
            // get a concrete 'granted' or 'denied'.
            Notification.requestPermission().catch(() => { /* swallow */ })
        }
    }

    private diff (states: TabState[]): void {
        for (const s of states) {
            const key = s.innerTab as unknown as object
            const prev = this.prevStatus.get(key)
            this.prevStatus.set(key, s.status)

            if (!this.bootstrapped) continue
            if (prev === s.status) continue

            // Permission state: fire immediately.
            if (s.status === 'needs_permission' && prev !== 'needs_permission') {
                this.fire(s, 'permission')
                continue
            }

            // working → idle: fire immediately. The 3 s "is the agent really
            // done?" debounce lives upstream in TabMonitor's idle-stability
            // gate now, so any working → idle we see here has already been
            // stable in the hook layer for the gate duration.
            if (s.status === 'idle' && prev === 'working') {
                this.fire(s, 'ready')
            }
        }

        this.bootstrapped = true
    }

    /**
     * True if a TabState still corresponds to a tab in app.tabs — either as
     * a direct entry or as a leaf inside a SplitTabComponent. Used to drop
     * deferred notifications for tabs the user has closed in the meantime.
     */
    private isStillLive (s: TabState): boolean {
        return this.app.tabs.some(t =>
            t === s.outerTab ||
            (typeof (t as any).getAllTabs === 'function' &&
             (t as any).getAllTabs().includes(s.innerTab)),
        )
    }

    private fire (s: TabState, kind: NotifyKind): void {
        // Tab might have been closed between schedule() and fire() — the
        // 3-second ready debounce is the longest window. Notifying about a
        // dead tab is just misleading (click → selectTab no-op) so drop it.
        if (!this.isStillLive(s)) return

        // Already looking at this tab — sidebar dot is enough, don't bother.
        const isLookingHere =
            s.outerTab === this.app.activeTab &&
            typeof document !== 'undefined' &&
            document.hasFocus()
        if (isLookingHere) return

        // Persistent badge for ready transitions runs BEFORE the OS-notification
        // guards (Notification API gating, cooldown) — those gate audible/
        // visible system pings, but the in-app badge should appear even when
        // a transient ping is suppressed. Idempotent on repeat calls.
        if (kind === 'ready') {
            this.unread.markReady(s.innerTab)
            // Chime gates on its own throttle, independent of the notification
            // cooldown — losing the audio cue because the OS notification was
            // deduped defeats the point. Setting toggle is checked inside.
            this.playReadyChime()
        }

        if (typeof Notification === 'undefined') return
        if ((Notification as any).permission === 'denied') return

        // Cooldown — see field doc on `lastFiredAt`.
        const key = s.innerTab as unknown as object
        const last = this.lastFiredAt.get(key) ?? 0
        const now = Date.now()
        if (now - last < this.COOLDOWN_MS) return
        this.lastFiredAt.set(key, now)

        const title = kind === 'permission'
            ? 'GlanceTerm — agent needs you'
            : 'GlanceTerm — agent ready'
        const subline = kind === 'permission'
            ? 'permission required'
            : 'ready for next prompt'

        try {
            const n = new Notification(title, {
                body: `${s.title}${s.aiTool ? ' · ' + s.aiTool : ''} — ${subline}`,
                silent: false,
                tag: `glanceterm-attn-${(s.innerTab as any).id ?? Math.random()}`,
            })
            n.onclick = () => {
                this.app.selectTab(s.outerTab)
                if (s.outerTab !== s.innerTab && typeof (s.outerTab as any).focus === 'function') {
                    try { (s.outerTab as any).focus(s.innerTab) } catch { /* */ }
                }
                if (typeof window !== 'undefined' && typeof window.focus === 'function') {
                    window.focus()
                }
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[ai-sidebar] notification failed:', e)
        }
    }

    /**
     * Last time we played the working → done chime, in monotonic-ish ms.
     * Independent of `lastFiredAt` (per-tab notification cooldown) — the
     * speaker doesn't care which tab finished; back-to-back chimes from
     * different tabs landing within 600 ms read as one garbled noise rather
     * than two distinct events. 600 ms is roughly the chime's own length
     * (180 ms first note + 180 ms second + decay tail), so the throttle
     * lets each chime fully finish before the next starts.
     */
    private lastChimeAt = 0
    private readonly CHIME_THROTTLE_MS = 600

    /**
     * Short two-note chime — A5 → E6, ~180 ms each, ramped envelope so it
     * sounds like a soft bell rather than a beep. Generated via Web Audio
     * so we don't ship a sound asset (and so the user can't desync the
     * file from the bundle by tweaking it). Synth params tuned by ear on
     * built-in macOS speakers + AirPods; master gain (0.45) sits between
     * a system-notification ding and a full alert — clearly audible across
     * the room without being startling.
     *
     * No-ops when:
     *   - The user has muted the chime via the toolbar toggle (config
     *     `ai.soundOnReady === false`).
     *   - We just chimed within CHIME_THROTTLE_MS (de-spam back-to-back
     *     finishes on different tabs).
     *   - AudioContext construction fails or stays in `suspended` state
     *     because the page hasn't received a user gesture yet (rare in
     *     practice — by the time an AI tab finishes work the user has
     *     almost certainly clicked or typed).
     */
    private playReadyChime (): void {
        if (this.config.store?.ai?.soundOnReady === false) return

        const now = Date.now()
        if (now - this.lastChimeAt < this.CHIME_THROTTLE_MS) return
        this.lastChimeAt = now

        try {
            if (!this.audio) {
                const Ctx: typeof AudioContext | undefined =
                    (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
                if (!Ctx) return
                this.audio = new Ctx()
            }
            const ctx = this.audio
            if (ctx.state === 'closed') return
            // While suspended, ctx.currentTime is frozen — scheduling
            // synchronously would place every event "in the past" by the
            // time resume() settles, which the Web Audio engine renders as
            // a click or drops entirely. Defer until resume completes and
            // read currentTime fresh inside the then().
            if (ctx.state === 'suspended') {
                void ctx.resume().then(() => this.scheduleChime(ctx)).catch(() => { /* swallow */ })
                return
            }
            this.scheduleChime(ctx)
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[ai-sidebar] chime failed:', e)
        }
    }

    /**
     * Wire the two-note bell onto a live (running) AudioContext. Called
     * synchronously when the context was already running, or from the
     * `resume().then(...)` callback for the first-chime cold-start case.
     */
    private scheduleChime (ctx: AudioContext): void {
        const start = ctx.currentTime
        const master = ctx.createGain()
        master.gain.value = 0.45
        master.connect(ctx.destination)
        this.beep(ctx, master, 880,     start,        0.18)   // A5
        this.beep(ctx, master, 1318.51, start + 0.13, 0.22)   // E6
    }

    /**
     * Schedule one note: sine oscillator into a per-note gain envelope so we
     * get a soft attack + exponential decay (vs the click an un-enveloped
     * oscillator produces at start/stop).
     */
    private beep (ctx: AudioContext, dest: AudioNode, freq: number, at: number, durSec: number): void {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = freq
        const env = ctx.createGain()
        env.gain.setValueAtTime(0.0001, at)
        env.gain.exponentialRampToValueAtTime(1, at + 0.012)
        env.gain.exponentialRampToValueAtTime(0.0001, at + durSec)
        osc.connect(env)
        env.connect(dest)
        osc.start(at)
        osc.stop(at + durSec + 0.02)
    }
}
