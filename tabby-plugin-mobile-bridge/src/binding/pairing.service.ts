import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs'

import { TelegramBackend } from '../backends/telegram/client.service'
import { BindingStoreService } from './store.service'
import { ChannelBinding, PendingPairing } from './types'

/**
 * `/bind <code>` handshake. Replaces "user types chat id + sender id into
 * settings" with a confirmation flow that derives both from a real
 * incoming Telegram message.
 *
 * Flow:
 *   1. User pastes bot token in settings, clicks "Pair".
 *   2. {@link beginTelegramPairing} starts the Telegram client, mints a
 *      6-char code, and shows it in the UI.
 *   3. User goes to Telegram, opens the supergroup with topics enabled,
 *      sends `/bind ABCDEF` from their account.
 *   4. The client emits the message via inboundMessages$.
 *   5. We match `code` (whitespace + case tolerant), lock chatId from
 *      the message, ownerUserId from the sender, and write a binding.
 *   6. completedPairing$ emits the new binding so the UI can transition
 *      from "waiting" to "bound".
 *
 * The 5-minute expiry is enforced lazily — pending entries past their
 * `expiresAt` are filtered on every inbound message check, and a periodic
 * sweep clears stale entries from the subject so the UI doesn't leak.
 */
@Injectable()
export class PairingService implements OnDestroy {
    private static readonly PAIRING_TTL_MS = 5 * 60_000
    private static readonly CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // ambiguity-stripped (no 0/O/1/I)
    private static readonly CODE_LEN = 6
    private static readonly SWEEP_MS = 30_000

    private pendingSubject = new BehaviorSubject<PendingPairing[]>([])
    /**
     * Plain Subject (NOT BehaviorSubject): we DON'T want late subscribers
     * to replay the last completion. The settings dialog can be opened
     * a second time long after a pairing; with BehaviorSubject the
     * dialog would re-run the "clear UI" handler on every reopen.
     */
    private completedSubject = new Subject<ChannelBinding>()
    private telegramSub: Subscription | null = null
    private sweepHandle: ReturnType<typeof setInterval> | null = null

    constructor (
        private telegram: TelegramBackend,
        private store: BindingStoreService,
    ) {
        this.sweepHandle = setInterval(() => this.sweepExpired(), PairingService.SWEEP_MS)
    }

    ngOnDestroy (): void {
        this.telegramSub?.unsubscribe()
        if (this.sweepHandle) clearInterval(this.sweepHandle)
    }

    /** Currently-active pairing codes (with expiry). UI displays these. */
    get pending$ (): Observable<PendingPairing[]> { return this.pendingSubject }

    /** Fires once per `/bind` success. UI listens to clear the spinner. */
    get completedPairing$ (): Observable<ChannelBinding> { return this.completedSubject }

    /**
     * Begin Telegram pairing. Starts the long-poll loop with the given
     * token, registers a pending entry, and returns the 6-char code for
     * the UI to display.
     *
     * Caller responsibility: ensure no other Telegram pairing is in
     * flight on the same token (UI enforces single-pairing flow).
     */
    async beginTelegramPairing (botToken: string, label?: string): Promise<PendingPairing> {
        await this.store.load()

        // Subscribe lazily so we only listen once even if pairing is
        // retried multiple times within the same session. Errors inside
        // the handler (e.g. store.add() write failure) are surfaced
        // through console.warn — the previous `void` swallowed them and
        // left the user staring at a pairing UI that never completed.
        if (!this.telegramSub) {
            this.telegramSub = this.telegram.inbound$.subscribe(msg => {
                this.onTelegramInbound(msg).catch(err => {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:pairing] inbound handler failed:', err)
                })
            })
        }

        await this.telegram.start({ platform: 'telegram', botToken })

        const code = this.mintCode()
        const pending: PendingPairing = {
            code,
            platform: 'telegram',
            credentials: { platform: 'telegram', botToken },
            label,
            expiresAt: Date.now() + PairingService.PAIRING_TTL_MS,
        }
        this.pendingSubject.next([...this.pendingSubject.value, pending])
        return pending
    }

    /** Cancel a still-pending code (UI "back" button). */
    cancelPending (code: string): void {
        this.pendingSubject.next(this.pendingSubject.value.filter(p => p.code !== code))
        void this.maybeStopTransport()
    }

    /**
     * Stop the Telegram long-poll if there's no enabled binding AND no
     * remaining pending pairing for that platform. Without this, an
     * abandoned pairing leaves the bot polling api.telegram.org forever
     * with no binding to deliver messages to.
     *
     * Safe to call repeatedly: TelegramClient.stop() is idempotent.
     * OutboundDispatcher.syncTransport will (re-)start the loop on the
     * next bindings$ emission if a binding becomes enabled.
     */
    private async maybeStopTransport (): Promise<void> {
        const stillNeeded =
            this.store.current.some(b => b.platform === 'telegram' && b.enabled)
            || this.pendingSubject.value.some(p => p.platform === 'telegram')
        if (!stillNeeded) await this.telegram.stop()
    }

    private async onTelegramInbound (msg: { chatId: string; senderId: string; text: string; senderName?: string }): Promise<void> {
        const match = /^\/bind\s+([A-Z0-9]{4,12})\b/i.exec(msg.text.trim())
        if (!match) return
        const code = match[1].toUpperCase()

        const now = Date.now()
        const candidate = this.pendingSubject.value.find(
            p => p.code === code && p.platform === 'telegram' && p.expiresAt > now,
        )
        if (!candidate) return

        // Bound: write the binding, drop the pending entry, notify UI.
        const binding = await this.store.add({
            platform: 'telegram',
            label: candidate.label ?? `Telegram ${msg.senderName ?? msg.senderId}`,
            credentials: candidate.credentials,
            chatId: msg.chatId,
            ownerUserId: msg.senderId,
            approvedSenders: [msg.senderId],
            enabled: true,
            eventFilter: [],
        })
        this.pendingSubject.next(this.pendingSubject.value.filter(p => p.code !== code))
        this.completedSubject.next(binding)
    }

    private sweepExpired (): void {
        const now = Date.now()
        const live = this.pendingSubject.value.filter(p => p.expiresAt > now)
        if (live.length !== this.pendingSubject.value.length) {
            this.pendingSubject.next(live)
            void this.maybeStopTransport()
        }
    }

    private mintCode (): string {
        const len = PairingService.CODE_LEN
        const alpha = PairingService.CODE_ALPHABET
        // crypto.getRandomValues for unbiased uniform sampling — Math.random
        // is biased modulo 32 and predictable enough to matter for a 5-min
        // pairing window if anyone bothered to brute-force it.
        const buf = new Uint8Array(len)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const webcrypto: Crypto = (globalThis as { crypto?: Crypto }).crypto ?? require('crypto').webcrypto
        webcrypto.getRandomValues(buf)
        let out = ''
        for (let i = 0; i < len; i++) out += alpha[buf[i] % alpha.length]
        return out
    }
}
