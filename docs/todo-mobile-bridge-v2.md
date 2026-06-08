# TODO — Mobile Bridge v2 (RC-effect parity over BYO IM)

Lift mobile-bridge from "passive status push" to "active two-way Remote-Control
effect," in chat-IM form (Telegram first, Feishu next), without an app or a
server we run.

**Status:** scoped, not started · **Added:** 2026-06-08 · **Sibling of:**
[todo-mobile-bridge.md](./todo-mobile-bridge.md) (v0/T0 outbound-only baseline)

### One-liner
Telegram chat that **feels like Anthropic Remote Control:** one tap to
approve/deny tool use, type a follow-up prompt that flows into the running
agent, optional `/snap` to see the actual terminal. No app, no relay — just
your BYO bot. Foundation laid so Feishu can drop into the same wire shape in
v2.

### Why this iteration

After 30 min of competitive research (see chat log 2026-06-08), the honest
landscape:

- **Anthropic Remote Control** = native app + Anthropic relay + claude.ai
  subscription. The "effect" the user wants.
- **Anthropic official Channels Telegram plugin** = closest BYO equivalent,
  but Claude-only + still requires claude.ai login.
- **Happy** = open-source 1:1 RC clone (CLI + relay + iOS/Android app, E2E).
  Requires their relay or self-host.

Two hard constraints from product owner (2026-06-08):
1. **No own app / no own server.** Telegram + Feishu only.
2. **Must work for non-Claude agents** (codex, aider, goose) — rules out
   Anthropic's official plugin.

Given those, the only viable shape is "keep our mobile-bridge plugin, add the
features that bring it within striking distance of RC's chat UX." That's v2.

### Hard constraints (locked 2026-06-08)
1. **Telegram is v1; Feishu is v2.** Wire-protocol design must be transport-
   agnostic so Feishu drops in with adapter swap, not redesign.
2. **No claude.ai dependency.** Works against API-key Claude AND against
   non-Claude agents.
3. **Personal DM is the v1 scope. Group fields reserved in schema but
   unimplemented** — see [§ Schema reservations].
4. **Permission relay = parallel-race model (Anthropic style):** local
   permission dialog stays open; the IM prompt fires in parallel; whichever
   side answers first wins, the other is closed silently.
5. **Reverse text input = agent-aware smart routing:** when the target tab
   has a live `aiTool` (per `TabMonitor`), `pty.write(text + '\n')`; when it
   doesn't, reject with a one-line "this tab has no agent running" reply.
   `/sh <cmd>` escape hatch is **out of v1** but the prefix is reserved.
6. **`/snap` screenshot is in v1.** Phone sends `/snap` in a topic →
   `webContents.capturePage()` clipped to that tab → `sendPhoto`. Covers
   ~80% of "I want to see the terminal" without the impossible streaming
   target.

### What we already have (v0 baseline)
- `TelegramClientService` — long-poll, sendMessage, editMessageText,
  createForumTopic, editForumTopic
- `BindingStoreService` — per-binding pairing, allowlist, persisted in
  `~/.glanceterm/mobile-bridge-bindings.json`
- `TopicService` — per-tab forum topic auto-created on first push
- `TabIdentityService` — sidebar UUID per tab (after 2026-06-08 fixes also
  reconciles to GLANCETERM_TAB_ID via `byHookTabId`)
- `OutboundDispatcher` — fan-out for `state_transition` events
  (needs_permission, task_completed) + transcript-derived assistant_text
- `TranscriptTailerService` — tails Claude's `.jsonl` (post-fix: uses
  authoritative `snap.transcriptPath`)
- `InboundRouter` — current scope: only `/bind <code>` pairing
- `HookRuntimeService` / `HookWatcherService` — hook handler installation,
  per-tab `.log` parsing, `HookSnapshot` with `transcriptPath` (post 2026-06-08)

What's missing for RC-effect parity:
- Permission relay (the killer RC feature)
- Reverse text → PTY routing
- On-demand `/snap` screenshot
- Non-Claude-agent text streaming (current transcript tailer is Claude-only)
- Wire-protocol stratification so Feishu fits later

---

## Scope: 6 work blocks

### Block 1 — Permission relay (Claude only in v1)
**Effort: ~4 days. Highest-value block. Without this we're not in the
RC-effect ballpark.**

