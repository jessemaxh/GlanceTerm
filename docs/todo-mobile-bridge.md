# TODO — Mobile Bridge

Push agent status to phone, control tabs remotely.

**Status:** scoped, not started · **Added:** 2026-06-06

Naming convention: one file per scoped feature, `todo-<feature-slug>.md`.
Records the constraints / decisions reached during scoping so a future read
doesn't have to rebuild the context.

### One-liner
Let users get notified on their phone when an AI agent in any GlanceTerm tab
needs attention (permission prompt, completion, crash), and let them approve /
reply / send commands back to that specific tab from the phone — without
GlanceTerm running any server-side infrastructure.

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
- Composing real coding prompts on a phone keyboard is awful — bidirectional
  send-input from phone may be 80% imagined.
- Single-tab users (probably the majority) don't have the "which tab is
  asking me" pain that motivates the multi-tab UX.
- Cloud agents (Cursor, Devin) sidestep the problem entirely by hosting the
  agent. Our target users specifically chose desktop over cloud — that
  filter shrinks the audience.

### Validation plan (before committing to T1+)
1. Search Reddit / Twitter / HN for `Claude Code notification mobile`,
   `Claude permission phone`, `coding agent remote approve`. ≥20 raw
   complaints → A is real. <10 → audience is thinner than assumed.
2. Check GlanceTerm GitHub issues for independent requests. ≥2 organic
   asks → go.
3. Ship T0 (single-direction push) → measure activation. >30% of installed
   users configure a webhook within 4 weeks → invest in T1. <10% → stop
   at T0.

### Hard architectural constraints (decided 2026-06-06)
1. **No server we run.** Zero ongoing ops cost. Aligned with GlanceTerm's
   "your code stays local" positioning.
2. **No bot we create.** Every supported platform is BYO bot — user
   creates the bot, pastes credentials into GlanceTerm.
3. Bidirectional transport must work behind NAT / firewall (outbound
   connections only).

### Feature tiers

#### T0 — Single-direction push (`tabby-plugin-mobile-notify`)
**Goal:** verify "users want phone notifications for agent events" before
investing in bidirectional.

- Subscribe to `AttentionNotifierService` + `TabMonitor.states$` transitions
  + hook events.
- POST a structured JSON payload to a user-configured webhook URL.
- Built-in templates for: ntfy.sh, Pushover, Bark, Slack webhook, Discord
  webhook, Telegram bot direct, Feishu 群机器人, 企业微信 群机器人,
  钉钉 群机器人, generic JSON.
- Per-event include/exclude filters.
- "Send test" button in settings.
- Retry with exponential backoff; offline queue.
- **Effort:** ~44h / 1.5 weeks.

#### T1 — Telegram BYO bidirectional (full remote control)
**Trigger:** T0 shows ≥30% activation within 4 weeks.

- User creates bot via @BotFather (1 minute).
- GlanceTerm long-polls `getUpdates` — no relay, no public URL.
- 1-on-1 chat with bot (user can also opt into Forum-Topics-per-tab mode
  if they want).
- InlineKeyboard buttons for approve / reject / reply-to-tab.
- ForceReply + state machine + `/use <n>` command for free-text send-input.
- Per-AI-tool `approveKeystroke()` / `rejectKeystroke()` in adapter
  registry — Claude / Codex / Aider each needs its own mapping verified
  empirically.
- editMessage to mark "✓ approved by you @ 12:34:51".
- `/list`, `/tab`, `/help`, `/use`, `/exit` commands.
- **Effort:** ~70h / 2.5 weeks (vs. 124h with hosted relay — BYO saves the
  Cloudflare Worker tier).

#### T2 — Feishu BYO bidirectional
**Trigger:** Chinese-user demand from T0/T1 metrics.

- User creates 1-person 飞书企业 + 自建应用 + enables
  长连接事件订阅（WebSocket mode, no public URL needed — same idea as
  Slack Socket Mode).
- GlanceTerm uses 飞书 Node SDK to connect outbound and receive events.
- Interactive cards (the killer feature here): action buttons + dropdowns +
  embedded text inputs all in one card.
