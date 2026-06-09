import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { TabMonitor, TabState, TabStatus } from 'tabby-plugin-ai-sidebar'

import { TabIdentityService } from './tab-identity.service'
import { BindingStoreService } from './binding/store.service'
import { ChannelBinding } from './binding/types'
import { TopicService } from './topic.service'
import { BackendRegistry } from './backends/registry.service'
import { MessagingError } from './backends/types'
import { retryWithBackoff } from './retry'
import { appendAudit, redactToken } from './audit-log'
import { TranscriptTailerService, TranscriptEvent } from './transcript/tailer.service'
import { PtyTailerService } from './transcript/pty-tailer.service'
import { InstanceLockService } from './instance-lock.service'

/** Event types pushed to phones. Aligned with the per-event-type filter
 *  defaults documented in docs/todo-mobile-bridge.md. */
export type BridgeEventType =
    | 'needs_permission'
    | 'task_completed'
    | 'task_failed'
    | 'tool_use'
    | 'assistant_text'
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
    // Mirrors Claude's official Remote Control UX: the phone is a thin
    // client that sees the conversation — JUST the messages Claude
    // actually wrote, nothing else. No GlanceTerm-flavoured status
    // pings, no tool-call summaries, no notification icons. The phone
    // bubble should look indistinguishable from "Claude wrote you a
    // message," because that's exactly what it is.
    //
    // Every other event type is opt-in via the per-binding event filter
    // in the settings UI for users who specifically want a louder feed.
    private static readonly DEFAULT_FILTER: BridgeEventType[] = ['assistant_text']

    private prevStatus = new WeakMap<object, TabStatus>()
    private subs: Subscription[] = []
    /** Last audited (platform, error) tuple — used to dedup
     *  backend-start-failed rows. Without this, every bindings$ emission
     *  while a token stays revoked would write a duplicate audit row,
     *  drowning out actually new failures. */
    private lastStartFailureSig = new Map<ChannelBinding['platform'], string>()

    constructor (
        private monitor: TabMonitor,
        private identity: TabIdentityService,
        private store: BindingStoreService,
        private topics: TopicService,
        private backends: BackendRegistry,
        private transcript: TranscriptTailerService,
        private pty: PtyTailerService,
        private lock: InstanceLockService,
    ) {
        this.subs.push(this.monitor.states$.subscribe(states => this.diff(states)))
        this.subs.push(this.store.bindings$.subscribe(bindings => void this.syncTransport(bindings)))
        // Two event sources for assistant_text / tool_use, mutually
        // exclusive per tab:
        //   - TranscriptTailerService: Claude jsonl (structured + carries
        //     tool_use blocks). Fires only for Claude tabs.
        //   - PtyTailerService: ANSI-stripped output debounced 1.2s.
        //     Fires only for non-Claude tabs (Codex / Aider / Goose /
        //     anything else). Skips raw shells (no aiTool).
        // The dispatchTranscript path is identical for both — both emit
        // TranscriptEvent with kind='assistant_text', tabId from the
        // session env. The agent-name shown in the IM bubble is derived
        // from TabMonitor.aiTool at dispatch time so a non-Claude tab
        // doesn't render "Claude said …".
        this.subs.push(this.transcript.events$.subscribe(ev => void this.dispatchTranscript(ev)))
        this.subs.push(this.pty.events$.subscribe(ev => void this.dispatchTranscript(ev)))
        // Load the persisted bindings now so the first bindings$ emission
        // reflects truth, not the initial `[]`. Safe to await indirectly —
        // store.load() is idempotent.
        void this.store.load()
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
    }

    private async syncTransport (bindings: ChannelBinding[]): Promise<void> {
        // If this process didn't win the single-instance lock, force-stop
        // every backend unconditionally. Two processes long-polling the
        // same bot token would steal each other's updates (Telegram
        // delivers each update_id exactly once), making /bind and inbound
        // routing flap between instances. Same logic applies to Feishu's
        // WebSocket stream — only one client per app should be alive.
        if (!await this.lock.isPrimary()) {
            await Promise.all(this.backends.all().map(b => b.stop()))
            return
        }
        // Drive lifecycle per platform — enabled binding starts the
        // backend, absent enabled binding stops it. Adding a new platform
        // is one entry in this list.
        const platforms: Array<ChannelBinding['platform']> = ['telegram', 'feishu']
        await Promise.all(platforms.map(p => this.syncBackend(p, bindings)))
    }

    private async syncBackend (
        platform: ChannelBinding['platform'],
        bindings: ChannelBinding[],
    ): Promise<void> {
        const backend = this.backends.forPlatform(platform)
        const active = bindings.find(b => b.platform === platform && b.enabled)
        if (active) {
            try {
                await backend.start(active.credentials)
                this.lastStartFailureSig.delete(platform)
            } catch (err) {
                const safe = redactToken(err instanceof Error ? err.message : String(err))
                // eslint-disable-next-line no-console
                console.warn(`[mobile-bridge:dispatch] ${platform} start failed:`, safe)
                // Audit ONLY when the error fingerprint changes — a
                // chronically-broken binding (revoked token, hostname
                // drift) would otherwise re-audit on every bindings$
                // emission, drowning the log in N copies of the same row.
                const sig = `${active.id}|${safe}`
                if (this.lastStartFailureSig.get(platform) !== sig) {
                    this.lastStartFailureSig.set(platform, sig)
                    await appendAudit({
                        kind: 'backend-start-failed',
                        platform,
                        bindingId: active.id,
                        error: safe,
                    })
                }
            }
        } else {
            await backend.stop()
            this.lastStartFailureSig.delete(platform)
        }
    }

    /**
     * First-sight handling: a tab whose `prev` we have not seen before is
     * recorded silently — no event fires. This avoids the launch-time spam
     * where TabMonitor's BehaviorSubject seeds with `[]` then immediately
     * emits the real-but-not-yet-prev-tracked state for every existing
     * tab, which without this guard would fire a `needs_permission` push
     * for every tab already in that state.
     *
     * The cost: a tab that opens directly into NeedsPermission (rare —
     * usually a resumed session) won't notify until its NEXT transition.
     * Acceptable: we prefer silence over spam at launch.
     */
    private diff (states: TabState[]): void {
        for (const s of states) {
            // Key on innerTab object identity — split panes have distinct inner
            // tabs even when they share an outer container. WeakMap auto-cleans
            // when the inner tab is GC'd.
            const key = s.innerTab as unknown as object
            const prev = this.prevStatus.get(key)
            this.prevStatus.set(key, s.status)
            if (prev === undefined) continue
            if (prev === s.status) continue
            this.detect(s, prev)
        }
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
        // Secondary instances would otherwise try sendToTelegram with a
        // client that syncTransport already stopped, log a flood of
        // "no token" warnings, and write outbound-drop audit lines for
        // events the primary already shipped. Gate early.
        if (!await this.lock.isPrimary()) return
        const uuid = this.identity.uuidOf(state.outerTab)
        if (!uuid) return
        const identity = this.identity.current.find(i => i.uuid === uuid)
        if (!identity) return

        // Parallelise across bindings — sendToTelegram has its own retry
        // budget and catches all errors before resolving, so a slow /
        // rate-limited binding A cannot delay binding B from receiving
        // the same event. Sequential await here would queue every send
        // behind the slowest channel, which on transcript-driven traffic
        // (many assistant messages per minute) would cascade into
        // observable lag.
        const sends: Promise<void>[] = []
        for (const binding of this.store.current) {
            if (!binding.enabled) continue
            if (!this.passesFilter(binding, eventType)) continue
            sends.push(this.sendViaBackend(binding, identity, eventType, body))
        }
        await Promise.all(sends)
    }

    /**
     * Transcript-sourced events (assistant text + structured tool_use)
     * carry the GLANCETERM_TAB_ID directly — the env-injected uuid that
     * flows through hook events. Identity rows are keyed on a separate
     * sidebar-minted uuid, so we resolve via `byHookTabId` (walks tabs
     * and matches `session.glancetermTabId`) instead of the self-match
     * the state-transition path can use.
     *
     * Kept as a separate entry point rather than collapsed into `dispatch`
     * because TabState is structurally distant from TranscriptEvent —
     * coercing one into the other just to share four lines of code
     * would obscure both.
     */
    private async dispatchTranscript (ev: TranscriptEvent): Promise<void> {
        if (!await this.lock.isPrimary()) return
        const identity = this.identity.byHookTabId(ev.tabId)
        if (!identity) return

        const eventType: BridgeEventType = ev.kind === 'assistant_text' ? 'assistant_text' : 'tool_use'
        const body = ev.kind === 'assistant_text'
            ? truncateForChat(ev.text)
            : (ev.summary ? `${ev.toolName}: ${ev.summary}` : ev.toolName)
        if (!body) return

        // Same parallel fan-out rationale as `dispatch` above.
        const sends: Promise<void>[] = []
        for (const binding of this.store.current) {
            if (!binding.enabled) continue
            if (!this.passesFilter(binding, eventType)) continue
            sends.push(this.sendViaBackend(binding, identity, eventType, body))
        }
        await Promise.all(sends)
    }

    private passesFilter (binding: ChannelBinding, eventType: BridgeEventType): boolean {
        // Empty array means "use defaults"; explicit list overrides.
        const list = binding.eventFilter.length > 0
            ? binding.eventFilter as BridgeEventType[]
            : OutboundDispatcherService.DEFAULT_FILTER
        return list.includes(eventType)
    }

    private async sendViaBackend (
        binding: ChannelBinding,
        identity: { uuid: string; displayIndex: number; name: string },
        eventType: BridgeEventType,
        body: string,
    ): Promise<void> {
        const text = this.formatMessage(eventType, body)
        const backend = this.backends.forPlatform(binding.platform)
        let reopenAttempted = false
        try {
            await retryWithBackoff(async () => {
                const threadId = await this.topics.ensureTopic(binding, identity)
                await backend.sendText(binding.chatId, threadId, text)
            })
        } catch (err) {
            // Thread-closed race: TopicSyncService closed the thread in
            // the gap between identity going away and this send draining
            // the queue. Reopen + retry once. The next sync tick will
            // re-close if the tab is really gone — minor cosmetic flicker,
            // but the assistant's final message isn't lost.
            if (err instanceof MessagingError && err.kind === 'thread_closed') {
                reopenAttempted = true
                try {
                    await this.topics.syncReopenTopic(binding, identity.uuid, identity)
                    const threadId = await this.topics.ensureTopic(binding, identity)
                    await backend.sendText(binding.chatId, threadId, text)
                    return
                } catch (innerErr) {
                    err = innerErr
                }
            }
            const safeMessage = redactToken(err instanceof Error ? err.message : String(err))
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:dispatch] send failed after retries:', safeMessage)
            await appendAudit({
                kind: 'outbound-drop',
                bindingId: binding.id,
                platform: binding.platform,
                eventType,
                tabUuid: identity.uuid,
                tabIndex: identity.displayIndex,
                error: safeMessage,
                reopenAttempted,
            })
        }
    }

    private formatMessage (eventType: BridgeEventType, body: string): string {
        // assistant_text is the actual Claude reply — no icon prefix, the
        // bot's name in the message bubble already labels it. Adding an
        // emoji here would make every Claude utterance look like a status
        // line, defeating the "phone sees the conversation" goal.
        if (eventType === 'assistant_text') return body
        const icon =
            eventType === 'needs_permission' ? '🔔'
            : eventType === 'task_completed' ? '✅'
            : eventType === 'task_failed' ? '⚠️'
            : eventType === 'tool_use' ? '▷'
            : 'ℹ️'
        return `${icon} ${body}`
    }
}

/**
 * Telegram caps a single message at 4096 chars. Long assistant turns
 * (multi-paragraph plans, code blocks) need a hard cap or the send
 * fails outright. Keep it below the limit with room for the bot name
 * + topic prefix Telegram adds in the bubble.
 *
 * We chunk-truncate rather than chunk-split because successive sends
 * arrive out of Telegram's rate-limit budget very fast — a 10-message
 * single-turn would also be visually overwhelming in a notification
 * stream. Truncating + "… (X chars truncated)" gives the user the
 * gist on the phone and signals to open the desktop for the full
 * version. The cliff matches Claude's own answer length for "ok cool"
 * tier turns; longer turns get the chop.
 */
function truncateForChat (s: string): string {
    const MAX = 3500
    if (s.length <= MAX) return s
    return s.slice(0, MAX) + `\n… (${s.length - MAX} chars truncated — see desktop)`
}
