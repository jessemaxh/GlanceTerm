import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subject } from 'rxjs'

import {
    InlineKeyboardMarkup,
    TgCallbackQuery,
    TgForumTopic,
    TgMessage,
    TgUpdate,
    TgUser,
} from './wire-types'
import {
    BackendCredentials,
    BotIdentity,
    ChatRef,
    EditOptions,
    InboundCallback,
    InboundMessage,
    InteractiveSpec,
    MessageRef,
    MessagingBackend,
    MessagingError,
    MessagingErrorKind,
    SendOptions,
    ThreadRef,
} from '../types'
import { redactToken } from '../../audit-log'

/**
 * Telegram implementation of {@link MessagingBackend}.
 *
 * Long-poll outbound-only HTTPS — no public URL, no webhook — matches the
 * "BYO bot, behind NAT" architectural rule. Single-token: one binding per
 * service instance, matching the v0 cap of one Telegram binding per
 * platform.
 *
 * Translation layer:
 *   - Numeric Telegram ids (chat_id, message_thread_id, message_id) are
 *     stringified at the boundary so the cross-platform interface uses
 *     uniform string refs. Parsing back to numeric happens inside this
 *     class only.
 *   - {@link TelegramApiError} is translated to {@link MessagingError}
 *     with a small kind taxonomy; raw HTTP codes and descriptions stay
 *     internal.
 *   - {@link TgInboundMessage}/{@link TgInboundCallback} wire shapes are
 *     translated to cross-platform {@link InboundMessage} /
 *     {@link InboundCallback} before publishing.
 *
 * Long-poll cadence: `timeout=30` in the getUpdates query holds the
 * connection on Telegram's side for up to 30 s; a slightly larger
 * AbortSignal so a stuck connection unblocks client-side instead of
 * leaking sockets.
 */
@Injectable()
export class TelegramBackend implements MessagingBackend, OnDestroy {
    private static readonly API = 'https://api.telegram.org'
    private static readonly POLL_SECONDS = 30
    private static readonly POLL_ABORT_MS = 35_000
    private static readonly RETRY_MS = 5_000

    private token = ''
    private offset = 0
    private running = false
    private loopPromise: Promise<void> | null = null
    /** Monotonic counter incremented on every start() AND haltLoop() —
     *  invalidates in-flight background work (getMe identity probe) so a
     *  late response can't revive a stale identity after stop(). */
    private startEpoch = 0
    private abort: AbortController | null = null
    private sessionAbort: AbortController | null = null
    private lifecycleQueue: Promise<void> = Promise.resolve()
    private stopSignal: { promise: Promise<void>; resolve: () => void } | null = null

    private inboundSubject = new Subject<InboundMessage>()
    private callbackSubject = new Subject<InboundCallback>()
    private runningSubject = new BehaviorSubject<boolean>(false)
    private identitySubject = new BehaviorSubject<BotIdentity | null>(null)

    get inbound$ (): Observable<InboundMessage> { return this.inboundSubject }
    get callbacks$ (): Observable<InboundCallback> { return this.callbackSubject }
    get running$ (): Observable<boolean> { return this.runningSubject }
    get identity$ (): Observable<BotIdentity | null> { return this.identitySubject }

    // ── Lifecycle ───────────────────────────────────────────────────────

    start (creds: BackendCredentials): Promise<void> {
        if (creds.platform !== 'telegram') {
            return Promise.reject(new Error(
                `TelegramBackend.start: expected telegram credentials, got ${creds.platform}`,
            ))
        }
        const token = creds.botToken
        return this.enqueueLifecycle(async () => {
            if (this.running && this.token === token) return
            if (this.running) await this.haltLoop()
            this.token = token
            this.running = true
            this.stopSignal = this.newStopSignal()
            this.sessionAbort = new AbortController()
            this.loopPromise = this.loop()
            this.startEpoch++
            const epoch = this.startEpoch
            this.runningSubject.next(true)
            // Probe bot identity in the background. Epoch guard so a slow
            // getMe response can't land in identitySubject AFTER a
            // concurrent stop()/start() has already cleared or replaced it.
            void this.getMe().then(
                me => {
                    if (epoch !== this.startEpoch) return
                    this.identitySubject.next(this.toBotIdentity(me))
                },
                () => {
                    if (epoch !== this.startEpoch) return
                    this.identitySubject.next(null)
                },
            )
        })
    }

    stop (): Promise<void> {
        return this.enqueueLifecycle(() => this.haltLoop())
    }

