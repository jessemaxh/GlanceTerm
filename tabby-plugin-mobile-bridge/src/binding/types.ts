/**
 * Persisted binding records. One per (platform × chat) the user has linked.
 *
 * v0 MVP cap: one binding per platform. The list-of-records shape is
 * deliberate — extending to multi-binding later is no schema change.
 *
 * SECURITY NOTE: `botToken` is currently stored in the same JSON file
 * as the rest of the record. For a public release this needs to move
 * to keytar (or Tabby's VaultService) — tracked in the doc as a
 * pre-ship hardening item. For dogfooding on the author's own machine
 * the plain-file approach is acceptable.
 */
export interface ChannelBinding {
    /** Internal id — uuid. Distinct from the platform-side chat id. */
    id: string
    /** Platform — only 'telegram' in v0; '飞书' in T1. */
    platform: 'telegram' | 'feishu'
    /** Display label the user chose (or auto-generated from bot getMe). */
    label: string
    /** Bot credential. Hardening tracked. */
    botToken: string
    /** Platform-side chat id this binding is locked to. Set at /bind time. */
    chatId: string
    /** Sender id whose `/bind <code>` succeeded — owner of this binding. */
    ownerUserId: string
    /** Approved sender ids. Inbound messages from anyone else are
     *  silently dropped + logged. ownerUserId is always in this set. */
    approvedSenders: string[]
    /** Master toggle. Stops outbound delivery and inbound polling. */
    enabled: boolean
    /** Per-event-type filter — empty array = all events pass. Task #10. */
    eventFilter: string[]
    /** Wall-clock time (ms) the binding was created. */
    createdAt: number
}

/**
 * Transient pairing state — not persisted. A 6-char code generated when
 * the user clicks "Add binding" in settings; expires after 5 minutes.
 * Matched against `/bind <code>` Telegram messages by BindingService.
 */
export interface PendingPairing {
    /** 6 uppercase alphanumeric chars. */
    code: string
    /** Platform the user is binding. */
    platform: 'telegram' | 'feishu'
    /** Bot token the user pasted into settings; held in memory only
     *  until pairing completes (then moved to the persisted binding). */
    botToken: string
    /** Optional pre-fill for the binding label. */
    label?: string
    /** Wall-clock expiry (ms). */
    expiresAt: number
}
