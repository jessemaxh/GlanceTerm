# Feishu / Lark Bridge — Phase 1 design

**Status:** proposal, awaiting sign-off · **Author:** Claude · **Date:** 2026-06-08

Phase 1 of the Feishu integration is **architecture only** — we extract a
`MessagingBackend` interface, refactor the existing Telegram code to implement
it, and ship with zero observable behaviour change. Phase 2 adds keystore.
Phase 3 implements `FeishuBackend`. Phase 4 turns on streaming cards.

This doc covers Phase 1: the interface itself.

## Why an interface, not parallel implementations

We considered three architectural paths:

- **A. Parallel** — keep `TelegramClientService` etc. untouched, add a
  parallel `feishu/` tree. `OutboundDispatcher` does `if/else` on platform.
  → Lots of duplication, every future platform doubles the surface.
- **B. Big refactor** — extract a full `Backend` abstraction over every
  cross-cutting concern (auth, transport, rendering, persistence). →
  Cleanest end-state but 3-4 days of churn before any Feishu code runs.
- **C. Surgical interface** ← chosen. Abstract only the platform-touching
  surface (`MessagingBackend`). Leave `TopicService` / `TopicSyncService`
  / `OutboundDispatcher` / `InboundRouter` mostly unchanged — they now
  depend on the interface, not the TG client.

Estimated Phase 1 scope: ~600 LoC moved, ~150 LoC new (types + adapter
glue), zero new features.

## The interface

```ts
/** Cross-platform messaging surface. One instance per platform; each
 *  instance handles at most one active binding (matches today's v0
 *  one-binding-per-platform cap). */
export interface MessagingBackend {
    // ── Lifecycle ────────────────────────────────────────────────────
    start(creds: BackendCredentials): Promise<void>
    stop(): Promise<void>
    running$: Observable<boolean>
    identity$: Observable<BotIdentity | null>

    // ── Per-thread send/edit ─────────────────────────────────────────
    /** Post a fresh thread under `chatId` with the given anchor title.
     *  Returns the platform-native thread id. Telegram: createForumTopic
     *  returns numeric thread_id. Feishu: posts an anchor message with
     *  reply_in_thread=true; thread_id comes back in the response. */
    createThread(chatId: ChatRef, title: string): Promise<ThreadRef>

    /** Telegram: closeForumTopic. Feishu: edit anchor message to add
     *  📕 marker (no native close API). Idempotent. */
    closeThread(chatId: ChatRef, threadId: ThreadRef): Promise<void>
    reopenThread(chatId: ChatRef, threadId: ThreadRef): Promise<void>

    /** Telegram: editForumTopic. Feishu: edit anchor message body. */
    renameThread(chatId: ChatRef, threadId: ThreadRef, title: string): Promise<void>

    /** Post a plain text message to a thread. */
    sendText(
        chatId: ChatRef,
        threadId: ThreadRef,
        body: string,
        opts?: SendOptions,
    ): Promise<MessageRef>

    /** Post an interactive prompt (permission request) — buttons that the
     *  user taps on phone. Returns the posted message ref so callers can
     *  edit it after the verdict resolves. */
    sendInteractive(
        chatId: ChatRef,
        threadId: ThreadRef,
        spec: InteractiveSpec,
    ): Promise<MessageRef>

    /** Edit a previously-sent message. Used by permission-relay to swap
     *  the buttons for "✓ Approved on phone" after the verdict lands. */
    editMessage(
        ref: MessageRef,
        body: string,
        opts?: EditOptions,
    ): Promise<void>

    /** Ack a button tap. Telegram requires answerCallbackQuery within
     *  ~30s or the button spinner sits forever. Feishu doesn't require
     *  an ack; impl is a no-op. */
    ackCallback(callbackId: string): Promise<void>

    // ── Inbound streams ──────────────────────────────────────────────
    /** User-sent text messages from anywhere the bot can hear. */
    inbound$: Observable<InboundMessage>
    /** Button taps + other structured callbacks. */
    callbacks$: Observable<InboundCallback>
}
```

## Cross-platform types

All refs are strings — TG's numeric ids are stringified at the backend
boundary. Keeps `TopicService.cache` keys uniform and JSON-serialisable
without numeric vs string ambiguity.

