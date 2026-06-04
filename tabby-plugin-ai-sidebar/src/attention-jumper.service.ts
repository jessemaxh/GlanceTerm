import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { AppService, HotkeysService } from 'tabby-core'

import { TabMonitor, TabState } from './tab-monitor'

/**
 * Handles the "jump to next AI tab waiting on you" hotkeys.
 *
 * `Cmd-J` (Mac) / `Ctrl-J` (Win/Linux) walks forward through the rotation;
 * `Shift` reverses. Rotation order:
 *
 *   1. All `needs_permission` tabs (most urgent — claude blocked on prompt)
 *   2. All `idle` tabs (AI present but waiting on you)
 *
 * Within a bucket we use Tabby's own top-bar tab order so the rotation
 * matches what the user sees on the tab strip. We skip `working` (don't
 * interrupt) and `no_ai` (nothing to do there). If no candidates exist,
 * the hotkey is a no-op rather than going to a "wrong" tab.
 */
@Injectable({ providedIn: 'root' })
export class AttentionJumperService implements OnDestroy {
    private latest: TabState[] = []
    private subs: Subscription[] = []

    constructor (
        private app: AppService,
        monitor: TabMonitor,
        hotkeys: HotkeysService,
    ) {
        this.subs.push(monitor.states$.subscribe(s => { this.latest = s }))
        this.subs.push(hotkeys.hotkey$.subscribe(id => {
            if (id === 'ai-jump-next-attention') this.jump(1)
            if (id === 'ai-jump-prev-attention') this.jump(-1)
        }))
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
    }

    private jump (direction: 1 | -1): void {
        const rank = (s: TabState): number => s.status === 'needs_permission' ? 0 : 1
        const tabIdx = (s: TabState): number => {
            const i = this.app.tabs.indexOf(s.outerTab)
            return i < 0 ? Number.MAX_SAFE_INTEGER : i
        }
        const candidates = this.latest
            .filter(s => s.status === 'needs_permission' || s.status === 'idle')
            .sort((a, b) => {
                const dp = rank(a) - rank(b)
                return dp !== 0 ? dp : tabIdx(a) - tabIdx(b)
            })

        if (candidates.length === 0) {
            return
        }

        // Land somewhere useful even if the active tab isn't in our list yet.
        const cur = candidates.findIndex(s => s.outerTab === this.app.activeTab)
        const next = cur < 0
            ? (direction === 1 ? 0 : candidates.length - 1)
            : (cur + direction + candidates.length) % candidates.length

        const target = candidates[next]
        this.app.selectTab(target.outerTab)
        // Inside a split, also focus the specific pane.
        if (target.outerTab !== target.innerTab && typeof (target.outerTab as any).focus === 'function') {
            try {
                (target.outerTab as any).focus(target.innerTab)
            } catch { /* best-effort */ }
        }
    }
}
