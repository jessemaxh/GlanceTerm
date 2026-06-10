import { BackendCredentials, BackendPlatform, PlaintextBackendCredentials, SecretRef } from '../backends/types'

/**
 * Persisted binding records. One per (platform × chat) the user has linked.
 *
 * v0 MVP cap: one binding per platform. The list-of-records shape is
 * deliberate — extending to multi-binding later is no schema change.
 *
 * Credentials hold {@link SecretRef} pointers (post-Phase-2); the actual
 * bot tokens / app secrets live in {@link KeystoreService}'s
 * AES-256-GCM-encrypted store under those ids. Inline plaintext is a
 * thing of the past — Phase 2 migration moves any legacy record into
 * the encrypted store on first load.
 */
export interface ChannelBinding {
    /** Internal id — uuid. Distinct from the platform-side chat id. */
    id: string
    /** Platform — duplicates `credentials.platform` for filterability at
     *  call sites that don't need the credentials themselves. Kept in
     *  sync via the type system + a one-shot migration in
     *  BindingStoreService.load. */
    platform: BackendPlatform
    /** Display label the user chose (or auto-generated from bot getMe). */
    label: string
    /** Platform-tagged credentials with SecretRef pointers to actual
     *  secret material. */
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
 * Holds the not-yet-confirmed plaintext credentials inline so the pairing
 * flow has everything it needs to start the bot loop before the user's
 * /bind message arrives. Once matched, BindingStoreService.add writes
 * the secret to keystore and graduates the rest into a ChannelBinding.
 */
export interface PendingPairing {
    /** 6 uppercase alphanumeric chars. */
    code: string
    /** Platform the user is binding. */
    platform: BackendPlatform
    /** Plaintext credentials staged for the binding-to-be. Lives in
     *  memory only — never persisted. BindingStoreService.add converts
     *  to the SecretRef form before writing the binding record. */
    credentials: PlaintextBackendCredentials
    /** Optional pre-fill for the binding label. */
    label?: string
    /** Wall-clock expiry (ms). */
    expiresAt: number
}

/**
 * Schema for {@link BindingStoreService.add}'s input — exactly a
 * {@link ChannelBinding} minus the auto-generated id+createdAt, but with
 * the credentials slot accepting plaintext. add() routes the plaintext
 * through keystore and persists with a SecretRef.
 */
export interface BindingDraft {
    platform: BackendPlatform
    label: string
    credentials: PlaintextBackendCredentials
    chatId: string
    ownerUserId: string
    approvedSenders: string[]
    enabled: boolean
    eventFilter: string[]
}

/**
 * Pre-migration shapes on disk. Used by BindingStoreService.load to
 * detect legacy records and migrate them forward. Three shapes covered:
 *
 *   - Pre-Phase-1: top-level `botToken` (Telegram-only world)
 *   - Phase 1: `credentials.botToken` as plaintext string
 *   - Phase 2: `credentials.botToken` as SecretRef
 *
 * Only the fields needed for migration detection are typed; everything
 * else passes through as-is.
 */
export interface LegacyChannelBinding {
    botToken?: string
    credentials?: LegacyCredentials
    platform: BackendPlatform
    [k: string]: unknown
}

/** Union covering plaintext (Phase 1 form) and SecretRef (current). */
export type LegacyCredentials =
    | { platform: 'telegram'; botToken: string | SecretRef }
    | { platform: 'feishu'; appId: string; appSecret: string | SecretRef; region: 'feishu' | 'lark' }
    | { platform: 'discord'; botToken: string | SecretRef }
