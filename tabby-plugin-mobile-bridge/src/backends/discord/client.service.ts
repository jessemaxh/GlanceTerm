import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subject } from 'rxjs'

import {
    DC_BUTTON_DANGER,
    DC_BUTTON_PRIMARY,
    DC_BUTTON_SECONDARY,
    DC_CHANNEL_PRIVATE_THREAD,
    DC_CHANNEL_PUBLIC_THREAD,
    DC_DEFERRED_UPDATE_MESSAGE,
    DC_ERR_MISSING_ACCESS,
    DC_ERR_MISSING_PERMISSIONS,
    DC_ERR_THREAD_ARCHIVED,
    DC_ERR_UNKNOWN_CHANNEL,
    DC_INTERACTION_MESSAGE_COMPONENT,
    DcActionRow,
    DcApiError,
    DcChannel,
    DcHello,
    DcInteraction,
    DcMessage,
    DcReady,
    DcUser,
    FATAL_CLOSE_CODES,
    GATEWAY_INTENTS,
    GatewayOp,
    GatewayPayload,
} from './wire-types'
import {
    BackendCredentials,
    BackendLastError,
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
import { redactToken } from '../../audit-log'

/**
 * Discord implementation of {@link MessagingBackend}.
 *
 * Transport: the Gateway WebSocket (outbound-only — no public URL, no
 * webhook, matches the "BYO bot behind NAT" rule) for inbound events,
 * plain REST over fetch for everything outbound. Both use the browser
 * globals available in the Electron renderer (`WebSocket`, `fetch`), so
 * the backend adds zero dependencies — same spirit as the hand-rolled
 * Telegram long-poll next door.
 *
 * Per-tab surface: native Threads in the bound text channel. Unlike
 * Telegram topics / Feishu anchor emulation, Discord threads ARE
 * channels: a message *in* a thread arrives with `channel_id` equal to
 * the THREAD id, and the parent text channel is not on the message at
 * all. {@link resolveChannel} maintains a thread→parent cache (seeded
 * by createThread + THREAD_CREATE dispatches, backfilled by a REST
 * lookup) so inbound flattening can recover the cross-platform
 * (chatId, threadId) pair.
 *
 * Gateway lifecycle: HELLO → IDENTIFY → READY, heartbeat every
 * `heartbeat_interval`, RESUME on recoverable drops. Close codes listed
 * in {@link FATAL_CLOSE_CODES} (revoked token, Message Content Intent
 * not enabled) stop the reconnect loop and surface on lastError$ —
 * retrying those would only burn the daily session-start limit.
 */
@Injectable()
export class DiscordBackend implements MessagingBackend, OnDestroy {
    private static readonly API = 'https://discord.com/api/v10'
    private static readonly GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
    private static readonly RETRY_MS = 5_000
    /** Discord hard caps. */
    private static readonly MAX_CONTENT = 2_000
    private static readonly MAX_THREAD_NAME = 100
    private static readonly MAX_BUTTON_LABEL = 80

    private token = ''
    private running = false
    private startEpoch = 0
    private lifecycleQueue: Promise<void> = Promise.resolve()

    private ws: WebSocket | null = null
    private heartbeatHandle: ReturnType<typeof setInterval> | null = null
    private heartbeatKickoff: ReturnType<typeof setTimeout> | null = null
    private reconnectHandle: ReturnType<typeof setTimeout> | null = null
    private heartbeatAcked = true
    private lastSeq: number | null = null
    private sessionId: string | null = null
    private resumeGatewayUrl: string | null = null

    /** thread id → parent text-channel id; non-thread channels map to
     *  null. Bounded by the number of distinct channels the bot hears
     *  from in one session. */
    private channelParents = new Map<string, string | null>()
    private channelLookups = new Map<string, Promise<string | null>>()

    private inboundSubject = new Subject<InboundMessage>()
    private callbackSubject = new Subject<InboundCallback>()
    private runningSubject = new BehaviorSubject<boolean>(false)
    private identitySubject = new BehaviorSubject<BotIdentity | null>(null)
    private lastErrorSubject = new BehaviorSubject<BackendLastError | null>(null)

    constructor (private keystore: KeystoreService) {}

    get inbound$ (): Observable<InboundMessage> { return this.inboundSubject }
    get callbacks$ (): Observable<InboundCallback> { return this.callbackSubject }
    get running$ (): Observable<boolean> { return this.runningSubject }
    get identity$ (): Observable<BotIdentity | null> { return this.identitySubject }
    get lastError$ (): Observable<BackendLastError | null> { return this.lastErrorSubject }

    // ── Lifecycle ───────────────────────────────────────────────────────

    start (creds: BackendCredentials | PlaintextBackendCredentials): Promise<void> {
        if (creds.platform !== 'discord') {
            return Promise.reject(new Error(
                `DiscordBackend.start: expected discord credentials, got ${creds.platform}`,
            ))
        }
        const tokenOrRef = creds.botToken
        this.lastErrorSubject.next(null)
        return this.enqueueLifecycle(async () => {
            let token: string
            if (typeof tokenOrRef === 'string') {
                token = tokenOrRef
            } else {
                try {
                    token = await this.keystore.read(tokenOrRef.id)
                } catch (err) {
                    const wrapped = new MessagingError(
                        'auth_failed',
                        `DiscordBackend: keystore read failed (re-pair to recover): ${err instanceof Error ? err.message : String(err)}`,
                    )
                    this.recordError(wrapped)
                    throw wrapped
                }
            }
            if (this.running && this.token === token) return
            if (this.running) this.haltTransport()
            this.token = token
            // Probe identity over REST BEFORE opening the gateway — an
            // invalid token fails the pairing flow here, synchronously,
            // instead of as an async 4004 close the UI can't await.
            let me: DcUser
            try {
                me = await this.rest<DcUser>('GET', '/users/@me')
            } catch (err) {
                this.token = ''
                throw err
            }
            this.running = true
            this.startEpoch++
            this.sessionId = null
            this.resumeGatewayUrl = null
            this.lastSeq = null
            this.runningSubject.next(true)
            this.identitySubject.next(this.toBotIdentity(me))
            this.connectGateway(this.startEpoch)
        })
    }

    stop (): Promise<void> {
        return this.enqueueLifecycle(async () => {
            if (!this.running) return
            this.haltTransport()
            this.runningSubject.next(false)
            this.identitySubject.next(null)
        })
    }

    ngOnDestroy (): void {
        void this.stop()
    }

    /** Tear down WS + timers and invalidate in-flight handlers via the
     *  epoch bump. Does NOT touch the public subjects — callers decide
     *  whether this is a clean stop (clear identity) or a fatal-error
     *  halt (keep identity so the error banner has context). */
    private haltTransport (): void {
        this.running = false
        this.startEpoch++
        this.clearTimers()
        if (this.ws) {
            // Detach before close so the onclose handler doesn't schedule
            // a reconnect for a socket we're intentionally killing.
            this.ws.onmessage = null
            this.ws.onclose = null
            this.ws.onerror = null
            try { this.ws.close(1000) } catch { /* already closed */ }
            this.ws = null
        }
    }

    private clearTimers (): void {
        if (this.heartbeatHandle) { clearInterval(this.heartbeatHandle); this.heartbeatHandle = null }
        if (this.heartbeatKickoff) { clearTimeout(this.heartbeatKickoff); this.heartbeatKickoff = null }
        if (this.reconnectHandle) { clearTimeout(this.reconnectHandle); this.reconnectHandle = null }
    }

    private enqueueLifecycle (fn: () => Promise<void>): Promise<void> {
        const next = this.lifecycleQueue.then(fn)
        this.lifecycleQueue = next.then(() => undefined, () => undefined)
        return next
    }

    // ── Gateway connection ──────────────────────────────────────────────

    private connectGateway (epoch: number): void {
        if (epoch !== this.startEpoch || !this.running) return
        const resuming = this.sessionId !== null && this.resumeGatewayUrl !== null
        const url = resuming ? `${this.resumeGatewayUrl}/?v=10&encoding=json` : DiscordBackend.GATEWAY_URL
        let ws: WebSocket
        try {
            ws = new WebSocket(url)
        } catch (err) {
            // Synchronous constructor failure (malformed resume URL from
            // a hostile/buggy READY). Fall back to a fresh identify.
            this.sessionId = null
            this.resumeGatewayUrl = null
            this.scheduleReconnect(epoch)
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:discord] gateway connect failed:', err)
            return
        }
        this.ws = ws
        ws.onmessage = ev => {
            if (epoch !== this.startEpoch) return
            try {
                this.handlePayload(JSON.parse(ev.data as string) as GatewayPayload, resuming, epoch)
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:discord] bad gateway frame:', err)
            }
        }
        ws.onclose = ev => {
            if (epoch !== this.startEpoch) return
            this.handleClose(ev.code, epoch)
        }
        ws.onerror = () => {
            // onclose always follows onerror; reconnect logic lives there.
        }
    }

    private handlePayload (p: GatewayPayload, resuming: boolean, epoch: number): void {
        switch (p.op) {
            case GatewayOp.HELLO: {
                const interval = (p.d as DcHello).heartbeat_interval
                this.startHeartbeats(interval, epoch)
                if (resuming) {
                    this.send({
                        op: GatewayOp.RESUME,
                        d: { token: this.token, session_id: this.sessionId, seq: this.lastSeq },
                    })
                } else {
                    this.send({
                        op: GatewayOp.IDENTIFY,
                        d: {
                            token: this.token,
                            intents: GATEWAY_INTENTS,
                            properties: { os: process.platform, browser: 'glanceterm', device: 'glanceterm' },
                        },
                    })
                }
                break
            }
            case GatewayOp.HEARTBEAT_ACK:
                this.heartbeatAcked = true
                break
            case GatewayOp.HEARTBEAT:
                // Server-requested immediate beat.
                this.send({ op: GatewayOp.HEARTBEAT, d: this.lastSeq })
                break
            case GatewayOp.RECONNECT:
                // Server asks us to drop + resume. Close; onclose resumes.
                this.ws?.close(4900)
                break
            case GatewayOp.INVALID_SESSION:
                if (p.d !== true) {
                    // Not resumable — discard the session and re-identify
                    // on the next connect.
                    this.sessionId = null
                    this.resumeGatewayUrl = null
                    this.lastSeq = null
                }
                this.ws?.close(4901)
                break
            case GatewayOp.DISPATCH:
                if (typeof p.s === 'number') this.lastSeq = p.s
                this.handleDispatch(p.t ?? '', p.d)
                break
        }
    }

    private handleDispatch (t: string, d: unknown): void {
        switch (t) {
            case 'READY': {
                const ready = d as DcReady
                this.sessionId = ready.session_id
                this.resumeGatewayUrl = ready.resume_gateway_url
                this.identitySubject.next(this.toBotIdentity(ready.user))
                break
            }
            case 'THREAD_CREATE':
            case 'THREAD_UPDATE': {
                // Free cache warm-up for threads created by anyone in the
                // bound channel — saves the REST lookup on first message.
                const ch = d as DcChannel
                if (this.isThreadType(ch.type)) {
                    this.channelParents.set(ch.id, ch.parent_id ?? null)
                }
                break
            }
            case 'MESSAGE_CREATE':
                void this.onMessageCreate(d as DcMessage)
                break
            case 'INTERACTION_CREATE':
                void this.onInteractionCreate(d as DcInteraction)
                break
        }
    }

    private handleClose (code: number, epoch: number): void {
        this.clearTimers()
        this.ws = null
        if (!this.running) return
        const fatal = FATAL_CLOSE_CODES[code]
        if (fatal) {
            const err = new MessagingError(
                fatal.kind,
                `Discord gateway closed (${code}): ${fatal.hint}`,
            )
            this.recordError(err)
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:discord]', err.message)
            // Reconnecting can't fix a revoked token / missing intent and
            // would chew through the daily IDENTIFY budget. Halt; the next
            // start() (re-pair, toggle, app restart) tries fresh.
            this.haltTransport()
            this.runningSubject.next(false)
            return
        }
        this.scheduleReconnect(epoch)
    }

    private scheduleReconnect (epoch: number): void {
        if (this.reconnectHandle) return
        this.reconnectHandle = setTimeout(() => {
            this.reconnectHandle = null
            if (epoch !== this.startEpoch || !this.running) return
            this.connectGateway(epoch)
        }, DiscordBackend.RETRY_MS)
    }

    private startHeartbeats (intervalMs: number, epoch: number): void {
        this.heartbeatAcked = true
        const beat = (): void => {
            if (epoch !== this.startEpoch || !this.ws) return
            if (!this.heartbeatAcked) {
                // Zombie connection — no ACK since our last beat. Drop and
                // resume per gateway spec.
                this.ws.close(4902)
                return
            }
            this.heartbeatAcked = false
            this.send({ op: GatewayOp.HEARTBEAT, d: this.lastSeq })
        }
        // Spec: first beat after interval × random jitter, then steady.
        this.heartbeatKickoff = setTimeout(() => {
            beat()
            this.heartbeatHandle = setInterval(beat, intervalMs)
        }, Math.floor(intervalMs * Math.random()))
    }

    private send (payload: GatewayPayload): void {
        try {
            this.ws?.send(JSON.stringify(payload))
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[mobile-bridge:discord] gateway send failed:', err)
        }
    }

    // ── Inbound flattening ──────────────────────────────────────────────

    private async onMessageCreate (m: DcMessage): Promise<void> {
        if (!m.author || m.author.bot) return
        if (typeof m.content !== 'string' || m.content.length === 0) return
        const parentId = await this.parentOf(m.channel_id)
        this.inboundSubject.next({
            platform: 'discord',
            chatId: parentId ?? m.channel_id,
            threadId: parentId !== null ? m.channel_id : null,
            senderId: m.author.id,
            senderName: m.author.username,
            text: m.content,
            messageId: m.id,
        })
    }

    private async onInteractionCreate (i: DcInteraction): Promise<void> {
        if (i.type !== DC_INTERACTION_MESSAGE_COMPONENT) return
        const data = i.data?.custom_id
        const message = i.message
        const channelId = i.channel_id
        const user = i.member?.user ?? i.user
        if (!data || !message || !channelId || !user) return
        const parentId = await this.parentOf(channelId)
        this.callbackSubject.next({
            platform: 'discord',
            // Interaction callbacks are addressed by (id, token), not by
            // bot auth. ':' is safe — ids are numeric snowflakes.
            callbackId: `${i.id}:${i.token}`,
            chatId: parentId ?? channelId,
            threadId: parentId !== null ? channelId : null,
            messageId: message.id,
            senderId: user.id,
            data,
        })
    }

    /** Parent text-channel id when `channelId` is a thread; null when
     *  it's a plain channel (or the lookup failed — plain-channel
     *  fallback keeps /bind working even if a REST hiccup eats the
     *  lookup; a thread message misrouted to "no thread" is dropped by
     *  the router's binding match rather than mis-delivered). */
    private parentOf (channelId: string): Promise<string | null> {
        const cached = this.channelParents.get(channelId)
        if (cached !== undefined) return Promise.resolve(cached)
        let inflight = this.channelLookups.get(channelId)
        if (!inflight) {
            inflight = (async () => {
                try {
                    const ch = await this.rest<DcChannel>('GET', `/channels/${channelId}`)
                    const parent = this.isThreadType(ch.type) ? ch.parent_id ?? null : null
                    this.channelParents.set(channelId, parent)
                    return parent
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:discord] channel lookup failed:', redactToken(err instanceof Error ? err.message : String(err)))
                    return null
                } finally {
                    this.channelLookups.delete(channelId)
                }
            })()
            this.channelLookups.set(channelId, inflight)
        }
        return inflight
    }

    private isThreadType (type: number): boolean {
        return type === DC_CHANNEL_PUBLIC_THREAD || type === DC_CHANNEL_PRIVATE_THREAD
    }

    // ── MessagingBackend surface ────────────────────────────────────────

    async createThread (chatId: ChatRef, title: string): Promise<ThreadRef> {
        const thread = await this.rest<DcChannel>('POST', `/channels/${chatId}/threads`, {
            name: title.slice(0, DiscordBackend.MAX_THREAD_NAME),
            type: DC_CHANNEL_PUBLIC_THREAD,
            auto_archive_duration: 10080,
        }, chatId)
        this.channelParents.set(thread.id, thread.parent_id ?? chatId)
        return thread.id
    }

    async closeThread (_chatId: ChatRef, threadId: ThreadRef, _currentTitle?: string): Promise<void> {
        // Native archive — the bot created the thread, and thread owners
        // can archive without MANAGE_THREADS.
        await this.rest('PATCH', `/channels/${threadId}`, { archived: true }, threadId)
    }

    async reopenThread (_chatId: ChatRef, threadId: ThreadRef, _restoreTitle?: string): Promise<void> {
        await this.rest('PATCH', `/channels/${threadId}`, { archived: false }, threadId)
    }

    async renameThread (_chatId: ChatRef, threadId: ThreadRef, title: string): Promise<void> {
        await this.rest('PATCH', `/channels/${threadId}`, {
            name: title.slice(0, DiscordBackend.MAX_THREAD_NAME),
        }, threadId)
    }

    async sendText (
        chatId: ChatRef,
        threadId: ThreadRef,
        body: string,
        _opts?: SendOptions,
    ): Promise<MessageRef> {
        // Threads ARE channels: post to the thread id directly.
        const target = threadId || chatId
        const sent = await this.rest<DcMessage>('POST', `/channels/${target}/messages`, {
            content: this.clampContent(body),
        }, target)
        return { chatId, threadId, messageId: sent.id }
    }

    async sendInteractive (
        chatId: ChatRef,
        threadId: ThreadRef,
        spec: InteractiveSpec,
    ): Promise<MessageRef> {
        const target = threadId || chatId
        const sent = await this.rest<DcMessage>('POST', `/channels/${target}/messages`, {
            content: this.clampContent(spec.body),
            components: this.toComponents(spec),
        }, target)
        return { chatId, threadId, messageId: sent.id }
    }

    async editMessage (ref: MessageRef, body: string, opts?: EditOptions): Promise<void> {
        const channel = ref.threadId ?? ref.chatId
        await this.rest('PATCH', `/channels/${channel}/messages/${ref.messageId}`, {
            content: this.clampContent(body),
            ...opts?.clearButtons ? { components: [] } : {},
        }, channel)
    }

    async ackCallback (callbackId: string): Promise<void> {
        const sep = callbackId.indexOf(':')
        if (sep < 0) throw new MessagingError('unknown', 'DiscordBackend.ackCallback: malformed callback id')
        const id = callbackId.slice(0, sep)
        const token = callbackId.slice(sep + 1)
        // Must land within ~3s of the tap or the user sees
        // "interaction failed" — the router acks before slow work.
        await this.rest('POST', `/interactions/${id}/${encodeURIComponent(token)}/callback`, {
            type: DC_DEFERRED_UPDATE_MESSAGE,
        })
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private toComponents (spec: InteractiveSpec): DcActionRow[] {
        return spec.buttons.map(row => ({
            type: 1 as const,
            components: row.map(b => ({
                type: 2 as const,
                style: b.style === 'danger' ? DC_BUTTON_DANGER
                    : b.style === 'primary' ? DC_BUTTON_PRIMARY
                        : DC_BUTTON_SECONDARY,
                label: b.label.slice(0, DiscordBackend.MAX_BUTTON_LABEL),
                custom_id: b.value,
            })),
        }))
    }

    private clampContent (body: string): string {
        if (body.length <= DiscordBackend.MAX_CONTENT) return body
        return `${body.slice(0, DiscordBackend.MAX_CONTENT - 1)}…`
    }

    private toBotIdentity (user: DcUser): BotIdentity {
        return {
            id: user.id,
            displayName: `@${user.username}`,
            platformLabel: 'Discord',
        }
    }

    private recordError (err: MessagingError): void {
        this.lastErrorSubject.next({
            kind: err.kind,
            message: redactToken(err.message),
            occurredAt: Date.now(),
        })
    }

    // ── REST + error translation ────────────────────────────────────────

    private async rest<T> (
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path: string,
        body?: unknown,
        /** When set, a 10003 Unknown Channel is classified against the
         *  thread-parent cache: known thread → thread_not_found, else
         *  chat_not_found. */
        channelIdHint?: string,
    ): Promise<T> {
        if (!this.token) throw new MessagingError('auth_failed', 'DiscordBackend: not started')
        let res: Response
        try {
            res = await fetch(`${DiscordBackend.API}${path}`, {
                method,
                headers: {
                    Authorization: `Bot ${this.token}`,
                    'Content-Type': 'application/json',
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
            })
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new MessagingError('unknown', `Discord ${method} ${path}: ${redactToken(msg)}`)
        }
        if (res.status === 204) return undefined as T
        let data: unknown = null
        try {
            data = await res.json()
        } catch {
            // Non-JSON body on an error status falls through to the
            // status-only classification below.
        }
        if (!res.ok) {
            const apiErr = (data ?? {}) as DcApiError
            const err = this.translateError(method, path, res.status, apiErr, channelIdHint)
            if (err.kind === 'auth_failed') this.recordError(err)
            throw err
        }
        return data as T
    }

    private translateError (
        method: string,
        path: string,
        status: number,
        apiErr: DcApiError,
        channelIdHint?: string,
    ): MessagingError {
        const kind = this.classifyError(status, apiErr.code, channelIdHint)
        // path never contains the token (it rides the Authorization
        // header) — safe to embed for context.
        const message = `Discord ${method} ${path} failed: ${apiErr.message ?? 'unknown error'} (status=${status}, code=${apiErr.code ?? 'n/a'})`
        return new MessagingError(
            kind,
            message,
            apiErr.retry_after !== undefined ? Math.ceil(apiErr.retry_after * 1000) : undefined,
        )
    }

    private classifyError (status: number, code: number | undefined, channelIdHint?: string): MessagingErrorKind {
        if (status === 429) return 'rate_limited'
        if (status === 401) return 'auth_failed'
        if (code === DC_ERR_THREAD_ARCHIVED) return 'thread_closed'
        if (code === DC_ERR_MISSING_ACCESS || code === DC_ERR_MISSING_PERMISSIONS || status === 403) {
            return 'permission_denied'
        }
        if (code === DC_ERR_UNKNOWN_CHANNEL) {
            const known = channelIdHint !== undefined ? this.channelParents.get(channelIdHint) : undefined
            return typeof known === 'string' ? 'thread_not_found' : 'chat_not_found'
        }
        return 'unknown'
    }
}