**Coexistence model with existing auto-approve (decided 2026-06-08):**

`auto-approve` and `permission-relay` are two **independent** sidebar switches
— they can be in any combination (off/off, on/off, off/on, on/on). The hook
handler resolves coexistence by **short-circuit precedence**:

1. Handler reads `~/.glanceterm/auto-approve.flag` first (existing logic).
   If `"1"`, emit allow JSON and exit. Relay code path is never reached →
   phone never sees this request. → Decision: silent, no "ℹ️ auto-approved"
   notification is pushed to phone (keeps the chat noise-free; the
   `~/.glanceterm/auto-approve.log` is the audit trail for those).
2. Otherwise, handler reads `~/.glanceterm/permission-relay.flag`. If `"1"`,
   write `.req` + poll `.decision` (see flow below). If `"0"`/missing, do
   nothing → Claude shows its own local dialog (current default behavior).

This means **no coordination logic** between the two features is needed —
auto-approve's existing short-circuit naturally suppresses relay. The UI
keeps the two switches in their existing locations; no new toggle ordering
or modal explanations required.

If auto-approve toggles ON while a phone request is pending, the pending
request is unaffected (it's already in the relay path); only subsequent
PermissionRequests get the short-circuit treatment. No race.

**Architecture (the IPC dance):**

```
PreToolUse(Bash|Write|Edit|MultiEdit) fires
  │
  ▼
HANDLER_SH (existing shell handler)
  │  - check ~/.glanceterm/auto-approve.flag → if "1", emit allow + exit  (existing path, unchanged)
  │  - check ~/.glanceterm/permission-relay.flag → if "1" AND no auto-approve:
  │      1. generate 5-letter id (Anthropic's [a-km-z]{5} convention)
  │      2. write request: ~/.glanceterm/permissions/<id>.req with
  │         { tab_id, tool_name, description, input_preview, ts }
  │      3. poll ~/.glanceterm/permissions/<id>.decision every 100ms
  │      4. when seen: read { behavior: "allow"|"deny" } → emit hookSpecificOutput JSON → exit 0
  │      5. on stale (>30 min): exit 0 with no decision → Claude's local
  │         dialog (which is also open in parallel) is authoritative
  ▼
HookRuntimeService writes ~/.glanceterm/permission-relay.flag from a new
sidebar toggle (per-tab? global? — see open question below)
```

```
PermissionRelayService (NEW Angular service in tabby-plugin-mobile-bridge)
  │
  │  fs.watch(~/.glanceterm/permissions/)
  │
  ├─ on *.req appeared:
  │   - parse, look up tab via byHookTabId(req.tab_id)
  │   - for each enabled binding allowed for that tab:
  │       send via TelegramClient.sendMessage with inline_keyboard:
  │           [✅ Allow]  [❌ Deny]
  │       callback_data: "perm:allow:<id>" / "perm:deny:<id>"
  │       text body: "Claude wants to run Bash:\n```\n<input_preview>\n```\nReply
  │                   ‘yes <id>’ or tap a button"
  │   - record the sent message_id so we can edit it on decision
  │
  ├─ on *.decision appeared (written by InboundRouter or by us when callback fires):
  │   - editMessageText the original prompt → "✓ Allowed by you on phone" /
  │     "✗ Denied by you on phone" — removes inline_keyboard
  │   - (the handler-side poll picks the decision up independently)
  │
  └─ on local dialog answered first (TBD signal):
      - editMessageText → "✓ Already answered locally" + remove keyboard
      - delete the .req file so handler stops polling
```

```
InboundRouter (extended)
  │
  ├─ inline keyboard callback "perm:allow:<id>" / "perm:deny:<id>":
  │   - allowlist check (sender_id in binding.approvedSenders)
  │   - id format check ([a-km-z]{5})
  │   - .req exists? (might have been answered locally already)
  │   - write ~/.glanceterm/permissions/<id>.decision = {"behavior":"allow"|"deny"}
  │   - answerCallbackQuery so Telegram dismisses the spinner
  │
  └─ text "yes <id>" / "no <id>" (fallback for clients that don't render buttons):
      - same regex Anthropic uses: /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
      - same allowlist + id check + .decision write
```

**Files touched:**
- `tabby-plugin-ai-sidebar/src/hook-runtime.service.ts` — extend HANDLER_SH
  permission flow with relay branch AFTER existing auto-approve short-circuit;
  mirror in HANDLER_PS1
- `tabby-plugin-ai-sidebar/src/auto-approve.service.ts` — **untouched**.
  Auto-approve UI and flag write stay exactly as-is.
- `tabby-plugin-mobile-bridge/src/permission-mode.service.ts` — NEW. Writes
  `~/.glanceterm/permission-relay.flag` from a new sidebar toggle owned by
  this plugin (lives next to the existing mobile-bridge settings panel, NOT
  next to auto-approve).
- `tabby-plugin-mobile-bridge/src/permission-relay.service.ts` — NEW. Watches
  `~/.glanceterm/permissions/` and bridges `.req` ↔ `.decision` to TG.
- `tabby-plugin-mobile-bridge/src/inbound-router.service.ts` — add callback
  query + verdict text handling.
- `tabby-plugin-mobile-bridge/src/telegram/client.service.ts` — add
  `answerCallbackQuery`, support `reply_markup` on sendMessage.
- `tabby-plugin-mobile-bridge/src/telegram/types.ts` — `InlineKeyboardMarkup`,
  `CallbackQuery`.

**Edge cases:**
- Handler killed mid-poll (Claude exits, tab closed): orphan `.req` files.
  PermissionRelayService sweeps `.req` files older than 30 min on startup
  and deletes them.
- Two bindings both push the same .req → both buttons live → first verdict
  wins, second is dropped silently (handler's polling sees the .decision
  file, exits).
- User mashes Allow twice → answerCallbackQuery + no-op on second .decision
  write (file already exists).
- Inline keyboard callback fails (Telegram quirks): the text "yes <id>"
  fallback always works.

**Decided 2026-06-08:** flag granularity = **global** `~/.glanceterm/permission-relay.flag`.
Per-tab override deferred to v2 (clean upgrade path: env var
`GLANCETERM_PERMISSION_MODE=relay` injected per session, handler reads env
first, falls back to global flag).

---

### Block 2 — Reverse text input: smart routing
**Effort: ~2 days.**

```
InboundRouter (extended, after permission-relay routes)
  │
  ├─ skip if /bind <code>          (existing)
  ├─ skip if /snap                  (Block 3 handles)
  ├─ skip if yes/no <id> verdict    (Block 1 handles)
  └─ fallthrough: route as "input to the tab this topic belongs to":
      - resolve binding + topic → tab UUID (via existing TopicService reverse map)
      - look up tab via TabIdentityService → outerTab → innerTab.session
      - peek TabMonitor's TabState for that tab:
          if state.aiTool != null:
              session.write(text + '\n')          // PTY input
              react ✓ on the IM message
          else:
              reply "🚫 this tab has no agent running — type /sh <cmd> in v2
                     to run shell commands directly"
              (NB: /sh is RESERVED, unimplemented v1)
```

**Files touched:**
- `tabby-plugin-mobile-bridge/src/inbound-router.service.ts`
- `tabby-plugin-mobile-bridge/src/pty-keystroke/registry.ts` (already exists,
  placeholder — flesh out)
- `tabby-plugin-mobile-bridge/src/telegram/client.service.ts` — add
  `setMessageReaction` (or fall back to sending a `✓` reply)

**Edge cases:**
- Topic doesn't map to a known tab (user closed the tab) → reply "tab is
  gone, sorry"
- Tab is in a split — pick the focused inner pane? Or the first one?
  v1 decision: first inner pane (matches TopicService current behavior).
  Document the limit.
- Very long phone message (>2KB) → truncate + warn (Telegram caps at 4096
  chars anyway)
- Binary / emoji input → write as UTF-8, trust PTY to handle
- Sender not in allowlist → silent drop (existing gate)

---

### Block 3 — `/snap` screenshot command
**Effort: ~2-3 days. Replaces "PTY mirror" requirement at 5% the cost.**

```
InboundRouter
  └─ text starts with "/snap" (with optional trailing tab number):
      - resolve target tab (this topic's tab if no number; tab #N otherwise)
      - if !tab → reply "tab not found"
      - else:
          await ScreenshotService.captureTab(tab) → Buffer (PNG, ~80-200KB)
          await TelegramClient.sendPhoto(chatId, buffer, {
              messageThreadId,
              caption: `📸 #${tab.idx} · ${tab.title} · ${formatTime()}`,
          })
