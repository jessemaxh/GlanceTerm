import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { AppService } from 'tabby-core'

import { TabMonitor, TabState, TabStatus } from './tab-monitor'

type NotifyKind = 'permission' | 'ready'

/**
 * How long an idle status must stay stable before we treat it as "agent
 * actually finished a turn" and notify. Claude/codex routinely sit at
 * idle for 1-2 seconds BETWEEN tool calls within a single turn — bytes
 * pause, the spinner stops, the tab classifies as idle, then 800ms later
 * the next tool call fires and we're back to working. Notifying on every
 * one of those transient idles is unusable. 3000ms is comfortably above
 * the longest inter-tool pause I've measured (under 2s for claude even
 * with slow tools like a long Bash) and low enough that "I just finished"
 * still feels real-time.
 */
const READY_STABILITY_MS = 3_000

/**
 * Fires a system notification when an AI tab transitions into a state that
 * needs the user's attention:
 *
 *   - `needs_permission`      block-on-user prompt (claude y/n menu, etc.)
 *                             fires immediately on the transition.
 *   - `working` → `idle`      AI finished its turn. Fires after the tab
 *                             stays in `idle` for READY_STABILITY_MS to
 *                             filter out inter-tool-call pauses.
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
     * Pending "ready" notification timers, one per tab. When a tab goes
     * working → idle we schedule a delayed fire; if it goes idle → working
     * (next tool call) or idle → needs_permission BEFORE the timer fires,
     * we cancel — the turn isn't actually over.
     */
    private pendingReady = new WeakMap<object, ReturnType<typeof setTimeout>>()
    /** Latest TabState per tab — needed for the deferred ready callback. */
    private latestByTab = new WeakMap<object, TabState>()

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
        // Refresh the lookup so the deferred ready callback uses fresh data.
        for (const s of states) {
            this.latestByTab.set(s.innerTab as unknown as object, s)
        }

        for (const s of states) {
            const key = s.innerTab as unknown as object
            const prev = this.prevStatus.get(key)
            this.prevStatus.set(key, s.status)

            if (!this.bootstrapped) continue
            if (prev === s.status) continue

            // Permission state: fire immediately. Also cancel any pending
            // "ready" timer for this tab — the user needs to handle the
            // prompt, not be told the prior turn ended.
            if (s.status === 'needs_permission' && prev !== 'needs_permission') {
                this.cancelPendingReady(key)
                this.fire(s, 'permission')
                continue
            }

            // Working → idle: schedule a delayed "ready" notification.
            // Use a quasi-idle-trigger: only schedule if we just left working.
            if (s.status === 'idle' && prev === 'working') {
                this.scheduleReady(key)
                continue
            }

            // Any movement AWAY from idle while a ready timer is pending
            // means the agent isn't actually done. Cancel the pending fire.
            if (prev === 'idle' && s.status !== 'idle') {
                this.cancelPendingReady(key)
            }
        }

        this.bootstrapped = true
    }

    private scheduleReady (key: object): void {
        this.cancelPendingReady(key)
        const timer = setTimeout(() => {
            this.pendingReady.delete(key)
            const fresh = this.latestByTab.get(key)
            if (!fresh) return
            // Sanity check — only fire if the tab is STILL idle.
            if (fresh.status !== 'idle') return
            this.fire(fresh, 'ready')
        }, READY_STABILITY_MS)
        this.pendingReady.set(key, timer)
    }

    private cancelPendingReady (key: object): void {
        const t = this.pendingReady.get(key)
        if (t) {
            clearTimeout(t)
            this.pendingReady.delete(key)
        }
    }

    private fire (s: TabState, kind: NotifyKind): void {
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

        const title = kind === 'permission'
            ? 'HiveTerm — agent needs you'
            : 'HiveTerm — agent ready'
        const subline = kind === 'permission'
            ? 'permission required'
            : 'ready for next prompt'

        try {
            const n = new Notification(title, {
                body: `${s.title}${s.aiTool ? ' · ' + s.aiTool : ''} — ${subline}`,
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
