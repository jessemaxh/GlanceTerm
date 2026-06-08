/**
 * Telegram-specific Bot API shapes. Full schema at
 * https://core.telegram.org/bots/api — we deliberately model only the
 * fields the bridge reads/writes so a Bot-API addition can't silently
 * break our types.
 *
 * Cross-platform shapes (InboundMessage / InboundCallback / etc.) live in
 * `../types.ts` — the TelegramBackend translates wire shapes into those
 * at the boundary so downstream code never sees Tg* types.
 */

/** Raw `Update` from getUpdates. */
export interface TgUpdate {
    update_id: number
    message?: TgMessage
    callback_query?: TgCallbackQuery
    /** edited_message etc. exist but are ignored. */
    [key: string]: unknown
}

export interface TgMessage {
    message_id: number
    chat: TgChat
    from?: TgUser
    /** Forum Topic the message belongs to, if any. */
    message_thread_id?: number
    text?: string
    reply_to_message?: { message_id: number }
}

export interface TgChat {
    id: number
    /** 'private' | 'group' | 'supergroup' | 'channel'. Forum Topics only
     *  exist in 'supergroup'. */
    type: string
    title?: string
    is_forum?: boolean
}

export interface TgUser {
    id: number
    is_bot: boolean
    username?: string
    first_name?: string
}

/** Return type of `createForumTopic`. */
export interface TgForumTopic {
    message_thread_id: number
    name: string
    icon_color?: number
}

export interface TgCallbackQuery {
    id: string
    from: TgUser
    message?: TgMessage
    data?: string
}

export interface InlineKeyboardButton {
    text: string
    /** Bot-controlled blob (1–64 bytes) echoed in the callback_query
     *  when the user taps. */
    callback_data?: string
}

/** Outer array = rows; inner array = buttons in that row. */
export interface InlineKeyboardMarkup {
    inline_keyboard: InlineKeyboardButton[][]
}
