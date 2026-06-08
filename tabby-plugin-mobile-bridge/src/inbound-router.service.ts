import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TabMonitor } from 'tabby-plugin-ai-sidebar'

import { TelegramBackend } from './backends/telegram/client.service'
import { FeishuBackend } from './backends/feishu/client.service'
import { BackendRegistry } from './backends/registry.service'
import { InboundCallback, InboundMessage } from './backends/types'
import { TopicService } from './topic.service'
import { BindingStoreService } from './binding/store.service'
import { TabIdentityService } from './tab-identity.service'
import { KeystrokeAdapterRegistry } from './pty-keystroke/registry'
import { PermissionRelayService } from './permission-relay.service'
import { appendAudit, AUDIT_LOG_PATH } from './audit-log'

/** Anthropic's 5-letter id alphabet ([a-km-z], no l) + verdict word.
 *  /i tolerates phone autocorrect that capitalises sentence starts;
 *  lowercase the captured id before passing to PermissionRelayService.applyVerdict. */
const PERM_TEXT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/**
 * Route inbound Telegram messages → originating tab's PTY input.
 *
 * Pipeline:
 *   1. Resolve binding from `chat.id`. Unknown chat → drop (the bot
 *      could be in chats the user added it to; we only act on bound
 *      ones).
 *   2. Sender check against `binding.approvedSenders`. Unknown sender
 *      → silent drop, audit-logged. Silence denies attackers signal
 *      about whether a binding exists; the audit log keeps the owner
 *      able to spot probing.
 *   3. Skip `/bind <code>` — PairingService owns that command.
 *   4. Resolve `message_thread_id` via TopicService.findByThread to a
 *      tab UUID. No topic / unmatched topic → drop with reason.
 *   5. UUID → outerTab via TabIdentityService; outerTab → innerTab
 *      via TabMonitor.current; innerTab must be a
 *      BaseTerminalTabComponent (otherwise no PTY).
 *   6. innerTab.sendInput(text + Enter). Per-agent keystroke adaptation
 *      lives in task #9; v0 sends text + '\r' uniformly.
 *
 * Audit log: ~/.glanceterm/mobile-bridge.log, append-only JSONL.
 */
@Injectable()
export class InboundRouterService implements OnDestroy {
    private subs: Subscription[] = []

    constructor (
        telegram: TelegramBackend,
        feishu: FeishuBackend,
        private backends: BackendRegistry,
        private topics: TopicService,
        private store: BindingStoreService,
        private identity: TabIdentityService,
        private monitor: TabMonitor,
        private keystrokes: KeystrokeAdapterRegistry,
        private permissionRelay: PermissionRelayService,
    ) {
        // Subscribe to every backend's inbound streams. Adding a backend
        // is one entry. Each event carries enough context (chatId,
        // senderId, platform) for the per-binding routing below to
        // disambiguate platforms.
        for (const backend of [telegram, feishu]) {
            this.subs.push(backend.inbound$.subscribe(msg => void this.route(msg)))
            this.subs.push(backend.callbacks$.subscribe(cb => void this.routeCallback(cb)))
        }
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
    }