```

**ScreenshotService (NEW):**
- Reuse the existing `tabby-plugin-ai-sidebar/src/screenshot/` module if it
  fits (need to check what it does — looks like it already has Electron
  capture helpers based on grep)
- Otherwise: `webContents.capturePage(rect)` where `rect` is the bounding
  box of the tab's xterm container element
- Crop to terminal area (skip Tabby chrome)
- PNG, quality 80%, max edge 1600px (Telegram likes it small)

**Files touched:**
- `tabby-plugin-mobile-bridge/src/screenshot.service.ts` — NEW (or wrapper
  on existing ai-sidebar screenshot)
- `tabby-plugin-mobile-bridge/src/inbound-router.service.ts`
- `tabby-plugin-mobile-bridge/src/telegram/client.service.ts` — add
  `sendPhoto` (multipart upload, this is the heaviest new client method)

**Edge cases:**
- Tab not visible (background) → Electron's webContents.capturePage works
  off-screen too, but xterm may not have repainted recently. Force-paint
  via xterm.refresh() before capture.
- HiDPI / Retina → capture in CSS pixels not device pixels, or Telegram
  rescales to lossy.
- Multiple tabs in split → screenshot the active inner pane (consistent
  with /reverse-input routing).

---

### Block 4 — Multi-agent outbound (codex / aider / goose)
**Effort: ~3 days.**

Today's `TranscriptTailerService` only knows Claude's `.jsonl` format. For
non-Claude agents:

```
Per-agent adapter (in tabby-plugin-ai-sidebar/src/hook-adapters/):
  - claude.ts (exists) — already maps PreToolUse/PostToolUse/Stop/etc → status
  - codex.ts (exists?) — verify; add transcript-path extraction if Codex emits one
  - aider.ts (NEW) — Aider writes .aider.chat.history.md; tail that
  - goose.ts (NEW) — Goose has its own session format; tail it