    private async haltLoop (): Promise<void> {
        if (!this.running) return
        this.running = false
        this.abort?.abort()
        this.sessionAbort?.abort()
        this.stopSignal?.resolve()
        try {
            await this.loopPromise
        } catch {
            // Aborted long poll surfaces as fetch rejection — swallow.
        }
        this.loopPromise = null
        this.abort = null
        this.sessionAbort = null
        this.stopSignal = null
        // Bump epoch BEFORE clearing identity — see start() epoch guard
        // comment for the race we're closing.
        this.startEpoch++
        this.runningSubject.next(false)
        this.identitySubject.next(null)
    }

    private enqueueLifecycle (fn: () => Promise<void>): Promise<void> {
        const next = this.lifecycleQueue.then(fn)
        this.lifecycleQueue = next.then(() => undefined, () => undefined)
        return next
    }

    private newStopSignal (): { promise: Promise<void>; resolve: () => void } {
        let resolveFn: () => void = () => undefined
        const promise = new Promise<void>(r => { resolveFn = r })
        return { promise, resolve: resolveFn }
    }

    ngOnDestroy (): void {
        void this.stop()
    }

    // ── MessagingBackend surface ─────────────────────────────────────────

    async createThread (chatId: ChatRef, title: string): Promise<ThreadRef> {
        const topic = await this.call<TgForumTopic>('createForumTopic', {
            chat_id: Number(chatId),
            name: title,
        })
        return String(topic.message_thread_id)
    }

    async closeThread (chatId: ChatRef, threadId: ThreadRef): Promise<void> {
        await this.call<true>('closeForumTopic', {
            chat_id: Number(chatId),
            message_thread_id: Number(threadId),
        })
    }

    async reopenThread (chatId: ChatRef, threadId: ThreadRef): Promise<void> {
        await this.call<true>('reopenForumTopic', {
            chat_id: Number(chatId),
            message_thread_id: Number(threadId),
        })
    }

    async renameThread (chatId: ChatRef, threadId: ThreadRef, title: string): Promise<void> {
        await this.call<true>('editForumTopic', {
            chat_id: Number(chatId),
            message_thread_id: Number(threadId),
            name: title,
        })
    }

    async sendText (
        chatId: ChatRef,
        threadId: ThreadRef,
        body: string,
        _opts?: SendOptions,
    ): Promise<MessageRef> {
        const sent = await this.call<TgMessage>('sendMessage', {
            chat_id: Number(chatId),
            text: body,
            message_thread_id: Number(threadId),
        })
        return {
            chatId,
            threadId,
            messageId: String(sent.message_id),
        }
    }

    async sendInteractive (
        chatId: ChatRef,
        threadId: ThreadRef,
        spec: InteractiveSpec,
    ): Promise<MessageRef> {
        const replyMarkup: InlineKeyboardMarkup = {
            inline_keyboard: spec.buttons.map(row =>
                row.map(b => ({
                    text: this.styledLabel(b.label, b.style),
                    callback_data: b.value,
                })),
            ),
        }
        const sent = await this.call<TgMessage>('sendMessage', {
            chat_id: Number(chatId),
            text: spec.body,
            message_thread_id: Number(threadId),
            reply_markup: replyMarkup,
        })
        return {
            chatId,
            threadId,
            messageId: String(sent.message_id),
        }
    }

    async editMessage (
        ref: MessageRef,
        body: string,
        opts?: EditOptions,
    ): Promise<void> {
        const reply_markup = opts?.clearButtons ? { inline_keyboard: [] } : undefined
        await this.call<TgMessage | true>('editMessageText', {
            chat_id: Number(ref.chatId),
            message_id: Number(ref.messageId),
            text: body,
            reply_markup,
        })
    }

    async ackCallback (callbackId: string): Promise<void> {
        await this.call<true>('answerCallbackQuery', {
            callback_query_id: callbackId,
        })
    }

    /** Bot identity probe — internal. UI gets the cached value via
     *  identity$; the probe is fired by start(). */
    private async getMe (): Promise<TgUser> {
        return this.call<TgUser>('getMe', {})
    }

    private toBotIdentity (me: TgUser): BotIdentity {
        return {
            id: String(me.id),
            displayName: me.username ? `@${me.username}` : me.first_name ?? `bot ${me.id}`,
            platformLabel: 'Telegram',
        }
    }

    /** Telegram doesn't support per-button styling natively; we prefix the
     *  label with a colour-coded emoji as a visual convention so danger
     *  buttons stand out in the inline keyboard. Primary stays bare to
     *  match Telegram's default button look. */
    private styledLabel (label: string, style?: 'primary' | 'danger' | 'default'): string {
        if (style === 'danger') return label.startsWith('❌') ? label : `❌ ${label}`
        if (style === 'primary') return label
        return label
    }

    // ── Long-poll loop ──────────────────────────────────────────────────