- In-place card update for "approved" / "rejected" state transitions.
- 1-on-1 chat with bot (no group / topic requirement).
- Configuration wizard with screenshots (the 飞书企业 setup is the friction
  point — needs hand-holding).
- **Effort:** ~60-70h / 2 weeks.

#### T3 — Other platforms (add by demand signal)

| Platform | Mechanism | Effort | When to add |
|---|---|---|---|
| Discord BYO | Gateway WebSocket | ~30h | Western open-source community signal |
| Slack BYO | Socket Mode | ~30h | Enterprise/team-use signal |
| 钉钉 BYO | Stream API (2024+) | ~30h | Chinese enterprise users |
| 企业微信 群机器人 | webhook (one-way only) | already in T0 | covered |
| WhatsApp | requires Business API + server | — | parked, breaks no-server rule |
| 微信公众号 | webhook + heavy quota limits | — | parked, can't push reliably |
| 个人微信 | no official API | — | won't do (封号 risk) |

### Platform capability summary (under "BYO + no server" constraint)

| Platform | Bidirectional? | Why |
|---|---|---|
| Telegram | ✅ | `getUpdates` long polling |
| Feishu | ✅ | 长连接 event subscription |
| Discord | ✅ | Gateway WebSocket |
| Slack | ✅ | Socket Mode |
| 钉钉 | ✅ | Stream API |
| 企业微信 | ❌ push-only | webhook-only event delivery |
| WhatsApp / LINE / 公众号 | ❌ | webhook-only |
| ntfy / Pushover / Bark | ❌ by design | one-way push services |

### Open design questions
1. **Per-agent approve keystroke mapping** — Claude (Enter), Codex (`y`),
   Aider (?), Gemini (?), opencode (?). Need empirical verification per
   tool version. Document version pins as we go.
2. **Offline queue semantics** — GlanceTerm offline for hours. Do we
   replay all missed `needs_permission` events on reconnect (might be
   stale), or only events <N minutes old?
3. **Multi-device sync** — two phones get same `needs_permission` push.
   First one approves. Second one's card updates to "already handled by
   other device"? Requires extra round-trip; might not be worth it for v1.
4. **Sensitive-data redaction** — terminal output may contain tokens,
   secrets. Default policy: push only structured semantic events
   (`PreToolUse(Bash, ...)`), not raw stdout. Raw stdout only via explicit
   "look detail" pull.
5. **Tab numbering stability** — `#3` in the phone UI is sidebar
   `tabIndex(s)`. If user reorders tabs mid-session, what does "/use 3"
   mean? Snapshot the ID at message send time vs. resolve live?

### Files this would touch / create
- New plugin: `tabby-plugin-mobile-notify` (T0) + `tabby-plugin-mobile-bridge` (T1+)
- Hook into existing: `AttentionNotifierService`, `TabMonitor.states$`,
  `HookWatcherService`, per-adapter `approveKeystroke()`
- New settings panel in tabby-settings
- No changes to core Tabby

### Carry-over notes from scoping conversation
- Original sketch considered a Cloudflare Worker relay → dropped because
  it violates "no server" rule. Saved ~38h of work + ongoing ops.
- 微信 个人 was discussed and ruled out (no official API). 微信 公众号
  ruled out (no message buttons + push quota limits). 企业微信 stays as
  one-way bot fallback.
- OpenClaw (the reference the user started with) is a different product
  shape — it's "AI assistant routed through messengers", not "remote
  control of desktop agents". Not a direct competitor; can be a downstream
  integration target if it ever exposes a skill plugin model we can hook.

### Decision log
- 2026-06-06: scoped feature; agreed on T0-first validation approach.
- 2026-06-06: ruled out hosted-relay architecture. BYO bot + no server is
  the architectural rule going forward.
- 2026-06-06: Feishu 长连接 mode confirmed viable under BYO + no-server
  rule (earlier doc revision incorrectly assumed Feishu was push-only).
