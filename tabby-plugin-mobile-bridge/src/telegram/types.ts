/**
 * Narrow interfaces for the Telegram Bot API surface we actually consume.
 * Full schema at https://core.telegram.org/bots/api — we deliberately model
 * only the fields the bridge reads/writes so a Bot-API addition can't
 * silently break our types.
 */

/** Raw `Update` from getUpdates. */
export interface TgUpdate {
    update_id: number
    message?: TgMessage
    /** Inline keyboard tap; primary input for permission-relay verdicts.
     *  Carries the original message context plus the bytes the bot put in
     *  `inline_keyboard[].callback_data` at send time. */
    callback_query?: TgCallbackQuery
    /** edited_message etc. exist but are ignored — out of scope for v0. */
    [key: string]: unknown
}

export interface TgMessage {
    message_id: number
    chat: TgChat
    from?: TgUser
    /** Present when the message lives in a Forum Topic. Routing key for the
     *  bridge: this maps 1:1 to our tab UUID via TopicService. */
    message_thread_id?: number
    text?: string
    /** When the user uses Telegram's reply-to feature. We don't depend on
     *  this for routing (topic_id is enough) but it's useful for context. */
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

/**
 * Downstream-friendly shape published by TelegramClient.inboundMessages$.
 * Strips Telegram's nested envelope so routers can read flat fields.
 */
export interface TgInboundMessage {
    /** `chat.id` — the supergroup the bot was bound to. */
    chatId: number
    /** `from.id` — checked against the binding's `approvedSenders` whitelist. */
    senderId: number
    senderUsername?: string
    /** `message_thread_id` — present in Forum Topics, absent in 1-on-1 / generic group. */
    topicId?: number
    text: string
    /** Underlying `message.message_id` — useful for editMessage replies. */
    rawMessageId: number
}

/**
 * Inline keyboard primitives. Only the fields we set/read are modeled;
 * the Bot API supports many more callback button kinds (urls, login, web
 * apps, switch_inline_query, …) that the permission-relay use case never
 * touches.
 */
export interface InlineKeyboardButton {
    text: string
    /** Bot-controlled blob (1–64 bytes) echoed in the callback_query when
     *  the user taps. We use it as the verdict carrier — e.g.
     *  `perm:allow:<5-letter-id>`. */
    callback_data?: string
}

/** `reply_markup` shape for sendMessage / editMessageText / editMessageReplyMarkup.
 *  Outer array is rows; inner array is buttons in that row. */
export interface InlineKeyboardMarkup {
    inline_keyboard: InlineKeyboardButton[][]
}

/**
 * `callback_query` update. We use it for permission-relay verdict taps;
 * fields we don't read (chat_instance, inline_message_id, …) are omitted.
 *
 * Important: `message` is the message that BORE the keyboard (i.e. our
 * outbound permission-prompt message), not a reply from the user. So
 * `callback_query.from.id` is who tapped (must pass allowlist), while
 * `message.chat.id` identifies the binding and `message.message_id` is
 * the message we'll editMessageText to remove the buttons after the tap.
 */
export interface TgCallbackQuery {
    id: string
    from: TgUser
    message?: TgMessage
    data?: string
}

/** Downstream-friendly shape published by TelegramClient.callbackQueries$. */
export interface TgInboundCallback {
    /** Telegram's id — must be echoed back to `answerCallbackQuery` to dismiss
     *  the spinner on the user's phone; otherwise the button stays "loading". */
    callbackId: string
    senderId: number
    senderUsername?: string
    /** `message.chat.id` of the message the keyboard was on. */
    chatId: number
    /** `message_thread_id` if the keyboard was in a Forum Topic. */
    topicId?: number
    /** `message.message_id` — used to edit the prompt after verdict lands. */
    messageId: number
    /** Bot-controlled bytes set at send time (e.g. `perm:allow:abcde`). */
    data: string
}
