# TODO — Mobile Bridge

Bidirectional remote control of GlanceTerm tabs from a phone IM.

**Status:** scoped, not started · **Added:** 2026-06-06 · **Revised:** 2026-06-07

Naming convention: one file per scoped feature, `todo-<feature-slug>.md`.
Records the constraints / decisions reached during scoping so a future read
doesn't have to rebuild the context.

### One-liner
Each GlanceTerm tab gets a 1-to-1 surface in a phone IM (Telegram Forum
Topic / 飞书 互动卡片). When the agent needs attention the surface lights up;
the user replies in that same surface and it goes back to the right tab.
BYO bot, no server, outbound-only.

### Why this might be worth building
- `AttentionNotifierService` already exists for desktop notifications →
  signal that "agent demands attention" is a real pain.
- Claude Code / Codex turns can run for tens of minutes; users walking away
  from their desk routinely miss permission prompts and lose hours.
- DIY evidence exists: developers already pipe Claude hooks to
  ntfy.sh / Pushover / Slack webhooks. Integrated product doesn't exist.
- Reference comparables: GitHub Mobile (remote PR/deploy approve), PagerDuty
  (mobile ack), Cursor agents.cursor.com (cloud-agent dashboard).

### Why it might be over-imagined
- Single-tab users (probably the majority) don't get the "which tab is
  asking me" pain that motivates the per-tab UX.
- Cloud agents (Cursor, Devin) sidestep the problem entirely by hosting the
  agent. Our target users specifically chose desktop over cloud — that
  filter shrinks the audience.
- Phone keyboard composition is slow → users may approve buttons happily
  but rarely compose real prompts on phone. That's fine — the value is
  unblocking long-running agents, not full remote coding.

### Validation plan
1. Search Reddit / Twitter / HN for `Claude Code notification mobile`,
   `Claude permission phone`, `coding agent remote approve`. ≥20 raw
   complaints → A is real. <10 → audience is thinner than assumed.
2. Check GlanceTerm GitHub issues for independent requests. ≥2 organic
   asks → go.
3. Ship T0 (Telegram bidirectional MVP) → measure activation. >30% of
   installed users configure a bot within 4 weeks → invest in T1 (飞书).
   <10% → stop after T0.

### Hard architectural constraints (decided 2026-06-06, refined 2026-06-07)
1. **No server we run.** Zero ongoing ops cost. Aligned with GlanceTerm's
   "your code stays local" positioning.
2. **No bot we create.** Every supported platform is BYO bot — user
   creates the bot, pastes credentials into GlanceTerm.
3. Bidirectional transport must work behind NAT / firewall (outbound
   connections only).
4. **Per-tab surface uses the platform's native primitive** — Telegram
   Forum Topics, 飞书 互动卡片. Do NOT invent a command system (`/use 3`,
   `/list`, `/tab`) on top. If the platform can't express "this message
   belongs to tab X" natively, it's the wrong platform.
5. **Tabs identified by session-stable UUID, not tabIndex.** Display uses
   `#<index> · <name>`; routing uses UUID. Reorder is invisible to the IM
   side; UUID is regenerated only when a tab is closed and a new one
   opened.
6. **Text-first interaction; buttons only where text is ambiguous.** In
   a Forum Topic, the user types in the topic to talk to that tab. We do
   NOT translate "approve" into an InlineKeyboard button on Telegram —
   user types `y` (or whatever the agent expects). Buttons are reserved
   for 飞书 cards where the card *is* the surface.
7. **Whitelist senders, silently drop the rest.** Only `approvedSenders`
   IDs (set up during pairing) have their input routed to the PTY.
   Unknown senders are dropped without acknowledgement and noted in
   `~/.glanceterm/mobile-bridge.log` for the owner to audit. Silence
   denies attackers signal about whether a binding exists.
8. **Each binding is independently togglable but per-tab toggling is
   not a thing.** A tab is either bound to mobile (because the global +
   platform + event-type filter says so) or it's not. Want to silence
   a specific kind of tab? Use the per-event-type filter, or turn the
   binding off.

### Feature tiers

#### T0 — Telegram bidirectional MVP (`tabby-plugin-mobile-bridge`)
**Goal:** validate "users want bidirectional phone control of agent tabs"
on the lowest-friction platform.

**UX:**
- User creates bot via @BotFather (~1 minute), creates a super-group with
  Topics enabled, adds bot as admin (~1 minute).
- GlanceTerm long-polls `getUpdates` (outbound only, no public URL).
- For each GlanceTerm tab: one Forum Topic, auto-created on first event,
  titled `#<index> · <tab-name>`, suffixed with last 4 chars of UUID for
  disambiguation. Topic stays even if the tab closes (history).