    private async route (msg: InboundMessage): Promise<void> {
        // Scope by msg.platform so a Telegram chatId and a Feishu chatId
        // that share a string value never cross-match. Previously this was
        // hardcoded to 'telegram', dropping every Feishu inbound message
        // with reason 'no-matching-binding' — including permission verdicts
        // and PTY-input replies.
        const binding = this.store.current.find(
            b => b.platform === msg.platform && b.chatId === msg.chatId && b.enabled,
        )
        if (!binding) {
            await this.audit(msg, 'no-matching-binding')
            return
        }

        if (!binding.approvedSenders.includes(msg.senderId)) {
            await this.audit(msg, 'sender-not-whitelisted')
            return
        }

        // Pairing commands route to PairingService via the same inbound stream.
        // Skip here to avoid double-handling — the user would otherwise see
        // their "/bind ABCDEF" injected into the focused terminal too.
        if (/^\/bind\b/i.test(msg.text.trim())) return

        // Permission-relay verdict shortcut: `yes <id>` / `no <id>` text
        // matches the same alphabet/format the handler's 5-letter id uses
        // and the same convention as Anthropic's official plugin.
        const verdictMatch = PERM_TEXT_RE.exec(msg.text.trim())
        if (verdictMatch) {
            const verdict: 'allow' | 'deny' = verdictMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
            const permId = verdictMatch[2].toLowerCase()
            const applied = await this.permissionRelay.applyVerdict(permId, verdict)
            await appendAudit({
                kind: applied ? 'permission-verdict' : 'permission-verdict-stale',
                permId, verdict, source: 'text', chatId: msg.chatId,
            })
            return
        }

        if (msg.threadId === null) {
            await this.audit(msg, 'no-topic-id')
            return
        }

        const tabUuid = await this.topics.findByThread(binding.id, msg.threadId)
        if (!tabUuid) {
            await this.audit(msg, 'topic-not-bound')
            return
        }

        const outer = this.identity.tabOf(tabUuid)
        if (!outer) {
            await this.audit(msg, 'tab-closed')
            return
        }

        const state = this.monitor.current.find(s => s.outerTab === outer)
        if (!state) {
            await this.audit(msg, 'tab-state-missing')
            return
        }
        const inner = state.innerTab
        if (!(inner instanceof BaseTerminalTabComponent)) {
            await this.audit(msg, 'tab-not-terminal')
            return
        }

        // Per-agent translation via registry. v0 every adapter is the
        // default (text + '\r'); the structure exists so dogfood-driven
        // specialisations land in one place.
        const ptyBytes = this.keystrokes.forTool(state.aiTool).translate(msg.text)
        try {
            inner.sendInput(ptyBytes)
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:inbound] sendInput failed:', err)
            await this.audit(msg, 'pty-write-failed')
        }
    }

    /**
     * Append-only JSONL audit (delegates to shared audit-log helper).
     * Body kept compact — we log routing decisions, not the user's
     * actual message content (no point mirroring what's already in
     * Telegram, and the text could contain secrets even on the inbound
     * side).
     */
    private async audit (msg: InboundMessage, reason: string): Promise<void> {
        await appendAudit({
            kind: 'inbound-drop',
            reason,
            chatId: msg.chatId,
            senderId: msg.senderId,
            senderName: msg.senderName,
            threadId: msg.threadId,
            textLen: msg.text.length,
        })
    }

    /**
     * Route an inline-keyboard tap. The data string is
     * `perm:(allow|deny):<5-letter-id>`; anything else is ignored. We
     * always answerCallbackQuery so the user's button stops "loading"
     * even if our gate rejects the verdict.
     */
    private async routeCallback (cb: InboundCallback): Promise<void> {
        // Ack UNCONDITIONALLY before any binding lookup. Telegram requires
        // the ack within ~30s or the inline-keyboard button spins forever
        // on the user's phone — even for callbacks we ultimately reject
        // (sender not whitelisted, binding disabled between send and tap).
        // The platform field on InboundCallback routes the ack to the
        // backend that originally received the click; FeishuBackend's
        // ackCallback is a no-op (Feishu auto-acks card actions), but we
        // call it for interface symmetry.
        void this.backends.forPlatform(cb.platform)
            .ackCallback(cb.callbackId)
            .catch(err => {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:inbound] ackCallback failed:', err)
            })

        const m = /^perm:(allow|deny):([a-km-z]{5})$/i.exec(cb.data)
        if (!m) {
            // Unknown callback shape (future button kinds, stale callback
            // from a removed feature). Already acked above; drop.
            return
        }

        const verdict = m[1].toLowerCase() as 'allow' | 'deny'
        const permId = m[2].toLowerCase()

        // Gate: callback sender must be on the allowlist of SOME binding
        // that targets this chat AND matches the originating platform.
        // The platform scope prevents a TG / Feishu chatId collision
        // from cross-matching (same defence as route() above).
        const binding = this.store.current.find(
            b => b.platform === cb.platform
                && b.chatId === cb.chatId
                && b.enabled
                && b.approvedSenders.includes(cb.senderId),
        )
        if (!binding) {
            await appendAudit({
                kind: 'permission-verdict-rejected',
                reason: 'no-matching-binding-or-sender',
                chatId: cb.chatId,
                senderId: cb.senderId,
                permId,
            })
            return
        }

        const ok = await this.permissionRelay.applyVerdict(permId, verdict)
        await appendAudit({
            kind: ok ? 'permission-verdict' : 'permission-verdict-stale',
            permId, verdict, source: 'callback', chatId: cb.chatId,
        })
    }
}

/** Re-export so consumers (settings UI etc.) can reference the path
 *  without depending on the audit-log module directly. */
export { AUDIT_LOG_PATH }
