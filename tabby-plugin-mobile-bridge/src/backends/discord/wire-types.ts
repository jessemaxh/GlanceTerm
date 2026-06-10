/**
 * Discord wire types — Gateway payloads + the REST objects we touch.
 * Internal to the discord backend; everything is translated to the
 * cross-platform shapes in ../types.ts at the boundary (snowflakes stay
 * strings, which matches ChatRef/ThreadRef directly).
 *
 * Only the fields the bridge reads are typed; Discord objects carry far
 * more. v10 API.
 */

// ── Gateway opcodes ─────────────────────────────────────────────────────

export const GatewayOp = {
    DISPATCH: 0,
    HEARTBEAT: 1,
    IDENTIFY: 2,
    RESUME: 6,
    RECONNECT: 7,
    INVALID_SESSION: 9,
    HELLO: 10,
    HEARTBEAT_ACK: 11,
} as const

/** Gateway intents the bridge needs. GUILDS feeds thread lifecycle
 *  events; GUILD_MESSAGES + MESSAGE_CONTENT make MESSAGE_CREATE carry
 *  `content` — MESSAGE_CONTENT is a PRIVILEGED intent the user must
 *  enable on the bot's dev-portal page or the gateway closes with 4014. */
export const GATEWAY_INTENTS =
    (1 << 0)    // GUILDS
    | (1 << 9)  // GUILD_MESSAGES
    | (1 << 15) // MESSAGE_CONTENT

/** Close codes that re-connecting can never fix — surface to the user
 *  instead of retrying into the session-start rate limit. */
export const FATAL_CLOSE_CODES: Record<number, { kind: 'auth_failed' | 'permission_denied'; hint: string }> = {
    4004: { kind: 'auth_failed', hint: 'bot token is invalid or was revoked — re-pair' },
    4013: { kind: 'auth_failed', hint: 'invalid gateway intents (bridge bug)' },
    4014: {
        kind: 'permission_denied',
        hint: 'disallowed intents — enable "Message Content Intent" on the bot\'s page at discord.com/developers',
    },
}

export interface GatewayPayload {
    op: number
    /** Event payload. Shape depends on op / t. */
    d?: unknown
    /** Sequence number (op 0 only) — drives heartbeats + RESUME. */
    s?: number | null
    /** Dispatch event name (op 0 only): READY, MESSAGE_CREATE, … */
    t?: string | null
}

export interface DcHello {
    heartbeat_interval: number
}

export interface DcReady {
    session_id: string
    resume_gateway_url: string
    user: DcUser
}

// ── REST / dispatch objects ─────────────────────────────────────────────

export interface DcUser {
    id: string
    username: string
    bot?: boolean
}

/** Channel types the bridge distinguishes. 11/12 are threads — their
 *  message's channel_id IS the thread id and parent_id points at the
 *  text channel the binding locked. */
export const DC_CHANNEL_PUBLIC_THREAD = 11
export const DC_CHANNEL_PRIVATE_THREAD = 12

export interface DcChannel {
    id: string
    type: number
    parent_id?: string | null
    name?: string
}

export interface DcMessage {
    id: string
    channel_id: string
    author?: DcUser
    content?: string
}

/** INTERACTION_CREATE payload, type 3 = MESSAGE_COMPONENT (button tap). */
export interface DcInteraction {
    id: string
    token: string
    type: number
    channel_id?: string
    data?: { custom_id?: string }
    message?: DcMessage
    /** Present in guild interactions. */
    member?: { user?: DcUser }
    /** Present in DM interactions. */
    user?: DcUser
}

export const DC_INTERACTION_MESSAGE_COMPONENT = 3
/** Interaction response type 6: silently consume the click (the message
 *  edit lands separately via editMessage). Stops the client-side spinner. */
export const DC_DEFERRED_UPDATE_MESSAGE = 6

/** REST error body. `retry_after` is seconds (fractional) on 429. */
export interface DcApiError {
    code?: number
    message?: string
    retry_after?: number
}

/** JSON error codes worth mapping to the cross-platform taxonomy. */
export const DC_ERR_UNKNOWN_CHANNEL = 10003
export const DC_ERR_UNKNOWN_MESSAGE = 10008
export const DC_ERR_MISSING_ACCESS = 50001
export const DC_ERR_MISSING_PERMISSIONS = 50013
export const DC_ERR_THREAD_ARCHIVED = 50083

/** Button styles. */
export const DC_BUTTON_PRIMARY = 1
export const DC_BUTTON_SECONDARY = 2
export const DC_BUTTON_DANGER = 4

export interface DcComponentButton {
    type: 2
    style: number
    label: string
    custom_id: string
}

export interface DcActionRow {
    type: 1
    components: DcComponentButton[]
}