    private async loop (): Promise<void> {
        while (this.running) {
            try {
                this.abort = new AbortController()
                const timeoutId = setTimeout(
                    () => this.abort?.abort(),
                    TelegramBackend.POLL_ABORT_MS,
                )
                const updates = await this.call<TgUpdate[]>(
                    'getUpdates',
                    {
                        offset: this.offset,
                        timeout: TelegramBackend.POLL_SECONDS,
                        allowed_updates: ['message', 'callback_query'],
                    },
                    this.abort.signal,
                )
                clearTimeout(timeoutId)
                this.abort = null

                for (const u of updates) {
                    if (u.message?.text && u.message.from && !u.message.from.is_bot) {
                        this.inboundSubject.next(this.flattenMessage(u.message))
                    }
                    if (u.callback_query) {
                        const flat = this.flattenCallback(u.callback_query)
                        if (flat) this.callbackSubject.next(flat)
                    }
                    this.offset = Math.max(this.offset, u.update_id + 1)
                }
            } catch (err) {
                if (!this.running) return
                // eslint-disable-next-line no-console
                console.warn(
                    '[mobile-bridge:telegram] poll error, backing off:',
                    redactToken(err instanceof Error ? err.message : String(err)),
                )
                const stopPromise = this.stopSignal!.promise
                let timer: ReturnType<typeof setTimeout> | null = null
                await Promise.race([
                    new Promise<void>(r => { timer = setTimeout(r, TelegramBackend.RETRY_MS) }),
                    stopPromise,
                ])
                if (timer) clearTimeout(timer)
            }
        }
    }

    private flattenMessage (m: TgMessage): InboundMessage {
        return {
            chatId: String(m.chat.id),
            threadId: m.message_thread_id !== undefined ? String(m.message_thread_id) : null,
            senderId: String(m.from!.id),
            senderName: m.from!.username,
            text: m.text!,
            messageId: String(m.message_id),
        }
    }

    private flattenCallback (q: TgCallbackQuery): InboundCallback | null {
        if (!q.message || !q.data) return null
        return {
            callbackId: q.id,
            chatId: String(q.message.chat.id),
            threadId: q.message.message_thread_id !== undefined
                ? String(q.message.message_thread_id)
                : null,
            messageId: String(q.message.message_id),
            senderId: String(q.from.id),
            data: q.data,
        }
    }

    // ── Raw API call + error translation ────────────────────────────────

    private async call<T> (
        method: string,
        body: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<T> {
        if (!this.token) throw new MessagingError('auth_failed', 'TelegramBackend: not started')
        const clean: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(body)) {
            if (v !== undefined && v !== null) clean[k] = v
        }
        const effectiveSignal = signal ?? this.sessionAbort?.signal
        let res: Response
        try {
            res = await fetch(
                `${TelegramBackend.API}/bot${this.token}/${method}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(clean),
                    signal: effectiveSignal,
                },
            )
        } catch (err) {
            // fetch() rejections stringify with the full URL (containing
            // the token). Redact before propagating.
            const msg = err instanceof Error ? err.message : String(err)
            throw new MessagingError('unknown', `Telegram ${method}: ${redactToken(msg)}`)
        }
        const data = await res.json() as {
            ok: boolean
            result?: T
            description?: string
            error_code?: number
            parameters?: { retry_after?: number }
        }
        if (!data.ok) {
            throw this.translateError(method, data.error_code, data.description ?? 'unknown error', data.parameters?.retry_after)
        }
        return data.result as T
    }

    /**
     * Telegram HTTP code + description → {@link MessagingError} kind.
     * Heuristics based on the official Bot API behaviour; descriptions
     * are matched case-insensitively because Telegram occasionally
     * tweaks the casing.
     */
    private translateError (
        method: string,
        code: number | undefined,
        description: string,
        retryAfterSec: number | undefined,
    ): MessagingError {
        const kind = this.classifyError(code, description)
        const message = `Telegram ${method} failed: ${description} (code=${code ?? 'n/a'})`
        return new MessagingError(
            kind,
            message,
            retryAfterSec !== undefined ? retryAfterSec * 1000 : undefined,
        )
    }

    private classifyError (code: number | undefined, description: string): MessagingErrorKind {
        const d = description.toLowerCase()
        if (code === 429) return 'rate_limited'
        if (code === 401) return 'auth_failed'
        if (code === 403) return 'permission_denied'
        if (code === 400) {
            if (d.includes('topic_closed')) return 'thread_closed'
            if (d.includes('topic') && d.includes('not found')) return 'thread_not_found'
            if (d.includes('message thread not found')) return 'thread_not_found'
            if (d.includes('chat not found')) return 'chat_not_found'
        }
        if (code !== undefined && code >= 500) return 'unknown'
        return 'unknown'
    }
}
