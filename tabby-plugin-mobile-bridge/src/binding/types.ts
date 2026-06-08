import { BackendCredentials } from '../backends/types'

/**
 * Persisted binding records. One per (platform × chat) the user has linked.
 *
 * v0 MVP cap: one binding per platform. The list-of-records shape is
 * deliberate — extending to multi-binding later is no schema change.
 *
 * SECURITY NOTE: `credentials` carries the bot token / app secret in
 * plaintext as of Phase 1. The keystore work (Phase 2) moves them to
 * AES-256-GCM-encrypted storage with a `SecretRef` pointer in this record.
 * For dogfooding on the author's own machine the plain-file approach is
 * acceptable but anyone considering a public release should land Phase 2
 * first.
 */
export interface ChannelBinding {
    /** Internal id — uuid. Distinct from the platform-side chat id. */
    id: string
    /** Platform — duplicates `credentials.platform` for filterability at
     *  call sites that don't need the credentials themselves. Kept in
     *  sync via the type system + a one-shot migration in
     *  BindingStoreService.load. */
    platform: 'telegram' | 'feishu'
    /** Display label the user chose (or auto-generated from bot getMe). */
    label: string
    /** Platform-tagged credentials. Discriminated union — TS narrows on
     *  `.platform` at consumer sites. */
    credentials: BackendCredentials
    /** Platform-side chat id this binding is locked to. Set at /bind time. */
    chatId: string
    /** Sender id whose pairing succeeded — owner of this binding. */
    ownerUserId: string
    /** Approved sender ids. Inbound messages from anyone else are silently
     *  dropped + logged. ownerUserId is always in this set. */
    approvedSenders: string[]
    /** Master toggle. Stops outbound delivery and inbound polling. */
    enabled: boolean
    /** Per-event-type filter — empty array = all events pass. */
    eventFilter: string[]
    /** Wall-clock time (ms) the binding was created. */
    createdAt: number
}

/**
 * Transient pairing state — not persisted. A 6-char code generated when
 * the user clicks "Add binding" in settings; expires after 5 minutes.
 * Matched against `/bind <code>` Telegram messages by PairingService.
 *
 * Holds the not-yet-confirmed credentials inline so the pairing flow has
 * everything it needs to start the bot loop before the user's /bind
 * message arrives. Once matched, these graduate to ChannelBinding.
 */
export interface PendingPairing {
    /** 6 uppercase alphanumeric chars. */
    code: string
    /** Platform the user is binding. */
    platform: 'telegram' | 'feishu'
    /** Credentials staged for the binding-to-be. Discriminated by
     *  `platform`; the backend's `start(creds)` consumes the matching
     *  variant. */
    credentials: BackendCredentials
    /** Optional pre-fill for the binding label. */
    label?: string
    /** Wall-clock expiry (ms). */
    expiresAt: number
}

/**
 * Pre-Phase-1 on-disk shape. Used by BindingStoreService.load to detect
 * legacy records (have `botToken` at top level) and migrate them to the
 * `credentials`-tagged form. Only the fields needed for the migration
 * are typed; everything else is preserved as-is.
 */
export interface LegacyChannelBinding {
    botToken?: string
    credentials?: BackendCredentials
    platform: 'telegram' | 'feishu'
    [k: string]: unknown
}
