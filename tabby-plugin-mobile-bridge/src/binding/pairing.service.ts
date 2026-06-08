import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs'

import { TelegramBackend } from '../backends/telegram/client.service'
import { FeishuBackend } from '../backends/feishu/client.service'
import { InboundMessage } from '../backends/types'
import { BindingStoreService } from './store.service'
import { ChannelBinding, PendingPairing } from './types'

/** Single observation the settings UI surfaces during an active pairing.
 *  Lets the user distinguish "bot received nothing" (network / wrong
 *  group / bot not in chat) from "bot received my message but the code
 *  didn't match" (typo / expired). */
export interface PairingDiagnostic {
    ts: number
    platform: 'telegram' | 'feishu'
    chatId: string
    senderId: string
    senderName?: string
    /** First 60 chars of the message, sanitised. */
    textPreview: string
    result: PairingDiagnosticResult
}

export type PairingDiagnosticResult =
    /** /bind <code> matched a pending entry → binding created. */
    | 'matched'
    /** /bind <code> but the code doesn't match any pending entry. */
    | 'code-not-pending'
    /** /bind <code> matched a pending entry but it had expired. */
    | 'expired'
    /** Message starts with /bind but the code-shape regex didn't match
     *  (wrong length / illegal chars). */
    | 'malformed-bind'
    /** Doesn't look like /bind — user is chatting in the group. Surface
     *  so the user can see "good, bot is in the right chat." */
    | 'not-bind'