```ts
export type ChatRef = string     // TG: "-1003995493736"; Feishu: "oc_xxx"
export type ThreadRef = string   // TG: "21"; Feishu: "omt_xxx"
export type MessageRef = string  // TG: "1234"; Feishu: "om_xxx"

export interface BotIdentity {
    /** Platform-native bot id. */
    id: string
    /** UI-friendly handle. TG: "@MyBot"; Feishu: app display name. */
    displayName: string
    /** "Telegram" | "Feishu" | "Lark" — for status row in settings. */
    platformLabel: string
}

export interface InboundMessage {
    chatId: ChatRef
    /** null for chats without thread/topic support (e.g. TG 1:1, Feishu
     *  p2p DM). The dispatcher's tab lookup falls back to "any tab"
     *  semantics in that case. */
    threadId: ThreadRef | null
    senderId: string
    senderName?: string
    text: string
    messageId: MessageRef
}

export interface InboundCallback {
    /** Platform's identifier for the click event. Pass to ackCallback. */
    callbackId: string
    chatId: ChatRef
    threadId: ThreadRef | null
    /** The message that bore the button (for edit-on-resolve). */
    messageId: MessageRef
    senderId: string
    /** Bot-controlled payload set at sendInteractive time
     *  (e.g. "perm:allow:abcde"). */
    data: string
}

export interface SendOptions {
    /** Reserved — Telegram supports MarkdownV2 / HTML. Feishu uses
     *  rich-text JSON instead. v1 sticks to plain text; opt-in flag
     *  reserved for v2. */
    formatHint?: 'plain' | 'markdown'
}

export interface EditOptions extends SendOptions {
    /** Strip the inline keyboard / card buttons on edit. Used by
     *  permission-relay to neutralise the prompt after verdict. */
    clearButtons?: boolean
}

export interface InteractiveSpec {
    /** Text body of the prompt. */
    body: string
    /** Button rows. Outer array = rows, inner = buttons within a row.
     *  Permission relay uses one row with two buttons. */
    buttons: InteractiveButton[][]
}

export interface InteractiveButton {
    label: string
    /** Echoed back as InboundCallback.data when tapped. ≤64 bytes
     *  (Telegram's hard limit; Feishu allows more but we cap for
     *  cross-platform compatibility). */
    value: string
    style?: 'primary' | 'danger' | 'default'
}
```

## Credentials — discriminated union

```ts
export type BackendCredentials =
    | { platform: 'telegram'; botToken: string }
    | { platform: 'feishu'; appId: string; appSecret: string; region: 'feishu' | 'lark' }
```

`region` picks `open.feishu.cn` vs `open.larksuite.com`. Both share API
shapes — only the base URL differs (confirmed via Feishu docs).

For Phase 3, the Feishu impl will add `tenantKey` for multi-tenant
support, but v1 single-tenant doesn't need it.

## Errors

Backends translate platform-specific errors into a small union. Callers
(`OutboundDispatcher`, `TopicService`) check `kind`, not platform codes.

```ts
export class MessagingError extends Error {
    constructor (
        public kind: MessagingErrorKind,
        message: string,
        public retryAfterMs?: number,
    ) { super(message); this.name = 'MessagingError' }
}

export type MessagingErrorKind =
    | 'thread_closed'      // TG: TOPIC_CLOSED; Feishu: anchor message marked
    | 'thread_not_found'   // TG/Feishu: thread id is invalid / deleted
    | 'chat_not_found'     // chat id invalid / bot kicked
    | 'auth_failed'        // bot token revoked, token refresh failed
    | 'rate_limited'       // TG: 429; Feishu: 99991663
    | 'permission_denied'  // bot lacks can_manage_topics, etc.
    | 'unknown'            // anything else; check .message for details
```

`OutboundDispatcher` currently matches a TG-specific regex
(`/TOPIC_CLOSED/`) to trigger reopen-and-retry. After refactor it checks
`err instanceof MessagingError && err.kind === 'thread_closed'` —
platform-agnostic.

## ChannelBinding schema migration

Current shape (`src/binding/types.ts`):

```ts
interface ChannelBinding {
    botToken: string  // TG-specific, always present
    // ... other fields
}
```

Migrate to:

```ts
interface ChannelBinding {
    credentials: BackendCredentials  // platform-tagged
    // ... other fields (botToken removed)
}
```

`BindingStore.load()` runs a one-shot migration: any record with
`botToken` and no `credentials` gets converted to
`credentials: { platform: 'telegram', botToken }`. The old field is
dropped on next save. Forward-only — we don't keep the old field.