- Agent-attention events post to the topic as a plain message.
- User reply in the topic → routed to the originating tab's PTY input.
  No command prefix. No state machine. Text in = text in.
- State transitions (running → idle, completed, crashed) post a one-line
  status update to the topic.

**Built:**
- Telegram bot client (getUpdates long-polling, outbound only).
- Per-tab UUID system + display index synchronization.
- Forum Topic create / edit / archive lifecycle keyed by UUID.
- Event → topic message: `PreToolUse(Bash)` permission prompts, hook
  events from `HookWatcherService`, state transitions from
  `TabMonitor.states$`, attention triggers from `AttentionNotifierService`.
- Topic → PTY input router (UUID → tab → PTY write).
- Per-AI-tool keystroke adapter: Claude (Enter), Codex (`y` / `n`),
  Aider (TBD), opencode (TBD). Empirically verified, version-pinned.
- `/bind <code>` pairing flow that locks `chatId`, `ownerUserId`,
  and seeds `approvedSenders = [ownerUserId]`.
- Bot token stored via keytar (system keychain), never in settings.json.
- Sender whitelist enforced at the inbound router; drops + logs unknown
  senders to `~/.glanceterm/mobile-bridge.log`.
- Cross-binding "resolved elsewhere" sync: when agent state moves past
  a prompt, post a short `✓ resolved via <platform> at <time>` to other
  active bindings so the user doesn't double-answer.
- Quiet hours: configurable window (e.g. 23:00–07:00); during quiet
  only `task_failed` passes through.
- Settings panel: bindings list (add/remove/edit), per-platform on/off,
  per-event-type filter, quiet-hours window, approved-senders editor,
  "send test" button.
- Retry with exponential backoff (~5 attempts, max ~1 min). On final
  failure, drop the event and log. No persistent queue, no replay.
  Rationale below in Open questions #2.

**Effort:** ~60h / 2 weeks.

#### T1 — 飞书 bidirectional (互动卡片)
**Trigger:** T0 activation ≥30% within 4 weeks.

**UX:**
- User creates 1-person 飞书企业 + 自建应用 + enables 长连接事件订阅
  (WebSocket mode, no public URL — same idea as Slack Socket Mode).
- For each tab: one interactive card per event (not per tab). A card
  carries: title (`#<index> · <tab-name>`), status chip (running / waiting
  / done), the prompt or status detail, action buttons (approve / reject
  where applicable), and an embedded text input.
- User taps approve → routed to that tab. Types in the card's input →
  routed to that tab. Card updates in-place with `editMessage` to show
  resolution.

**Built:**
- 飞书 Node SDK + 长连接 connection.
- Reuses T0's UUID system, PTY input router, keystroke adapter, settings
  framework, sender whitelist, pairing flow, quiet hours, cross-binding
  "resolved elsewhere" sync.
- Card designer (template per event type).
- Card action callback → PTY router.
- In-place card update for resolution states.
- Configuration wizard with screenshots — 飞书企业 + 自建应用 + 长连接
  is the friction point; needs hand-holding.

**Effort:** ~50h / 2 weeks (T0 builds the shared infra).

#### T2 — Other platforms (add by demand signal)

| Platform | Native per-tab primitive | Mechanism | Effort | When |
|---|---|---|---|---|
| Discord BYO | Threads | Gateway WebSocket | ~30h | Western OSS community signal |
| Slack BYO | Threads | Socket Mode | ~30h | Enterprise/team-use signal |
| 钉钉 BYO | 互动卡片 | Stream API (2024+) | ~30h | Chinese enterprise signal |
| 企业微信 | (push-only, no per-tab reply) | webhook | — | parked, breaks bidirectional rule |
| WhatsApp / 公众号 / 个人微信 | — | — | — | parked, see notes |

### Platform capability summary (under "BYO + no server + bidirectional + per-tab native primitive")

| Platform | Bidirectional? | Per-tab primitive | Verdict |
|---|---|---|---|
| Telegram | ✅ | Forum Topic | **T0** |
| 飞书 | ✅ | 互动卡片 | **T1** |
| Discord | ✅ | Thread | T2 candidate |
| Slack | ✅ | Thread | T2 candidate |
| 钉钉 | ✅ | 互动卡片 | T2 candidate |
| 企业微信 | ❌ push-only | — | excluded |
| WhatsApp / LINE / 公众号 | ❌ | — | excluded |
| ntfy / Pushover / Bark | ❌ by design | — | excluded |

