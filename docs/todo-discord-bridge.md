# TODO — Discord Bridge (third mobile-bridge backend)

**Status:** code complete, not yet dogfooded · **Added:** 2026-06-10

Promoted from the T2 "by demand signal" tier in
[todo-mobile-bridge.md](./todo-mobile-bridge.md) by product-owner request
(2026-06-10), ahead of the original "Western OSS community signal" gate.

### One-liner
Discord as a third `MessagingBackend` next to Telegram and Feishu: BYO
bot, Gateway WebSocket (outbound-only, NAT-safe), one **native Thread
per GlanceTerm tab** in a bound text channel, buttons for permission
relay, `/bind <code>` pairing — identical wire shape to the other two
platforms.

### Decisions (locked 2026-06-10)

1. **No SDK.** discord.js was considered and rejected — the bridge needs
   exactly two gateway events (MESSAGE_CREATE, INTERACTION_CREATE) and a
   handful of REST calls. Implementation uses the Electron renderer's
   native `WebSocket` + `fetch` globals: **zero new dependencies**, same
   spirit as the hand-rolled Telegram long-poll.
2. **Threads as the per-tab primitive** (constraint #4 of the original
   scoping): created via `POST /channels/{id}/threads` (public thread,
   auto-archive 7 days). Close/reopen map to the native `archived` flag —
   no anchor-message emulation needed (unlike Feishu).
3. **Thread→parent resolution**: Discord messages in a thread carry the
   THREAD id as `channel_id` and no parent. The backend keeps a
   thread→parent cache seeded by createThread + THREAD_CREATE dispatches,
   backfilled by `GET /channels/{id}` on cache miss.
4. **Fatal close codes halt, not retry.** 4004 (bad token) / 4013 / 4014
   (Message Content Intent not enabled) stop the reconnect loop and
   surface on `lastError$` — retrying burns the daily IDENTIFY budget and
   can never succeed. Recoverable drops RESUME with session_id + seq.
5. **Message Content Intent** is a privileged intent the user must enable
   on the bot's dev-portal page (free under 100 servers). Without it
   every message arrives with empty `content` and `/bind` can never
   match — called out in the settings checklist AND the pairing
   troubleshooting fold, and 4014 maps to an actionable
   `permission_denied` error.
6. **Credentials = single botToken** (same shape as Telegram), stored as
   a keystore SecretRef. Discord token regex added to
   `audit-log.ts`'s `redactToken` per its "first step of integration"
   convention.
7. **`BackendPlatform` union introduced** (`backends/types.ts`) as the
   single source of truth — the previous `'telegram' | 'feishu'` literals
   scattered across 8 files now reference it, so platform #4 is a
   one-line union change plus the registry/dispatcher/router list
   entries.

### Built (2026-06-10)
- `backends/discord/wire-types.ts` — gateway opcodes, intents, REST
  objects, error-code constants
- `backends/discord/client.service.ts` — full `MessagingBackend`:
  gateway lifecycle (HELLO/IDENTIFY/RESUME/heartbeat+zombie detection),
  REST + error taxonomy translation (50083→thread_closed, 429→
  rate_limited with retry_after, 10003→thread/chat_not_found via cache)
- Wiring: registry, NgModule providers, outbound-dispatcher platform
  list, inbound-router subscription, pairing (`beginDiscordPairing`),
  store credential migration + `secretRefsOf`, settings UI (third
  platform button, token form, setup checklist, troubleshooting)
- Tests: `__tests__/discord-backend.test.ts` — 9 cases over a scripted
  fake gateway (handshake, thread/plain flattening, bot-author drop,
  interactions + ack, component mapping, archived-thread error, 4014
  halt, heartbeat/RESUME)

### Remaining
- [ ] **Dogfood pass** — extend `docs/mobile-bridge-dogfood.md` with a
      Discord section (create app → intent → invite URL → /bind), then
      run the end-to-end checklist against a real server.
- [ ] Verify permission-relay round trip on a real Discord client
      (3-second interaction ack window under real latency).
- [ ] Rate-limit behaviour under topic-sync burst (Discord allows ~50
      reqs/s per bot; thread creation is fine at tab scale, but verify
      the 429 retryAfterMs path once against the real API).
- [ ] Update `todo-mobile-bridge.md` T2 table row (Discord → shipped).

### Out of scope
- Slash commands (`/snap` etc. arrive as plain text like the other
  platforms; registering native Discord slash commands is v2 polish).
- DM mode — DMs can't host threads; the per-tab primitive requires a
  server text channel. Documented in the settings checklist.
- Multi-server / multi-binding (v0 cap: one binding per platform).