This is a breaking on-disk change but the file is per-user, never
shipped between users, so the migration is safe.

## Injection strategy

Two backends, both DI singletons:

```ts
@Injectable() export class TelegramBackend implements MessagingBackend { ... }
@Injectable() export class FeishuBackend implements MessagingBackend { ... }
```

A tiny registry hands them out by platform:

```ts
@Injectable()
export class BackendRegistry {
    constructor (
        private tg: TelegramBackend,
        private feishu: FeishuBackend,
    ) {}
    forPlatform (p: 'telegram' | 'feishu'): MessagingBackend {
        switch (p) {
            case 'telegram': return this.tg
            case 'feishu':   return this.feishu
        }
    }
}
```

`OutboundDispatcher`, `TopicService`, `TopicSyncService`,
`InboundRouter` all gain a `BackendRegistry` dependency and call
`forPlatform(binding.platform).<method>` instead of directly touching
`TelegramClientService`.

## What stays the same

- `TopicService` cache schema — already keyed by `(bindingId, tabUuid)`,
  values store `threadId` which becomes `ThreadRef` (string). Migration:
  numeric `threadId` → `String(threadId)`. One-line load().
- `TopicSyncService` diff algorithm — unchanged.
- `OutboundDispatcher` orchestration — unchanged. Only the
  backend-call sites swap.
- `InstanceLockService` — unchanged.
- `BindingStoreService` — adds the credentials migration in `load()`.
- `PermissionModeService` — unchanged.
- Settings UI — unchanged for v1 (still TG-only until Phase 3 adds
  Feishu pairing UI).
- All `transcript/` and `permission-relay.service.ts` — unchanged.

## What changes name / location

- `src/telegram/client.service.ts` → `src/backends/telegram/client.service.ts`
  + becomes `TelegramBackend implements MessagingBackend`
- `src/telegram/topic.service.ts` → `src/backends/telegram/topic-helpers.ts`
  if anything platform-specific remains; otherwise the methods fold into
  `TopicService` directly. Likely the latter — most logic is generic.
- `src/telegram/types.ts` → split: cross-platform types into
  `src/backends/types.ts`, TG-specific (TgMessage, TgUpdate, etc.)
  stay at `src/backends/telegram/wire-types.ts`.
- New file: `src/backends/types.ts` — interfaces above.
- New file: `src/backends/registry.service.ts` — `BackendRegistry`.

## Phase 1 acceptance criteria

1. `tsc --noEmit` clean.
2. `webpack` build clean.
3. `OutboundDispatcher.sendToTelegram` becomes `sendViaBackend` and routes
   through `BackendRegistry`.
4. All current TG behaviour preserved — manual smoke: open a tab, see
   topic created on phone; close tab, see topic archived; rename tab,
   see topic renamed; permission request, see ✅/❌ buttons.
5. `TopicService.threadId` typed `string` everywhere; migration code
   handles the numeric-from-disk case.
6. No new dependencies. Lark SDK comes in Phase 3.
7. Settings UI unchanged from the current simplified version.

## Open questions for sign-off

**Q1.** Naming — `MessagingBackend` vs `ChannelBackend` vs `BridgeBackend`?
The plugin is called "mobile-bridge", `ChannelBinding` is already a type
name, so `ChannelBackend` would be one consistent vocabulary. But
"channel" overlaps with Slack/Discord domain words. **Recommend:
`MessagingBackend`** — clearest standalone, fewest overloads.

**Q2.** Error kind taxonomy — keep it small (current 7 kinds) or
exhaustive? Bigger = more precise retry logic; smaller = less to keep
in sync. **Recommend small.** Add kinds when a real bug needs them.

**Q3.** Should `createThread` accept an initial body (so Feishu can post
the anchor message with content in one round trip) or always post an
empty title-only anchor? Empty anchor is simpler but uses an extra send
round trip later. **Recommend empty.** The title IS visible (it's the
anchor message body on Feishu). Single send.

**Q4.** Should `sendText` / `sendInteractive` share one method
`sendMessage(spec)` where spec has an optional `buttons` field? Slightly
DRYer but blurs the "post a plain text" vs "post an interactive prompt"
intent at call sites. **Recommend keep separate.** Two named methods
read better than one polymorphic one.

If you sign off on this, Phase 1 implementation starts next. ~1 day.
