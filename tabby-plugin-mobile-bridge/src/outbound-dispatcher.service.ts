import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { TabMonitor, TabState, TabStatus } from 'tabby-plugin-ai-sidebar'

import { TabIdentityService } from './tab-identity.service'
import { BindingStoreService } from './binding/store.service'
import { ChannelBinding } from './binding/types'
import { TopicService } from './telegram/topic.service'
import { TelegramClientService } from './telegram/client.service'

/** Event types pushed to phones. Aligned with the per-event-type filter
 *  defaults documented in docs/todo-mobile-bridge.md. */
export type BridgeEventType =
    | 'needs_permission'
    | 'task_completed'
    | 'task_failed'
    | 'tool_use'
    | 'state_transition'

/**
 * Top-level outbound pipe. Subscribes to ai-sidebar's TabMonitor.states$,
 * diffs status transitions per inner tab, and fans the resulting
 * BridgeEvents out to every enabled binding that hasn't filtered the
 * event type.
 *
 * Also drives the Telegram long-poll lifecycle off bindings$ — when a
 * Telegram binding becomes active (load or pair), we start the client;
 * when the last one is disabled or removed, we stop it. Calling
 * `start()` repeatedly with the same token is idempotent on the client
 * side, so concurrent callers (this service + PairingService during
 * pairing) don't race.
 *
 * Event coverage in v0:
 *   - needs_permission: any → NeedsPermission
 *   - task_completed:   Working → Idle
 *
 * Deferred (still needs HookWatcherService integration):
 *   - task_failed (no clean signal from TabState alone)
 *   - tool_use (default off; would need raw hook events)
 *   - state_transition (default off)
 */
@Injectable()
export class OutboundDispatcherService implements OnDestroy {
    private static readonly DEFAULT_FILTER: BridgeEventType[] = ['needs_permission', 'task_completed', 'task_failed']

    private prevStatus = new WeakMap<object, TabStatus>()
    private bootstrapped = false
    private subs: Subscription[] = []

    constructor (
        private monitor: TabMonitor,
        private identity: TabIdentityService,
        private store: BindingStoreService,
        private topics: TopicService,
        private telegram: TelegramClientService,
    ) {
        this.subs.push(this.monitor.states$.subscribe(states => this.diff(states)))
        this.subs.push(this.store.bindings$.subscribe(bindings => void this.syncTransport(bindings)))
        // Load the persisted bindings now so the first bindings$ emission
        // reflects truth, not the initial `[]`. Safe to await indirectly —
        // store.load() is idempotent.
        void this.store.load()
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
    }

    private async syncTransport (bindings: ChannelBinding[]): Promise<void> {
        const active = bindings.find(b => b.platform === 'telegram' && b.enabled)
        if (active) {
            try {
                await this.telegram.start(active.botToken)
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:dispatch] telegram start failed:', err)
            }
        } else {
            // No enabled Telegram binding — stop the loop so we're not
            // hammering api.telegram.org for an absent integration.
            await this.telegram.stop()
        }
    }

    private diff (states: TabState[]): void {
        for (const s of states) {
            // Key on innerTab object identity — split panes have distinct inner
            // tabs even when they share an outer container. WeakMap auto-cleans
            // when the inner tab is GC'd.
            const key = s.innerTab as unknown as object
            const prev = this.prevStatus.get(key)
            this.prevStatus.set(key, s.status)
            if (!this.bootstrapped) continue
            if (prev === s.status) continue
            this.detect(s, prev)
        }
        // Skip the very first emission — every tab "transitions" into its
        // first state on app launch, and we don't want to push history.
        this.bootstrapped = true
    }

    private detect (s: TabState, prev: TabStatus | undefined): void {
        if (s.status === TabStatus.NeedsPermission && prev !== TabStatus.NeedsPermission) {
            void this.dispatch(s, 'needs_permission', `${s.aiTool ?? 'agent'} needs permission — check the desktop`)
            return
        }
        if (s.status === TabStatus.Idle && prev === TabStatus.Working) {
            void this.dispatch(s, 'task_completed', `${s.aiTool ?? 'agent'} finished — ready for next prompt`)
            return
        }
    }

    private async dispatch (state: TabState, eventType: BridgeEventType, body: string): Promise<void> {
        const uuid = this.identity.uuidOf(state.outerTab)
        if (!uuid) return
        const identity = this.identity.current.find(i => i.uuid === uuid)
        if (!identity) return

        for (const binding of this.store.current) {
            if (!binding.enabled) continue
            if (!this.passesFilter(binding, eventType)) continue
            if (binding.platform !== 'telegram') continue // v0: Telegram only
            await this.sendToTelegram(binding, identity, eventType, body)
        }
    }

    private passesFilter (binding: ChannelBinding, eventType: BridgeEventType): boolean {
        // Empty array means "use defaults"; explicit list overrides.
        const list = binding.eventFilter.length > 0
            ? binding.eventFilter as BridgeEventType[]
            : OutboundDispatcherService.DEFAULT_FILTER
        return list.includes(eventType)
    }

    private async sendToTelegram (
        binding: ChannelBinding,
        identity: { uuid: string; displayIndex: number; name: string },
        eventType: BridgeEventType,
        body: string,
    ): Promise<void> {
        try {
            const threadId = await this.topics.ensureTopic(binding, identity)
            const text = this.formatMessage(eventType, body)
            await this.telegram.sendMessage(Number(binding.chatId), text, {
                messageThreadId: threadId,
            })
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:dispatch] send failed:', err)
            // Task #12 will add the proper retry / drop-log pipeline. v0
            // logs and drops so a single transient failure doesn't crash
            // the entire bridge.
        }
    }

    private formatMessage (eventType: BridgeEventType, body: string): string {
        const icon =
            eventType === 'needs_permission' ? '🔔'
            : eventType === 'task_completed' ? '✅'
            : eventType === 'task_failed' ? '⚠️'
            : 'ℹ️'
        return `${icon} ${body}`
    }
}