/**
 * `/bind <code>` handshake. Replaces "user types chat id + sender id into
 * settings" with a confirmation flow that derives both from a real
 * incoming message — works identically on Telegram and Feishu thanks to
 * the unified {@link InboundMessage} shape.
 *
 * Flow (per platform):
 *   1. User pastes credentials in settings, clicks "Generate pairing code".
 *   2. {@link beginTelegramPairing} / {@link beginFeishuPairing} starts
 *      the matching backend, mints a 6-char code, registers a
 *      {@link PendingPairing}, and returns it for the UI to display.
 *   3. User goes to the chat platform, opens the supergroup the bot has
 *      been added to (forum topics enabled for TG; 话题模式 for Feishu),
 *      sends `/bind ABCDEF` from their account.
 *   4. The backend emits an InboundMessage via its inbound$ stream.
 *   5. We match `code` (whitespace + case tolerant), lock chatId from
 *      the message, ownerUserId from the sender, hand off to
 *      BindingStore.add which moves the plaintext secret into the
 *      keystore and writes the binding record.
 *   6. completedPairing$ fires so the UI can transition the modal
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
    /** Live diagnostics stream — every inbound message observed during
     *  the lifetime of the service, classified by what happened when we
     *  tried to match it to a pending pairing. Settings UI buffers the
     *  last few during an active pairing window. */
    private diagnosticsSubject = new Subject<PairingDiagnostic>()
    private subs: Subscription[] = []
    private sweepHandle: ReturnType<typeof setInterval> | null = null

    constructor (
        private telegram: TelegramBackend,
        private feishu: FeishuBackend,
        private store: BindingStoreService,
    ) {
        this.sweepHandle = setInterval(() => this.sweepExpired(), PairingService.SWEEP_MS)
        // Subscribe to BOTH backends so /bind from either platform routes
        // through the same matcher. The platform tag is preserved via the
        // closure so we know which PendingPairing list to scan.
        this.subs.push(this.telegram.inbound$.subscribe(msg => {
            this.onInbound(msg, 'telegram').catch(err => {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:pairing] telegram inbound handler failed:', err)
            })
        }))
        this.subs.push(this.feishu.inbound$.subscribe(msg => {
            this.onInbound(msg, 'feishu').catch(err => {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:pairing] feishu inbound handler failed:', err)
            })
        }))
    }

    ngOnDestroy (): void {
        for (const s of this.subs) s.unsubscribe()
        if (this.sweepHandle) clearInterval(this.sweepHandle)
    }

    /** Currently-active pairing codes (with expiry). UI displays these. */
    get pending$ (): Observable<PendingPairing[]> { return this.pendingSubject }

    /** Fires once per `/bind` success. UI listens to clear the spinner. */
    get completedPairing$ (): Observable<ChannelBinding> { return this.completedSubject }

    /** Every inbound message observed during a pairing window, tagged
     *  with what we did with it. Settings UI rolls this into a "recent
     *  activity" log so the user can see whether the bot received their
     *  /bind at all — the most common pairing failure mode is "bot isn't
     *  actually in the chat" or "wrong group selected." */
    get diagnostics$ (): Observable<PairingDiagnostic> { return this.diagnosticsSubject }

    /**
     * Begin Telegram pairing. Starts the long-poll loop with the given
     * token, registers a pending entry, returns the 6-char code.
     */
    async beginTelegramPairing (botToken: string, label?: string): Promise<PendingPairing> {
        await this.store.load()
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

    /**
     * Begin Feishu / Lark pairing. The user must already have created a
     * self-built app on open.feishu.cn (or open.larksuite.com), added
     * the bot to a supergroup, and switched that group to 话题模式
     * (topic mode) — none of which we can do for them via API. Once
     * that's set up they paste App ID + App Secret here and send
     * `/bind <code>` from the group.
     */
    async beginFeishuPairing (
        appId: string,
        appSecret: string,
        region: 'feishu' | 'lark',
        label?: string,
    ): Promise<PendingPairing> {
        await this.store.load()
        await this.feishu.start({ platform: 'feishu', appId, appSecret, region })
        const code = this.mintCode()
        const pending: PendingPairing = {
            code,
            platform: 'feishu',
            credentials: { platform: 'feishu', appId, appSecret, region },
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
     * Stop a backend if nothing needs it anymore — no enabled binding
     * for the platform AND no pending pairing. Without this, an
     * abandoned pairing leaves the backend running indefinitely with
     * no destination for received messages.
     *
     * Safe to call repeatedly: each backend's stop() is idempotent.
     * OutboundDispatcher.syncTransport will restart on the next
     * bindings$ emission if a binding becomes enabled.
     */
    private async maybeStopTransport (): Promise<void> {
        const needTg =
            this.store.current.some(b => b.platform === 'telegram' && b.enabled)
            || this.pendingSubject.value.some(p => p.platform === 'telegram')
        const needFeishu =
            this.store.current.some(b => b.platform === 'feishu' && b.enabled)
            || this.pendingSubject.value.some(p => p.platform === 'feishu')
        if (!needTg) await this.telegram.stop()
        if (!needFeishu) await this.feishu.stop()
    }

    private async onInbound (msg: InboundMessage, platform: 'telegram' | 'feishu'): Promise<void> {
        // Diagnostics path runs FIRST so a stale-code or malformed /bind
        // is still visible in the settings UI's recent-activity log.
        // Skip if no pending pairing exists for this platform — we don't
        // want to leak normal chat traffic onto the diagnostics stream
        // outside of an active pairing window.
        const hasPending = this.pendingSubject.value.some(p => p.platform === platform)

        const trimmed = msg.text.trim()
        const bindStart = /^\/bind\b/i.test(trimmed)
        const match = /^\/bind\s+([A-Z0-9]{4,12})\b/i.exec(trimmed)

        if (!match) {
            if (hasPending) {
                this.emitDiagnostic(msg, platform, bindStart ? 'malformed-bind' : 'not-bind')
            }
            return
        }
        const code = match[1].toUpperCase()

        const now = Date.now()
        const value = this.pendingSubject.value
        const candidate = value.find(
            p => p.code === code && p.platform === platform && p.expiresAt > now,
        )
        if (!candidate) {
            // Distinguish "code never existed" from "code existed but
            // expired" so the user knows whether to retry or generate
            // a fresh code.
            if (hasPending) {
                const expiredMatch = value.find(p => p.code === code && p.platform === platform)
                this.emitDiagnostic(msg, platform, expiredMatch ? 'expired' : 'code-not-pending')
            }
            return
        }

        // Atomically claim the candidate by removing it from the pending
        // list BEFORE the async store.add. Two concurrent /bind messages
        // (duplicate Send, network replay within 5 min, double-tap from
        // an attacker chat) would otherwise both pass the find() above,
        // both await store.add in parallel, and both create a binding
        // — last-writer-wins on the bindings file, but the duplicate
        // KEYSTORE entry persists and a second binding sticks if store
        // serialisation interleaves a settled add between the two adds.
        // JS single-thread semantics make the synchronous pendingSubject.next
        // a real claim: the next onInbound to read pendingSubject.value
        // sees an empty list and short-circuits.
        this.pendingSubject.next(value.filter(p => p.code !== code))

        const senderTag = msg.senderName ?? msg.senderId
        const defaultLabel = platform === 'telegram'
            ? `Telegram ${senderTag}`
            : `Feishu ${senderTag}`

        let binding: ChannelBinding
        try {
            binding = await this.store.add({
                platform,
                label: candidate.label ?? defaultLabel,
                credentials: candidate.credentials,
                chatId: msg.chatId,
                ownerUserId: msg.senderId,
                approvedSenders: [msg.senderId],
                enabled: true,
                eventFilter: [],
            })
        } catch (err) {
            // Restore the claim so the user can retry /bind. If a
            // concurrent /bind raced in during the await and tried to
            // claim, it would have seen the empty list and dropped — that
            // duplicate stays dropped, which is the desired behaviour.
            this.pendingSubject.next([...this.pendingSubject.value, candidate])
            throw err
        }
        this.emitDiagnostic(msg, platform, 'matched')
        this.completedSubject.next(binding)
    }

    private emitDiagnostic (
        msg: InboundMessage,
        platform: 'telegram' | 'feishu',
        result: PairingDiagnosticResult,
    ): void {
        this.diagnosticsSubject.next({
            ts: Date.now(),
            platform,
            chatId: msg.chatId,
            senderId: msg.senderId,
            senderName: msg.senderName,
            // Limit preview length and strip newlines so the UI line
            // doesn't wrap awkwardly.
            textPreview: msg.text.replace(/\s+/g, ' ').slice(0, 60),
            result,
        })
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