PtyTailerService (NEW, fallback for agents without structured transcript):
  - subscribe to inner.session.output$
  - run ANSI stripper (steal logic from existing screenshot code or use
    `strip-ansi` npm pkg)
  - rolling buffer per tab; emit "chunk" events on quiet (debounce 1s)
  - feed into existing OutboundDispatcher.dispatchTranscript path with
    kind: 'assistant_text'
```

**Files touched:**
- `tabby-plugin-ai-sidebar/src/hook-adapters/{aider,goose}.ts` — NEW
- `tabby-plugin-mobile-bridge/src/transcript/pty-tailer.service.ts` — NEW
  (parallel to existing TranscriptTailerService, same events$ shape)
- `tabby-plugin-mobile-bridge/src/outbound-dispatcher.service.ts` — wire
  the new pty-tailer's events$ alongside existing transcript.events$

**Decision rule per agent:**
- Claude → TranscriptTailer (structured jsonl, no false positives)
- Codex → if it writes a structured transcript: tailer; otherwise PtyTailer
- Aider → tail `.aider.chat.history.md` (markdown, parseable)
- Goose → TBD on inspection of its session format
- Unknown/future → PtyTailer (ANSI-stripped, debounced)

**Out of v1:** permission relay for non-Claude agents. Each has its own
permission protocol (codex sandbox approval, aider's `--yes-always`, goose's
allow-list config). v2 work.

---

### Block 5 — Schema reservations for group/team v2
**Effort: ~1 day. Just type definitions + doc, no behavior.**

Add to `BindingStore`'s `ChannelBinding` schema (TS interface + zod):

```ts
export interface ChannelBinding {
  // ... existing fields ...

  /**
   * Reserved for group/team mode (v2). Determines when the bot replies in
   * a group chat. v1 ignores this field — DMs always relay 1:1.
   */
  mentionMode?: 'always' | 'mention' | 'reply'

  /**
   * Reserved for group/team mode (v2). When true, permission requests
   * broadcast to all approvedSenders; the first verdict wins. When false
   * (default), only the tab's "owner" sender gets the prompt.
   */
  broadcastPermissionRequests?: boolean

