import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subject } from 'rxjs'

// Lark SDK lives under @larksuiteoapi/node-sdk. The types entry exports
// LarkChannel + createLarkChannel + the normalized event shapes we
// translate at the boundary.
import {
    CardActionEvent,
    LarkChannel,
    LarkChannelError,
    LarkChannelErrorCode,
    LarkChannelOptions,
    NormalizedMessage,
    createLarkChannel,
} from '@larksuiteoapi/node-sdk'

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
    PlaintextBackendCredentials,
    SendOptions,
    ThreadRef,
} from '../types'
import { KeystoreService } from '../../keystore.service'

/**
 * Feishu / Lark implementation of {@link MessagingBackend}.
 *
 * Built on top of the official `@larksuiteoapi/node-sdk` LarkChannel
 * abstraction — WebSocket transport + tenant_access_token refresh +
 * dispatcher are owned by the SDK, so this class is mostly a translation
 * layer between MessagingBackend semantics and the SDK's API.
 *
 * Threading model: Feishu has no "create thread" primitive — threads are
 * born from the first message that uses reply_in_thread. We adopt a
 * convention where each "topic" (= tab) gets a dedicated anchor message
 * in the supergroup (which the user has switched to 话题模式 mode for the
 * 1-to-1 Forum-Topics analogue). The anchor message's ID acts as our
 * {@link ThreadRef} — every subsequent send/edit references it as
 * `replyTo` + `replyInThread: true`, which Feishu auto-routes into the
 * thread the anchor started. Closing a tab edits the anchor to add a
 * 📕 marker (no native close-thread API).
 *
 * Why not use Feishu's actual `thread_id` (omt_xxx) as our ThreadRef:
 * the SDK's SendResult only carries `messageId` — getting the
 * platform-side thread_id requires a follow-up `im.v1.message.get` call
 * per create. We get the same round-trip savings by using the anchor
 * messageId as the routing key, with inbound routing matching against
 * NormalizedMessage.replyToMessageId (which equals our anchor for
 * top-of-thread replies).
 */
@Injectable()
export class FeishuBackend implements MessagingBackend, OnDestroy {
    private channel: LarkChannel | null = null
    /** Full session fingerprint (appId|region|appSecret-hash) used by
     *  start() to detect a no-op re-pair vs a real credentials change.
     *  Previously the equality check used appId alone, which silently
     *  swallowed appSecret rotations or feishu↔lark region switches —
     *  the channel kept its stale creds and eventually failed token
     *  refresh mid-session. */
    private sessionKey = ''
    private connected = false
    /** Bumped on every successful connect AND every disconnect — used to
     *  invalidate late-arriving event handlers from a previous session
     *  after a stop()/start() rotation. Symmetric with TelegramBackend's
     *  startEpoch guard. */
    private startEpoch = 0
    /** Serialises connect/disconnect/reconnect so concurrent callers don't
     *  end up with two LarkChannel instances racing on the same token. */
    private lifecycleQueue: Promise<void> = Promise.resolve()
    private unsubscribers: Array<() => void> = []

    private inboundSubject = new Subject<InboundMessage>()
    private callbackSubject = new Subject<InboundCallback>()
    private runningSubject = new BehaviorSubject<boolean>(false)
    private identitySubject = new BehaviorSubject<BotIdentity | null>(null)

    get inbound$ (): Observable<InboundMessage> { return this.inboundSubject }
    get callbacks$ (): Observable<InboundCallback> { return this.callbackSubject }
    get running$ (): Observable<boolean> { return this.runningSubject }
    get identity$ (): Observable<BotIdentity | null> { return this.identitySubject }

    constructor (private keystore: KeystoreService) {}

