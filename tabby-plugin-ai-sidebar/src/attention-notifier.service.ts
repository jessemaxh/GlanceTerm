import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { AppService } from 'tabby-core'

import { TabMonitor, TabState, TabStatus } from './tab-monitor'

/**
 * Fires a system notification when an AI tab transitions into a state that
 * needs the user. v0.2 scope is conservative:
 *
 *   - `needs_permission`  always notifies (claude blocked on a y/n prompt
 *                         is the canonical "where am I" moment).
 *   - `idle` (working → idle)  NOT notified by default. AI tools finish
 *                              hundreds of small tool calls per session;
 *                              notifying on every one would be noise. We
 *                              leave this behind a future config toggle.
 *
 * We suppress the notification when the user is already looking at the
 * tab in question — the sidebar's coloured row is enough signal.
 *
 * Clicking the notification focuses the originating tab AND brings the
 * window forward, so the user lands exactly where they need to act.
 */
@Injectable({ providedIn: 'root' })
export class AttentionNotifierService implements OnDestroy {
    private prevStatus = new WeakMap<object, TabStatus>()
    private sub?: Subscription
    /** Skip the very first emission — every tab "transitions" into its first state. */
    private bootstrapped = false
    /**
     * Per-tab cooldown. AI tools occasionally redraw their permission UI
     * (the prompt line gets cleared and redrawn during fancy menus), and
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

            if (s.status === 'needs_permission' && prev !== 'needs_permission') {
                this.fire(s)
            }
        }
        this.bootstrapped = true
    }

    private fire (s: TabState): void {
        if (typeof Notification === 'undefined') return
        if ((Notification as any).permission === 'denied') return
        // Already looking at this tab — sidebar dot is enough, don't bother.
        const isLookingHere =
            s.outerTab === this.app.activeTab &&
            typeof document !== 'undefined' &&
            document.hasFocus()
        if (isLookingHere) return

        // Cooldown — see field doc on `lastFiredAt`.
        const key = s.innerTab as unknown as object
        const last = this.lastFiredAt.get(key) ?? 0
        const now = Date.now()
        if (now - last < this.COOLDOWN_MS) return
        this.lastFiredAt.set(key, now)

        try {
            const n = new Notification('HiveTerm — agent needs you', {
                body: `${s.title}${s.aiTool ? ' · ' + s.aiTool : ''}`,
                silent: false,
                tag: `hiveterm-attn-${(s.innerTab as any).id ?? Math.random()}`,
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