  /**
   * Reserved for group/team mode (v2). 'per-tab' (current behavior) opens
   * one Telegram Forum Topic per GlanceTerm tab. 'shared' uses a single
   * topic with `#N` prefixes in every message. Trade-off: per-tab is
   * cleaner but eats topic quota; shared survives 1000-tab abuse.
   */
  groupTopicMode?: 'per-tab' | 'shared'
}
```

All three fields are read in BindingStore but never branched on in v1 logic
(grep `mentionMode` etc. should return only the type def). v2 work adds the
branches.

---

### Block 6 — Buffer: testing, polish, docs
**Effort: ~3 days.**

- Integration test: full permission-relay round trip (local + remote)
- Smoke: `/snap` returns PNG ≥1 KB for a non-trivial terminal
- Smoke: reverse text routes correctly across claude/codex/bash/vim tab
- Doc: update [todo-mobile-bridge.md](./todo-mobile-bridge.md) status to
  "T0 superseded by mobile-bridge-v2"
- README in `tabby-plugin-mobile-bridge/`: per-feature usage with screenshots
- Memory: drop the `monitor_debug_dump_cleanup.md` instruction if the v2
  work resolves it (verify raw-payloads.log no longer needed)

---

## Total

**~3.5 weeks** of focused work (~18 working days). Compares to:
- v0/T0 estimate in todo-mobile-bridge.md: 1.5 weeks (delivered ~Jun 6-7)
- Full self-built native-app path (rejected): 2-3 months
- Use Happy directly (rejected — wrong constraints): 0 weeks but no GlanceTerm
  integration and no non-Claude support

## Validation gate (post-v1)

Same shape as todo-mobile-bridge.md:
- ≥30% activation among installed users in 4 weeks → invest in Feishu (v2)
- <10% → freeze; flag mobile-bridge as low-priority maintenance

Specifically tracked:
- Permission-relay activations per week per user (the killer feature — if
  this isn't getting used heavily, the value prop is broken)
- Average minutes saved per permission relay (proxy via timestamp delta
  between request and decision)
- `/snap` invocations per week per user (validates the "see terminal" use
  case isn't unmet)

## Out of scope (v2+)

- **Feishu**: same wire protocol, swap transport. Cards (richer than TG
  inline keyboard), 群组 mention detection, 飞书机器人长连接.
- **`/sh <cmd>`** shell escape in reverse input
- **Permission relay for non-Claude agents** (per-agent adapter work)
- **File diff preview** as proper rich content (today's `/snap` covers it
  visually; rich diff is a v2 polish)
- **Group/team mode**: branching on the reserved schema fields
- **Voice input** (Happy has it; pass for v1)
- **iOS native app** (explicitly ruled out 2026-06-08)
- **Self-built relay** (explicitly ruled out 2026-06-08)

## Decision log

- **2026-06-06**: T0 scoped — Telegram bidirectional MVP, outbound state pings.
- **2026-06-07**: Mobile-bridge ships outbound (assistant_text + state
  transitions). Two correctness bugs found post-ship (transcript-path slug,
  identity uuid mismatch).
- **2026-06-08 AM**: Bugs fixed in a 7-file PR (hook-runtime emits
  transcript_path; HookSnapshot surfaces it; TabState exposes hook tab_id;
  TabIdentityService gains byHookTabId; dispatcher rewires).
- **2026-06-08 PM**: Product owner explicitly requests "Anthropic Remote
  Control effect." Competitive research surfaces (a) Anthropic's own
  Channels Telegram plugin and (b) Happy as full RC clone. Owner reasserts
  constraints: no app, no server, only Telegram + Feishu. Decisions locked:
  - Telegram v1, Feishu v2
  - Self-build (not Anthropic Channels) — must support non-Claude agents
  - Personal DM v1, schema-reserve group fields
  - Reverse input = smart route (Option 2)
  - Permission relay = parallel-race (Anthropic style)
  - `/snap` in v1
- → THIS DOCUMENT v0, 2026-06-08 AM.
- **2026-06-08 PM**: Discussed auto-approve / permission-relay coexistence.
  Decision: two independent switches; hook-level short-circuit means
  auto-approve fires first and never reaches relay code path; phone stays
  silent on auto-approve hits (no `ℹ️ auto-approved` notifications). No new
  3-mode unified UI — existing two switches stay where they are. → THIS
  DOCUMENT v1.
