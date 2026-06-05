import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { AppService } from 'tabby-core'

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

    constructor (
        private app: AppService,
        private unread: UnreadService,
        monitor: TabMonitor,
    ) {
        this.requestPermissionOnce()
        this.sub = monitor.states$.subscribe(states => this.diff(states))
    }

    ngOnDestroy (): void {
        this.sub?.unsubscribe()
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
}
