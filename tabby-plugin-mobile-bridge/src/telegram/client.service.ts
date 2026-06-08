import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subject } from 'rxjs'

import {
    InlineKeyboardMarkup,
    TgCallbackQuery,
    TgForumTopic,
    TgInboundCallback,
    TgInboundMessage,
    TgMessage,
    TgUpdate,
    TgUser,
} from './types'
import { redactToken } from '../audit-log'

/**
 * Long-poll Telegram Bot API. Outbound-only HTTPS — no public URL, no
 * webhook — matches the "BYO bot, behind NAT" architectural rule.
 *
 * Single-token: one binding per service instance, matching the v0 cap of
 * one Telegram binding per platform. If/when we lift that cap, this gets
 * refactored to take token per call.
 *
 * Long-poll cadence: `timeout=30` in the getUpdates query holds the
 * connection on Telegram's side for up to 30 s waiting for new updates;
 * we set a slightly larger AbortSignal so a stuck connection unblocks
 * client-side instead of leaking sockets.
 *
 * Errors during the loop currently fall back to a flat 5 s sleep —
 * exponential backoff lives in task #12 (`Retry with exponential backoff +
 * drop log`). This service throws on outbound failures so the policy
 * layer can decide.
 */
@Injectable()
export class TelegramClientService implements OnDestroy {
    private static readonly API = 'https://api.telegram.org'
    /** Server-side long-poll window, in seconds. Max per Telegram docs is 50. */
    private static readonly POLL_SECONDS = 30
    /** Client-side hard deadline. Larger than POLL_SECONDS so a healthy long
     *  poll always completes server-side first. */
    private static readonly POLL_ABORT_MS = 35_000
    private static readonly RETRY_MS = 5_000

    private token = ''
    private offset = 0
    private running = false
    private loopPromise: Promise<void> | null = null
    /** Monotonic counter incremented on every successful start(). Used to
     *  invalidate background work (the getMe identity probe) when a
     *  concurrent stop()/start() rotates the session — without this, a
     *  slow getMe response from session N would land in identitySubject
     *  AFTER stop() cleared it via .next(null), reviving a stale "@bot
     *  connected" in the settings UI. */
    private startEpoch = 0
    /** Per-iteration abort used by `loop()` for the 35 s long-poll deadline. */
    private abort: AbortController | null = null
    /**
     * Session-lived abort. start() creates it; haltLoop() aborts it.
     * Passed by default to every outbound `call()` so a stop() while a
     * sendMessage / createForumTopic / editForumTopic is in flight tears
     * the fetch down instead of leaving it hanging — otherwise stop()
     * would return but a hung outbound would keep the token live in
     * an open TCP connection.
     */
    private sessionAbort: AbortController | null = null
    /**
     * Serializes start/stop/start sequences. Without it: caller A enters
     * with running=false, sets running=true; caller B observes running
     * and awaits stop(); a concurrent C enters with running=false (B's
     * stop hasn't finished resetting it yet) and starts a parallel
     * loop. The single loopPromise field then can't track both. The
     * queue forces start/stop to run one at a time end-to-end.
     */
    private lifecycleQueue: Promise<void> = Promise.resolve()
    /**
     * Resolved by stop() so backoff sleeps in the poll loop can wake
     * up immediately on shutdown instead of completing one more poll
     * with a stale (potentially rotated) token after stop() returns.
     */
    private stopSignal: { promise: Promise<void>; resolve: () => void } | null = null
    private updatesSubject = new Subject<TgUpdate>()
    private inboundSubject = new Subject<TgInboundMessage>()
    private callbackSubject = new Subject<TgInboundCallback>()
    /** Reactive flag for UI templates — true while a long-poll loop is
     *  active. Updates inside start()/stop() so subscribers see the
     *  transition atomically with the actual state change. */
    private runningSubject = new BehaviorSubject<boolean>(false)
    /** Bot identity (from `getMe`), refreshed once per start(). null until
     *  the first start succeeds; cleared on stop so a stale identity from
     *  a rotated token doesn't show in the settings UI. */
    private identitySubject = new BehaviorSubject<TgUser | null>(null)

    /** Inbound user messages, flattened. Subscribers should filter on chatId. */
    get inboundMessages$ (): Observable<TgInboundMessage> {
        return this.inboundSubject
    }

    /** Inbound callback-query taps (inline keyboard). Flattened the same
     *  way inboundMessages$ is. Permission-relay verdicts arrive here. */
    get callbackQueries$ (): Observable<TgInboundCallback> {
        return this.callbackSubject
    }

    /** Raw updates for advanced consumers. Most callers want inboundMessages$. */
    get rawUpdates$ (): Observable<TgUpdate> {
        return this.updatesSubject
    }

    /** True while a long-poll loop is alive. Reactive surface for the
     *  settings UI to show "Connected" vs "Idle." */
    get running$ (): Observable<boolean> {
        return this.runningSubject
    }

