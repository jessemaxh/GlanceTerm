import { Observable } from 'rxjs'

/**
 * Cross-platform messaging surface for the mobile bridge.
 *
 * One {@link MessagingBackend} instance per platform; each instance handles
 * at most one active binding session (matches the v0 single-binding-per-
 * platform cap). The interface intentionally omits anything Telegram- or
 * Feishu-specific — the dispatcher / topic-sync / permission-relay code
 * depend on this contract alone, never on platform wire types.
 *
 * See docs/feishu-bridge-design.md for the rationale + Phase 1/2/3
 * rollout.
 */

/** All identifier types are strings even when the underlying platform uses
 *  numeric ids (Telegram chat / message). Conversion happens at the
 *  backend boundary so the cross-cutting code (TopicService cache keys,
 *  JSON persistence, settings UI) doesn't carry numeric-vs-string
 *  ambiguity. */
export type ChatRef = string
export type ThreadRef = string

/** Outbound message handle. Returned by {@link MessagingBackend.sendText} /
 *  {@link MessagingBackend.sendInteractive}; consumed by
 *  {@link MessagingBackend.editMessage}. Carries enough context that the
 *  edit call doesn't need its chatId / threadId rethreaded from the
 *  caller's bookkeeping. */
export interface MessageRef {
    chatId: ChatRef
    /** null for chats without thread/topic semantics (TG 1:1, Feishu p2p). */
    threadId: ThreadRef | null
    messageId: string
}

/** Bot identity surfaced in the settings UI status row. */
export interface BotIdentity {
    /** Platform-native bot id. Telegram: numeric stringified. Feishu: app_id. */
    id: string
    /** UI-friendly handle. Telegram: "@MyBot"; Feishu: app display name. */
    displayName: string
    /** "Telegram" | "Feishu" | "Lark" — used by the settings status row. */
    platformLabel: string
}

/** User-sent text the bot can hear. Subscribers (InboundRouter, Pairing)
 *  filter on chatId / sender. */
export interface InboundMessage {
    chatId: ChatRef
    /** null when the message arrived outside a thread (DM, general topic). */
    threadId: ThreadRef | null
    senderId: string
    senderName?: string
    text: string
    messageId: string
}

/** Button-tap / structured callback (permission-relay verdict path). */
export interface InboundCallback {
    /** Platform-supplied click event id. Pass to
     *  {@link MessagingBackend.ackCallback} so the user's button stops
     *  spinning. Telegram requires the ack within ~30s. */
    callbackId: string
    chatId: ChatRef
    threadId: ThreadRef | null
    /** The message that bore the button — for editing it after verdict. */
    messageId: string
    senderId: string
    /** Bot-controlled payload set at sendInteractive time (e.g.
     *  `"perm:allow:abcde"`). Capped at 64 bytes for Telegram compatibility. */
    data: string
}

export interface SendOptions {
    /** Reserved for v2. Telegram supports MarkdownV2/HTML; Feishu uses a
     *  JSON-based rich-text format. v1 sticks to plain text. */
    formatHint?: 'plain' | 'markdown'
}

export interface EditOptions extends SendOptions {
    /** Strip the inline keyboard / card buttons. Used by permission-relay
     *  to neutralise the original prompt after a verdict lands so the
     *  user can't tap the now-stale buttons. */
    clearButtons?: boolean
}

/** One button in an interactive prompt. Multiple per row supported. */
export interface InteractiveButton {
    label: string
    /** Echoed back as {@link InboundCallback.data} when tapped. ≤64 bytes
     *  to satisfy Telegram's hard limit on callback_data — Feishu accepts
     *  larger payloads but we cap for cross-platform consistency. */
    value: string
    style?: 'primary' | 'danger' | 'default'
}

/** Structured spec for an interactive prompt. Backend translates to the
 *  platform-native shape (TG inline_keyboard JSON / Feishu card JSON). */
export interface InteractiveSpec {
    /** Plain text body of the prompt. */
    body: string
    /** Button rows. Outer array = rows; inner = buttons within a row.
     *  Permission relay uses one row of two buttons (Allow / Deny). */
    buttons: InteractiveButton[][]
}

/**
 * Platform-tagged credentials. Discriminated union so a binding's stored
 * credentials map 1:1 to the backend that consumes them, with no
 * "either-or" type guards needed at call sites.
 */
export type BackendCredentials =
    | { platform: 'telegram'; botToken: string }
    | { platform: 'feishu'; appId: string; appSecret: string; region: 'feishu' | 'lark' }

/** Cross-platform error category. Backends translate
 *  platform-specific errors (HTTP codes, error descriptions) into this
 *  small taxonomy so callers can branch on `kind` without knowing wire
 *  details. */
export type MessagingErrorKind =
    | 'thread_closed'      // TG: TOPIC_CLOSED · Feishu: anchor marked closed
    | 'thread_not_found'   // both: thread id is invalid / deleted
    | 'chat_not_found'     // both: chat id invalid / bot kicked
    | 'auth_failed'        // bot token revoked / token refresh failed
    | 'rate_limited'       // TG: 429 · Feishu: 99991663
    | 'permission_denied'  // bot lacks can_manage_topics / equivalent
    | 'unknown'

/** Single error type backends throw out of their interface methods. */
export class MessagingError extends Error {
    constructor (
        public kind: MessagingErrorKind,
        message: string,
        /** Set on `rate_limited` — backoff hint from the platform. */
        public retryAfterMs?: number,
    ) {
        super(message)
        this.name = 'MessagingError'
    }
}

/**
 * The cross-platform messaging surface. Implemented per platform; consumed
 * by OutboundDispatcher / TopicService / PermissionRelay through
 * {@link BackendRegistry.forPlatform}.
 *
 * Lifecycle: callers invoke {@link start} with platform-tagged credentials
 * (only the variant matching this instance's platform is accepted; other
 * variants throw). {@link stop} tears down the transport. {@link running$}
 * / {@link identity$} reflect lifecycle state reactively for the UI.
 *
 * Thread semantics: some platforms (Telegram Forum Topics) have first-
 * class create/close/rename APIs; others (Feishu) emulate close/rename by
 * editing an anchor message. Backends handle the platform mapping; the
 * uniform interface lets callers ignore the difference.
 */
export interface MessagingBackend {
    start (creds: BackendCredentials): Promise<void>
    stop (): Promise<void>

    readonly running$: Observable<boolean>
    readonly identity$: Observable<BotIdentity | null>

    createThread (chatId: ChatRef, title: string): Promise<ThreadRef>
    closeThread (chatId: ChatRef, threadId: ThreadRef): Promise<void>
    reopenThread (chatId: ChatRef, threadId: ThreadRef): Promise<void>
    renameThread (chatId: ChatRef, threadId: ThreadRef, title: string): Promise<void>

    sendText (
        chatId: ChatRef,
        threadId: ThreadRef,
        body: string,
        opts?: SendOptions,
    ): Promise<MessageRef>

    sendInteractive (
        chatId: ChatRef,
        threadId: ThreadRef,
        spec: InteractiveSpec,
    ): Promise<MessageRef>

    editMessage (
        ref: MessageRef,
        body: string,
        opts?: EditOptions,
    ): Promise<void>

    /** No-op on platforms that don't require an ack (Feishu). Telegram
     *  requires this within ~30s of the callback or the button spinner
     *  hangs on the user's phone. */
    ackCallback (callbackId: string): Promise<void>

    readonly inbound$: Observable<InboundMessage>
    readonly callbacks$: Observable<InboundCallback>
}
