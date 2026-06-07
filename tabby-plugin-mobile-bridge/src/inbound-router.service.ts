import { Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TabMonitor } from 'tabby-plugin-ai-sidebar'

import { TelegramClientService } from './telegram/client.service'
import { TopicService } from './telegram/topic.service'
import { BindingStoreService } from './binding/store.service'
import { TabIdentityService } from './tab-identity.service'
import { KeystrokeAdapterRegistry } from './pty-keystroke/registry'
import { TgInboundMessage } from './telegram/types'

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
    private static readonly LOG_FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge.log')

    private subs: Subscription[] = []

    constructor (
        private telegram: TelegramClientService,
        private topics: TopicService,
        private store: BindingStoreService,
        private identity: TabIdentityService,
        private monitor: TabMonitor,
        private keystrokes: KeystrokeAdapterRegistry,
    ) {
        this.subs.push(
            this.telegram.inboundMessages$.subscribe(msg => void this.route(msg)),
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

        if (msg.topicId === undefined) {
            await this.audit(msg, 'no-topic-id')
            return
        }

        const tabUuid = this.topics.findByThread(binding.id, msg.topicId)
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
     * Append-only JSONL audit. Body kept compact — we log routing
     * decisions, not the user's actual message content (no point
     * mirroring what's already in Telegram, and the text could contain
     * secrets even on the inbound side).
     */
    private async audit (msg: TgInboundMessage, reason: string): Promise<void> {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            reason,
            chatId: msg.chatId,
            senderId: msg.senderId,
            senderUsername: msg.senderUsername,
            topicId: msg.topicId,
            textLen: msg.text.length,
        })
        try {
            const dir = path.dirname(InboundRouterService.LOG_FILE)
            await fs.mkdir(dir, { recursive: true })
            await fs.appendFile(InboundRouterService.LOG_FILE, line + '\n', { mode: 0o600 })
        } catch {
            // Audit log failure is non-fatal — the route was already taken.
        }
    }
}
