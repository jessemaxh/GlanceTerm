import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'

import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TabMonitor } from 'tabby-plugin-ai-sidebar'

import { TelegramClientService } from './telegram/client.service'
import { TopicService } from './telegram/topic.service'
import { BindingStoreService } from './binding/store.service'
import { TabIdentityService } from './tab-identity.service'
import { KeystrokeAdapterRegistry } from './pty-keystroke/registry'
import { PermissionRelayService } from './permission-relay.service'
import { TgInboundCallback, TgInboundMessage } from './telegram/types'
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
        private telegram: TelegramClientService,
        private topics: TopicService,
        private store: BindingStoreService,
        private identity: TabIdentityService,
        private monitor: TabMonitor,
        private keystrokes: KeystrokeAdapterRegistry,
        private permissionRelay: PermissionRelayService,
    ) {
        this.subs.push(
            this.telegram.inboundMessages$.subscribe(msg => void this.route(msg)),
        )
        this.subs.push(
            this.telegram.callbackQueries$.subscribe(cb => void this.routeCallback(cb)),
        )
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
    }

    private async route (msg: TgInboundMessage): Promise<void> {
        const chatIdStr = String(msg.chatId)
        const binding = this.store.current.find(
            b => b.platform === 'telegram' && b.chatId === chatIdStr && b.enabled,
        )
        if (!binding) {
            await this.audit(msg, 'no-matching-binding')
            return
        }

        const senderIdStr = String(msg.senderId)
        if (!binding.approvedSenders.includes(senderIdStr)) {
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

        if (msg.topicId === undefined) {
            await this.audit(msg, 'no-topic-id')
            return
        }

        const tabUuid = await this.topics.findByThread(binding.id, msg.topicId)
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
    private async audit (msg: TgInboundMessage, reason: string): Promise<void> {
        await appendAudit({
            kind: 'inbound-drop',
            reason,
            chatId: msg.chatId,
            senderId: msg.senderId,
            senderUsername: msg.senderUsername,
            topicId: msg.topicId,
            textLen: msg.text.length,
        })
    }

    /**
     * Route an inline-keyboard tap. The data string is
     * `perm:(allow|deny):<5-letter-id>`; anything else is ignored. We
     * always answerCallbackQuery so the user's button stops "loading"
     * even if our gate rejects the verdict.
     */
    private async routeCallback (cb: TgInboundCallback): Promise<void> {
        // Always ack — Telegram requires it within ~30s or the button
        // spins forever on the user's phone. Errors here are non-fatal.
        const ack = (text?: string) =>
            this.telegram.answerCallbackQuery(cb.callbackId, text ? { text } : {})
                .catch(err => {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:inbound] answerCallbackQuery failed:', err)
                })

        const m = /^perm:(allow|deny):([a-km-z]{5})$/i.exec(cb.data)
        if (!m) {
            // Unknown callback shape (future button kinds, stale callback
            // from a removed feature). Ack silently, drop.
            void ack()
            return
        }

        const verdict = m[1].toLowerCase() as 'allow' | 'deny'
        const permId = m[2].toLowerCase()

        // Gate: callback sender must be on the allowlist of SOME binding
        // that targets this chat. We don't yet have a callback-chat→binding
        // map; iterate bindings and accept if any allowlist matches.
        const binding = this.store.current.find(
            b => b.platform === 'telegram'
                && b.chatId === String(cb.chatId)
                && b.enabled
                && b.approvedSenders.includes(String(cb.senderId)),
        )
        if (!binding) {
            void ack('Not authorised.')
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
        void ack(ok ? (verdict === 'allow' ? '✅ Allowed' : '❌ Denied') : 'Already resolved.')
    }
}

/** Re-export so consumers (settings UI etc.) can reference the path
 *  without depending on the audit-log module directly. */
export { AUDIT_LOG_PATH }