    /** Bot identity from getMe, or null when not connected. */
    get identity$ (): Observable<TgUser | null> {
        return this.identitySubject
    }

    /**
     * Begin long-polling with `token`. Idempotent: calling start() twice
     * with the same token is a no-op; calling with a different token
     * stops the current loop and restarts. Serialized via lifecycleQueue
     * so concurrent start/stop/start sequences don't leak parallel loops.
     */
    start (token: string): Promise<void> {
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
            // Probe bot identity in the background. The epoch capture +
            // check guards against a slow getMe response writing a stale
            // identity AFTER a concurrent stop()/start() rotation has
            // already cleared (or replaced) it. Failure here doesn't
            // prevent polling — the long-poll loop hits the same
            // bad-token error on first iteration and backs off.
            void this.getMe().then(
                me => {
                    if (epoch === this.startEpoch) this.identitySubject.next(me)
                },
                () => {
                    if (epoch === this.startEpoch) this.identitySubject.next(null)
                },
            )
        })
    }

    /** Halt polling. Resolves once the in-flight request unblocks.
     *  Serialized via lifecycleQueue. */
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
        // Bump epoch BEFORE clearing identity. An in-flight getMe from
        // the start() that paired with this haltLoop may have already
        // received its HTTP response (fetch can return before the
        // sessionAbort lands if the body buffer fully arrived first),
        // in which case its queued `.then` will run after this point.
        // Without this bump, that microtask would see
        // epoch === this.startEpoch and revive the stale identity AFTER
        // we just cleared it — the exact bug the start-side epoch was
        // supposed to fix, but only half-closed. Bumping here invalidates
        // any in-flight probe regardless of whether a subsequent start()
        // arrives.
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

    /**
     * Send a text message. `messageThreadId` targets a specific Forum Topic
     * inside a supergroup; omit for a generic chat. `replyMarkup` attaches
     * an inline keyboard (used by permission-relay for Allow/Deny taps).
     */
    sendMessage (
        chatId: number,
        text: string,
        opts: {
            messageThreadId?: number
            replyToMessageId?: number
            parseMode?: 'MarkdownV2' | 'HTML'
            replyMarkup?: InlineKeyboardMarkup
        } = {},
    ): Promise<TgMessage> {
        return this.call<TgMessage>('sendMessage', {
            chat_id: chatId,
            text,
            message_thread_id: opts.messageThreadId,
            reply_to_message_id: opts.replyToMessageId,
            parse_mode: opts.parseMode,
            reply_markup: opts.replyMarkup,
        })
    }

    /** Create a new Forum Topic in a supergroup that has topics enabled. */
    createForumTopic (chatId: number, name: string): Promise<TgForumTopic> {
        return this.call<TgForumTopic>('createForumTopic', {
            chat_id: chatId,
            name,
        })
    }

    /** Rename an existing Forum Topic — used when the tab is renamed. */
    editForumTopic (chatId: number, messageThreadId: number, name: string): Promise<true> {
        return this.call<true>('editForumTopic', {
            chat_id: chatId,
            message_thread_id: messageThreadId,
            name,
        })
    }

    /**
     * Close a Forum Topic — history is retained, but no new messages can be
     * posted until reopen. On the phone the topic gets Telegram's native
     * closed-state lock badge. Used by TopicSyncService when the underlying
     * tab is closed: archive, don't delete.
     */
    closeForumTopic (chatId: number, messageThreadId: number): Promise<true> {
        return this.call<true>('closeForumTopic', {
            chat_id: chatId,
            message_thread_id: messageThreadId,
        })
    }

    /**
     * Reopen a previously-closed Forum Topic. Triggered when (a) a tab
     * with a cached-but-closed topic re-appears (e.g. tab restore on
     * relaunch), or (b) an outbound send hits TOPIC_CLOSED because the
     * sync service raced ahead.
     */
    reopenForumTopic (chatId: number, messageThreadId: number): Promise<true> {
        return this.call<true>('reopenForumTopic', {
            chat_id: chatId,
            message_thread_id: messageThreadId,
        })
    }

    /**
     * Edit an already-posted text message. Used by the cross-binding
     * "resolved elsewhere" sync to swap `Waiting…` for `✓ resolved …`,
     * and by permission-relay to neutralise a prompt after either the
     * phone OR the local fallback answers (passes `replyMarkup:
     * { inline_keyboard: [] }` to drop the keyboard so the buttons
     * stop "loading" forever after the verdict is captured).
     */
    editMessageText (
        chatId: number,
        messageId: number,
        text: string,
        opts: { parseMode?: 'MarkdownV2' | 'HTML'; replyMarkup?: InlineKeyboardMarkup } = {},
    ): Promise<TgMessage | true> {
        return this.call<TgMessage | true>('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: opts.parseMode,
            reply_markup: opts.replyMarkup,
        })
    }

    /**
     * Acknowledge a callback_query so the user's button stops "loading".
     * REQUIRED by Telegram within ~30 s of receiving the callback, even
     * if we don't show a popup — without it the inline keyboard spinner
     * sits forever on the user's phone. Pass `text` to show a brief toast
     * (≤200 chars), or omit for a silent ack.
     */
    answerCallbackQuery (callbackQueryId: string, opts: { text?: string; showAlert?: boolean } = {}): Promise<true> {
        return this.call<true>('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text: opts.text,
            show_alert: opts.showAlert,
        })
    }

    /** Bot identity probe — used by `/bind` pairing to display the bound
     *  bot name and by health checks. */
    getMe (): Promise<TgUser> {
        return this.call<TgUser>('getMe', {})
    }

    private async loop (): Promise<void> {
        while (this.running) {
            try {
                this.abort = new AbortController()
                const timeoutId = setTimeout(
                    () => this.abort?.abort(),
                    TelegramClientService.POLL_ABORT_MS,
                )
                const updates = await this.call<TgUpdate[]>(
                    'getUpdates',
                    {
                        offset: this.offset,
                        timeout: TelegramClientService.POLL_SECONDS,
                        // callback_query was added when permission-relay shipped
                        // — without explicitly listing it Telegram drops the
                        // inline-keyboard taps on the floor (default
                        // allowed_updates excludes callback_query).
                        allowed_updates: ['message', 'callback_query'],
                    },
                    this.abort.signal,
                )
                clearTimeout(timeoutId)
                this.abort = null

                for (const u of updates) {
                    this.updatesSubject.next(u)
                    if (u.message?.text && u.message.from && !u.message.from.is_bot) {
                        this.inboundSubject.next(this.flatten(u.message))
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
                // Race the backoff sleep against stop(): if stop() arrives
                // mid-sleep we want to exit the loop before the timer fires,
                // otherwise the next iteration would poll one more time with
                // a potentially rotated token before noticing running=false.
                // stopSignal is non-null whenever this iteration runs — start()
                // initialises it before launching loop(). Assert to make the
                // invariant explicit; a non-resolving fallback promise would
                // wedge the loop if the invariant ever broke silently.
                const stopPromise = this.stopSignal!.promise
                let timer: ReturnType<typeof setTimeout> | null = null
                await Promise.race([
                    new Promise<void>(r => { timer = setTimeout(r, TelegramClientService.RETRY_MS) }),
                    stopPromise,
                ])
                if (timer) clearTimeout(timer)
            }
        }
    }

    private flatten (m: TgMessage): TgInboundMessage {
        return {
            chatId: m.chat.id,
            senderId: m.from!.id,
            senderUsername: m.from!.username,
            topicId: m.message_thread_id,
            text: m.text!,
            rawMessageId: m.message_id,
        }
    }

    /**
     * Flatten a raw callback_query into the downstream-friendly shape.
     * Returns null if the query lacks a bearing message (inline-mode
     * callbacks don't have one — we don't issue those, but defensive).
     */
    private flattenCallback (q: TgCallbackQuery): TgInboundCallback | null {
        if (!q.message || !q.data) return null
        return {
            callbackId: q.id,
            senderId: q.from.id,
            senderUsername: q.from.username,
            chatId: q.message.chat.id,
            topicId: q.message.message_thread_id,
            messageId: q.message.message_id,
            data: q.data,
        }
    }

    /**
     * Single API call. `null` values are stripped from the body — Telegram
     * is permissive but explicit absence reads cleaner in network logs and
     * avoids accidental zero-id collisions.
     */
    private async call<T> (
        method: string,
        body: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<T> {
        if (!this.token) throw new Error('TelegramClientService: no token; call start() first')
        const clean: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(body)) {
            if (v !== undefined && v !== null) clean[k] = v
        }
        // Default to the session-wide abort so a stop() tears down
        // in-flight outbound calls (sendMessage / createForumTopic etc.)
        // alongside the long-poll. Loop already passes its per-iteration
        // signal explicitly, overriding this default.
        const effectiveSignal = signal ?? this.sessionAbort?.signal
        let res: Response
        try {
            res = await fetch(
                `${TelegramClientService.API}/bot${this.token}/${method}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(clean),
                    signal: effectiveSignal,
                },
            )
        } catch (err) {
            // fetch() rejections (DNS, TLS, abort) stringify with the full URL
            // which contains the bot token. Redact before re-throwing or the
            // upstream `console.warn(..., err)` / appendAudit({ error }) will
            // persist the token to disk / devtools.
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`Telegram ${method}: ${redactToken(msg)}`)
        }
        const data = await res.json() as { ok: boolean; result?: T; description?: string; error_code?: number }
        if (!data.ok) {
            throw new TelegramApiError(method, data.error_code, data.description ?? 'unknown error')
        }
        return data.result as T
    }
}

export class TelegramApiError extends Error {
    constructor (
        public method: string,
        public code: number | undefined,
        public description: string,
    ) {
        super(`Telegram ${method} failed: ${description} (code=${code ?? 'n/a'})`)
        this.name = 'TelegramApiError'
    }
}