### Open design questions
1. **Per-agent approve keystroke mapping** — Claude (Enter), Codex (`y`),
   Aider (?), Gemini (?), opencode (?). Need empirical verification per
   tool version. Document version pins as we go. Even with text-first
   interaction, the router still needs to know what a user-typed "yes"
   becomes at the PTY layer (might be Enter, might be `y\n`, might be
   `1\n` for numbered prompts).
2. ~~Offline queue policy~~ — **decided 2026-06-07: no queue.** Retry
   with exponential backoff covers desktop network jitter. Long desktop
   outage means cloud agents (claude/codex/gemini) also can't run, so
   no events are produced. Phone-side outage is handled by the IM
   platform syncing on reconnect. Desktop shutdown deliberately drops
   state — new session on relaunch.
3. **Multi-device sync** — two phones in the same Telegram group both
   see the same prompt; either device can reply. No special handling
   needed because the underlying IM already syncs state across the
   user's devices. Free.
4. **Sensitive-data redaction** — push structured semantic events
   (`PreToolUse(Bash, command=...)`), not raw stdout. Raw stdout only on
   explicit user request (e.g. reply `show output` in the topic).
5. ~~Tab numbering stability~~ — **decided 2026-06-07**: session-stable
   UUID for routing; display `#<index> · <name>` for human-reading;
   reorder is invisible to the IM side.

### Files this would touch / create
- New plugin: `tabby-plugin-mobile-bridge` (both T0 + T1 live here)
- Hook into existing: `AttentionNotifierService`, `TabMonitor.states$`,
  `HookWatcherService`, per-adapter `approveKeystroke()`
- New settings panel in tabby-settings
- New `TabIdentityService` (UUID provisioning + reorder-aware index)
- No changes to core Tabby

### Carry-over notes from scoping conversation
- Original sketch (2026-06-06) considered a Cloudflare Worker relay →
  dropped because it violates "no server" rule. Saved ~38h of work +
  ongoing ops.
- 微信 个人 ruled out (no official API, 封号 risk). 公众号 ruled out
  (no message buttons + push quota limits). 企业微信 ruled out under
  bidirectional rule (webhook-only event delivery).
- OpenClaw (the reference the user started with) is a different product
  shape — it's "AI assistant routed through messengers", not "remote
  control of desktop agents". Not a direct competitor; can be a
  downstream integration target if it ever exposes a skill plugin model
  we can hook.
- Original T0 was "single-direction webhook push" (44h). **Killed
  2026-06-07** — its code (webhook templates, payload schema, retry/queue
  framework) does not meaningfully carry into bidirectional, and the
  product is bidirectional. Going straight to bidirectional T0 = saves
  44h dead-code investment.
- Original T1 was "Telegram bidirectional + InlineKeyboard + ForceReply
  state machine + `/use 3` command set" (70h). **Simplified 2026-06-07**
  to Forum Topics + text-only (~56h). Reasons: Forum Topics give us
  per-tab context for free; no command system needed; no state machine
  needed; no button-to-keystroke translation needed.

### Decision log
- 2026-06-06: scoped feature; agreed on T0-first validation approach.
- 2026-06-06: ruled out hosted-relay architecture. BYO bot + no server is
  the architectural rule going forward.
- 2026-06-06: Feishu 长连接 mode confirmed viable under BYO + no-server
  rule (earlier doc revision incorrectly assumed Feishu was push-only).
- 2026-06-07: bidirectional is the v1 target (no single-direction tier).
  Old T0 (webhook push) killed.
- 2026-06-07: first two platforms are Telegram (T0, ~56h) and 飞书
  (T1, ~46h). Discord / Slack / 钉钉 demoted to T2-by-signal.
- 2026-06-07: per-tab UX uses the platform's native primitive (Forum
  Topic / 互动卡片). No command system, no state machine, no button →
  keystroke translation layer.
- 2026-06-07: per-tab routing keyed by session-stable UUID, not tabIndex.
- 2026-06-07: dropped the offline queue. None of the realistic outage
  scenarios actually need one — see Open questions #2.
- 2026-06-07: control / security model decided:
  - 4-level switch hierarchy (global · per-platform · per-event-type ·
    quiet hours). Per-tab toggle deliberately omitted — too noisy for
    the gain; per-event-type filter or disabling the binding covers
    real needs.
  - Multiple bindings allowed simultaneously, fan-out delivery.
    v1 cap: one binding per platform (Telegram + 飞书 = 2 max).
  - `/bind <code>` pairing flow replaces "user types group id".
  - `approvedSenders` whitelist; unknown senders silently dropped +
    logged to `~/.glanceterm/mobile-bridge.log`.
  - Quiet hours in v1 (only `task_failed` passes through).
  - Cross-binding "resolved elsewhere" sync via agent state observation,
    not internal coordination locks.