    ngOnDestroy (): void {
        void this.stop()
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    start (creds: BackendCredentials | PlaintextBackendCredentials): Promise<void> {
        if (creds.platform !== 'feishu') {
            return Promise.reject(new Error(
                `FeishuBackend.start: expected feishu credentials, got ${creds.platform}`,
            ))
        }
        return this.enqueueLifecycle(async () => {
            const appSecret = await this.resolveSecret(creds.appSecret)
            // Compose a session fingerprint that includes EVERY field the
            // SDK keeps internally — change any one and the channel must
            // reconnect. Storing the raw appSecret in this string keeps
            // it co-located with the SDK's own copy; no new exposure
            // surface. Region matters because feishu/lark map to
            // different base URLs.
            const nextKey = `${creds.appId}|${creds.region}|${appSecret}`
            if (this.connected && this.sessionKey === nextKey) return
            if (this.connected) await this.haltChannel()
            this.sessionKey = nextKey
            this.startEpoch++
            const epoch = this.startEpoch
            const opts: LarkChannelOptions = {
                appId: creds.appId,
                appSecret,
                domain: this.regionToDomain(creds.region),
                transport: 'websocket',
                // Source tag flows into the bot's User-Agent — useful for
                // distinguishing GlanceTerm bridge traffic from other
                // bots in Feishu's audit logs.
                source: 'glanceterm-mobile-bridge',
            }
            const channel = createLarkChannel(opts)
            // Wire handlers BEFORE connect — Feishu can fire `botAdded` /
            // `message` during the initial handshake catch-up.
            this.attachHandlers(channel, epoch)
            try {
                await channel.connect()
            } catch (err) {
                this.detachHandlers()
                // SDK may have started token-refresh timers / WS reconnect
                // loops inside createLarkChannel/connect before throwing.
                // Tear them down before bubbling the error so the next
                // start() attempt doesn't race against an orphan loop.
                // Best-effort: disconnect itself can throw on a half-init
                // channel — swallow.
                try { await channel.disconnect() } catch { /* ignore */ }
                this.sessionKey = ''
                throw this.translateLarkError(err, 'connect')
            }
            this.channel = channel
            this.connected = true
            this.runningSubject.next(true)
            // botIdentity is populated by the SDK during connect().
            if (channel.botIdentity) {
                this.identitySubject.next(this.toBotIdentity(channel.botIdentity))
            }
        })
    }

    stop (): Promise<void> {
        return this.enqueueLifecycle(() => this.haltChannel())
    }

    private async haltChannel (): Promise<void> {
        if (!this.connected) return
        this.connected = false
        this.sessionKey = ''
        const channel = this.channel
        this.channel = null
        this.detachHandlers()
        // Bump epoch BEFORE clearing identity to invalidate any in-flight
        // botIdentity probe queued by start().
        this.startEpoch++
        try {
            if (channel) await channel.disconnect()
        } catch {
            // SDK's disconnect can throw if WS was already broken — irrelevant.
        }
        this.runningSubject.next(false)
        this.identitySubject.next(null)
    }

    private enqueueLifecycle (fn: () => Promise<void>): Promise<void> {
        const next = this.lifecycleQueue.then(fn)
        this.lifecycleQueue = next.then(() => undefined, () => undefined)
        return next
    }

    private async resolveSecret (
        value: string | { source: 'keystore'; id: string },
    ): Promise<string> {
        if (typeof value === 'string') return value
        try {
            return await this.keystore.read(value.id)
        } catch (err) {
            throw new MessagingError(
                'auth_failed',
                `FeishuBackend: keystore read failed (re-pair to recover): ${err instanceof Error ? err.message : String(err)}`,
            )
        }
    }

    private regionToDomain (region: 'feishu' | 'lark'): string {
        return region === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com'
    }

    private toBotIdentity (raw: { openId: string; userId?: string; name: string }): BotIdentity {
        return {
            id: raw.openId,
            displayName: raw.name || `bot ${raw.openId.slice(0, 6)}`,
            platformLabel: 'Feishu',
        }
    }

    // ── Event wiring ────────────────────────────────────────────────────

    private attachHandlers (channel: LarkChannel, epoch: number): void {
        const offMessage = channel.on('message', (evt: NormalizedMessage) => {
            // Epoch guard — a late event arriving after stop() can't be
            // mistaken for current-session traffic.
            if (epoch !== this.startEpoch) return
            // Self-message filter. Read identity from the channel via
            // closure rather than this.identitySubject.value — the SDK
            // populates channel.botIdentity during connect() before any
            // message handler can fire, but our identitySubject is set
            // AFTER `await channel.connect()` resolves. That gap let
            // pre-resolve catch-up frames slip through as inbound with
            // me === null. Reading via the channel closes the window.
            const myId = channel.botIdentity?.openId
            if (myId && evt.senderId === myId) return
            this.inboundSubject.next(this.flattenMessage(evt))
        })
        const offCard = channel.on('cardAction', (evt: CardActionEvent) => {
            if (epoch !== this.startEpoch) return
            const flat = this.flattenCardAction(evt)
            if (flat) this.callbackSubject.next(flat)
        })
        this.unsubscribers.push(offMessage, offCard)
    }

    private detachHandlers (): void {
        for (const off of this.unsubscribers) {
            try { off() } catch { /* SDK may double-unsubscribe; ignore */ }
        }
        this.unsubscribers = []
    }

    private flattenMessage (m: NormalizedMessage): InboundMessage {
        return {
            chatId: m.chatId,
            // Inbound NormalizedMessage carries Feishu's thread_id directly
            // (omt_xxx). For our routing, we treat threadId as the anchor
            // messageId — see class doc. Inbound matching is on
            // replyToMessageId (the actual anchor the user replied to);
            // we surface that here so InboundRouter's findByThread sees
            // the right key.
            threadId: m.replyToMessageId ?? m.threadId ?? null,
            senderId: m.senderId,
            senderName: m.senderName,
            text: m.content,
            messageId: m.messageId,
        }
    }

    private flattenCardAction (evt: CardActionEvent): InboundCallback | null {
        // CardActionEvent.action.value is the bot-set payload we attached
        // at sendInteractive time (e.g. `"perm:allow:abcde"`). Anything
        // else (button without a value) is a misconfiguration on our
        // side; surface as null so InboundRouter ignores it cleanly.
        const value = evt.action.value
        if (typeof value !== 'string') return null
        return {
            platform: 'feishu',
            callbackId: evt.messageId, // Feishu has no separate ack id
            chatId: evt.chatId,
            // We don't know the thread for card actions without extra
            // bookkeeping. PermissionRelay's routing keys on senderId +
            // permId encoded in the value, not threadId.
            threadId: null,
            messageId: evt.messageId,
            senderId: evt.operator.openId,
            data: value,
        }
    }

    // ── MessagingBackend surface ────────────────────────────────────────

    async createThread (chatId: ChatRef, title: string): Promise<ThreadRef> {
        const channel = this.requireChannel()
        try {
            // No replyTo / replyInThread on the first send — in a
            // 话题模式 group every top-level message auto-creates a thread,
            // and we treat the returned messageId as the anchor / our
            // ThreadRef for subsequent operations.
            const result = await channel.send(chatId, { text: title })
            return result.messageId
        } catch (err) {
            throw this.translateLarkError(err, 'createThread')
        }
    }

    async closeThread (chatId: ChatRef, threadId: ThreadRef, currentTitle?: string): Promise<void> {
        const channel = this.requireChannel()
        try {
            // Feishu has no closeForumTopic API. Edit the anchor message
            // to prefix the title with a closed marker. Preserving the
            // title is important — the caller cache discards `lastTitle`
            // semantics post-close, and we can't read the current anchor
            // text back without an extra im.v1.message.get round trip.
            // Fallback to a generic marker if the caller didn't pass a
            // title (lazy-create path; rare).
            const body = currentTitle ? `📕 ${currentTitle}` : '📕 (closed)'
            await channel.editMessage(threadId, body)
        } catch (err) {
            throw this.translateLarkError(err, 'closeThread')
        }
    }

    async reopenThread (chatId: ChatRef, threadId: ThreadRef, restoreTitle?: string): Promise<void> {
        const channel = this.requireChannel()
        try {
            // Mirror closeThread: strip the marker by writing the
            // original title back. If the caller doesn't know the title,
            // syncRetitleTopic will fire shortly after with the
            // displayIndex-derived title — '(reopening)' is the briefly-
            // visible bridge state.
            const body = restoreTitle ?? '(reopening)'
            await channel.editMessage(threadId, body)
        } catch (err) {
            throw this.translateLarkError(err, 'reopenThread')
        }
    }

    async renameThread (chatId: ChatRef, threadId: ThreadRef, title: string): Promise<void> {
        const channel = this.requireChannel()
        try {
            await channel.editMessage(threadId, title)
        } catch (err) {
            throw this.translateLarkError(err, 'renameThread')
        }
    }

    async sendText (
        chatId: ChatRef,
        threadId: ThreadRef,
        body: string,
        _opts?: SendOptions,
    ): Promise<MessageRef> {
        const channel = this.requireChannel()
        try {
            const result = await channel.send(
                chatId,
                { text: body },
                { replyTo: threadId, replyInThread: true },
            )
            return { chatId, threadId, messageId: result.messageId }
        } catch (err) {
            throw this.translateLarkError(err, 'sendText')
        }
    }

    async sendInteractive (
        chatId: ChatRef,
        threadId: ThreadRef,
        spec: InteractiveSpec,
    ): Promise<MessageRef> {
        const channel = this.requireChannel()
        try {
            const card = this.buildInteractiveCard(spec)
            const result = await channel.send(
                chatId,
                { card },
                { replyTo: threadId, replyInThread: true },
            )
            return { chatId, threadId, messageId: result.messageId }
        } catch (err) {
            throw this.translateLarkError(err, 'sendInteractive')
        }
    }

    async editMessage (
        ref: MessageRef,
        body: string,
        opts?: EditOptions,
    ): Promise<void> {
        const channel = this.requireChannel()
        try {
            if (opts?.clearButtons) {
                // PermissionRelay's "neutralise after verdict" path: replace
                // the card with a plain-body card (no buttons). updateCard
                // is the correct API for cards; editMessage is text-only.
                await channel.updateCard(ref.messageId, this.buildPlainCard(body))
            } else {
                await channel.editMessage(ref.messageId, body)
            }
        } catch (err) {
            throw this.translateLarkError(err, 'editMessage')
        }
    }

    async ackCallback (_callbackId: string): Promise<void> {
        // Feishu auto-acks card actions on receipt — no separate API call
        // required (unlike Telegram's answerCallbackQuery). No-op for
        // interface symmetry.
    }

    // ── Card builders ───────────────────────────────────────────────────

    private buildInteractiveCard (spec: InteractiveSpec): object {
        return {
            config: { wide_screen_mode: true },
            elements: [
                { tag: 'markdown', content: spec.body },
                ...spec.buttons.map(row => ({
                    tag: 'action',
                    actions: row.map(b => ({
                        tag: 'button',
                        text: { tag: 'plain_text', content: b.label },
                        type: b.style === 'danger' ? 'danger'
                            : b.style === 'primary' ? 'primary'
                            : 'default',
                        value: b.value,
                    })),
                })),
            ],
        }
    }

    private buildPlainCard (body: string): object {
        return {
            config: { wide_screen_mode: true },
            elements: [{ tag: 'markdown', content: body }],
        }
    }

    // ── Errors ──────────────────────────────────────────────────────────

    private requireChannel (): LarkChannel {
        if (!this.channel) {
            throw new MessagingError('auth_failed', 'FeishuBackend: not connected')
        }
        return this.channel
    }

    /**
     * Translate {@link LarkChannelError} / axios / generic Errors into
     * {@link MessagingError}.
     *
     * Layered inspection: LarkChannelError carries a high-level code that
     * maps directly to our kinds; below that, axios-shaped errors
     * (response.status) surface from raw REST round trips the SDK does
     * for token refresh / occasional REST fallback paths; below that,
     * Node net errors (ECONNRESET, ETIMEDOUT) signal transport-layer
     * problems. Unrecognized shapes degrade to 'unknown' so callers
     * audit-log rather than silently misclassify.
     */
    private translateLarkError (err: unknown, method: string): MessagingError {
        const message = err instanceof Error ? err.message : String(err)
        const wrapped = `Feishu ${method} failed: ${message}`
        const kind = this.classifyError(err)
        return new MessagingError(kind, wrapped)
    }

    private classifyError (err: unknown): MessagingErrorKind {
        const lark = (err as Partial<LarkChannelError>).code as LarkChannelErrorCode | undefined
        switch (lark) {
            case 'rate_limited':    return 'rate_limited'
            case 'permission_denied': return 'permission_denied'
            case 'target_revoked':  return 'thread_not_found'
            case 'not_connected':   return 'auth_failed'
            case 'format_error':
            case 'upload_failed':
            case 'ssrf_blocked':
            case 'send_timeout':
            case 'unknown':
                return 'unknown'
        }
        // Axios HTTP error shape — present on token-refresh / REST
        // fallback failures. We look at the response status when the
        // LarkChannelError code didn't carry the signal.
        const httpStatus = (err as { response?: { status?: number } }).response?.status
        if (httpStatus === 429) return 'rate_limited'
        if (httpStatus === 401 || httpStatus === 403) return 'auth_failed'
        // Node net errors — ws disconnect storms, DNS failures.
        const sysCode = (err as { code?: string }).code
        if (sysCode === 'ECONNRESET' || sysCode === 'ETIMEDOUT' || sysCode === 'ENOTFOUND') {
            return 'unknown' // transport hiccup — retryWithBackoff will retry
        }
        return 'unknown'
    }
}
