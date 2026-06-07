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
