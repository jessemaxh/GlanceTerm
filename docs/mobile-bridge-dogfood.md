# Mobile Bridge — Dogfood Guide (MVP v0, Telegram only)

Hand-on checklist for the first end-to-end test of `tabby-plugin-mobile-bridge`.
Treat this as a recipe: every step has an expected outcome and a "this is
how you know it broke" line. Print it out or keep it open on a phone while
you sit at the desktop.

The plugin has had ZERO compile verification. Expect the first build to
fail; the table at the bottom maps common failures to fixes.

---

## 0. Prerequisites

### Telegram side
1. Open Telegram, search for `@BotFather`, `/newbot`, follow prompts. Save
   the **bot token** — looks like `123456789:AAEhBP...`. Keep it secret.
2. Create a new **super-group** in Telegram (regular group → upgrade to
   super-group via settings).
3. Group settings → **Topics** → enable. (Without this Forum Topics don't
   exist and the bridge has nowhere to post tab-scoped messages.)
4. Add your bot to the group. Make it an **admin** with the **"Manage
   Topics"** permission. Without that permission `createForumTopic` will
   fail with a 4xx that the retry helper deliberately won't retry.

### Desktop side
1. Make sure the dirty pre-existing changes don't matter for this test —
   the mobile-bridge plugin only touches its own directory, the one-line
   `tabby-plugin-ai-sidebar/src/index.ts` barrel export, and the one-line
   `scripts/vars.mjs` registration.
2. **Decide when to restart GlanceTerm.** All in-flight Claude sessions
   will be lost. Pick a clean break.

---

## 1. Build (before restart)

The plugin needs its `node_modules`. Run this in a terminal **outside**
the GlanceTerm session you'll keep using:

```bash
cd /Users/you/work/glanceterm/glanceterm/tabby-plugin-mobile-bridge
yarn install --network-timeout 1000000
```

If yarn install passes, run a compile dry-run:

```bash
yarn build
```

Watch the output. Expected: `webpack` compiles, writes `dist/index.js`.

**If yarn install fails:** likely missing tabby-* peer in node_modules.
Fall back to the monorepo install which sets up the symlinks:

```bash
cd /Users/you/work/glanceterm/glanceterm
node scripts/install-deps.mjs
```

**If `yarn build` fails:** read the first error carefully.
- `Cannot find module 'tabby-plugin-ai-sidebar'` → the symlink under root
  `node_modules` isn't there yet. Run the monorepo install above.
- `TS2304: Cannot find name 'X'` → an actual missing import. Should not
  happen after the fix commits but if it does, jot the symbol name —
  the fix is one line.
- `error TS2322` involving the inline settings template → Angular strict
  templates rejecting a property binding. Most likely candidate is
  `[checked]` on an input; can be patched by switching to
  `[(ngModel)]="b.enabled"` with an explicit binding.
- Anything with `@ngtools/webpack` → the `.mjs` config path; for the
  in-plugin `yarn build` we use the `.js` config which doesn't run this.
  Safe to ignore at this stage; will get tested by the full GlanceTerm
  build during electron launch.

---

## 2. Restart GlanceTerm

1. Save your work in any open Claude tabs. Close GlanceTerm.
2. Launch fresh.
3. Open devtools (View → Developer → Toggle Developer Tools, or
   `Cmd+Opt+I`).
4. In the console, look for:
   ```
   [glanceterm] plugin loaded                 ← ai-sidebar
   [glanceterm:mobile-bridge] plugin loaded   ← us
   ```
   Both lines must appear. If the mobile-bridge line is missing,
   `scripts/vars.mjs` registration didn't take effect or the plugin
   crashed at construction — check for red error stacks before either
   "plugin loaded".

---

## 3. Bind a bot

1. **AI sidebar gear icon** (top of the left AI Tabs sidebar) → click
   the **Mobile Bridge** row → **Configure…**. If the row isn't there,
   the plugin didn't register with `SidebarSettingsRegistry`. Re-check
   `MobileBridgeModule`'s constructor for the `sidebarSettings.register(...)`
   call. Note: this used to live under Tabby's global Settings dialog
   (`BridgeSettingsTabProvider`) and has moved.
2. Paste the bot token from step 0.1 into the **Bot token** field.
3. (Optional) Label.
4. Click **Generate pairing code**.
5. UI shows a 6-char code (e.g. `ABCDEF`) and counts down 5 min.
6. Open Telegram → your super-group → general / any topic. Send
   **inside the group, not in a DM to the bot**:
   ```
   /bind ABCDEF
   ```
7. Within ~1-2 s the settings UI should clear back to the "Add Telegram
   binding" form, and the existing-bindings list shows your new binding
   with `enabled = true`, the right `chatId`, and your Telegram user id
   in `approvedSenders`.

**Failure modes:**
- UI never clears after `/bind` → `PairingService.onTelegramInbound` is
  failing. Check console for `[mobile-bridge:pairing]` warnings (the
  fix in `589ced05` makes these visible — they used to be swallowed).
- "Telegram start failed" red text → bot token typo, or token revoked.
- Bot never gets the message → bot isn't a member of the group. Add it.

---

## 4. End-to-end smoke (real Claude session)

Open a regular Claude tab in GlanceTerm. Inside it, prompt Claude to do
something that requires permission, e.g.:

```
Read the file at /etc/hosts and print its contents.
```

Claude will show a permission prompt. **Within seconds**, your Telegram
super-group should get a new Forum Topic titled like:

```
#1 · <your tab name> · <uuid-suffix>
```

with a message:

```
🔔 claude needs permission — check the desktop
```

In Telegram, **open that topic** and type:

```
1
```

(or just press Enter — Claude's permission prompt accepts both). The
text should arrive in the GlanceTerm tab and Claude proceeds.

Then let Claude finish its turn. When it goes idle, the same topic
should get:

```
✅ claude finished — ready for next prompt
```

---

## 5. Negative-path checks

### Sender whitelist
Use a second Telegram account (or have a friend in the group). Send any
message in the bound Forum Topic from that account. The bridge should
silently drop it. Verify:

```bash
tail -f ~/.glanceterm/mobile-bridge.log
```

Look for a JSONL line like:
```json
{"ts":"2026-...","kind":"inbound-drop","reason":"sender-not-whitelisted","chatId":...,"senderId":...,"textLen":...}
```

### Cancel pairing
Start a new pairing flow but click Cancel before sending `/bind`. The
Telegram long-poll loop should stop (no more api.telegram.org traffic).
Confirm by watching the network panel in devtools — `getUpdates`
requests stop.

### Reorder tabs
While the dogfood Claude tab is running, reorder it in the tab bar.
Trigger another permission prompt. The notification should still go
to the right Forum Topic — `displayIndex` updates but routing keys on
UUID.

### Topic title sync
Rename the tab (right-click → rename, if Tabby supports it). The next
event should `editForumTopic` to update the title in Telegram. Check
the Forum Topic name in Telegram.

---

## 6. Cleanup (Memory task #14 — Monitor DEBUG dump)

Once dogfood has triggered enough Claude activity, the Monitor field
name should be verifiable. Steps:

1. Read the dump:
   ```bash
   ls -la ~/.glanceterm/raw-payloads.log
   head -20 ~/.glanceterm/raw-payloads.log
   ```

2. Look for `PostToolUse(Monitor)` and `PreToolUse(TaskStop)` blocks.
   In each `tool_response` / `tool_input` JSON, find the task id field.
   Confirm it's `task_id` (snake_case) and NOT `taskId` (camelCase).
   If it's something else entirely (e.g. nested under `task.id`), the
   extractor in `hook-runtime.service.ts` needs a real fix.

3. If `task_id` (snake_case) is right — extractor order is already
   correct. Just clean up:
   - Edit `tabby-plugin-ai-sidebar/src/hook-runtime.service.ts`, delete
     the `# ── DEBUG ──` through `# ── END DEBUG ──` block (lines
     ~170-187).
   - `rm ~/.glanceterm/raw-payloads.log`
   - Rebuild + relaunch.
   - Delete the memory file:
     ```bash
     rm /Users/you/.claude/projects/-Users-you-work-glanceterm/memory/monitor_debug_dump_cleanup.md
     ```
     and remove its line from `MEMORY.md`.

---

## 7. Diagnostic file map

| Path | Purpose |
|---|---|
| `~/.glanceterm/mobile-bridge-bindings.json` | Persisted bindings (incl. bot token in v0 — see hardening note in `binding/types.ts`) |
| `~/.glanceterm/mobile-bridge-topics.json` | `(bindingId, tabUuid) → thread_id` cache |
| `~/.glanceterm/mobile-bridge.log` | Audit JSONL: inbound drops, outbound drops |
| `~/.glanceterm/raw-payloads.log` | Temporary Monitor field-name dump (delete after task #14) |
| `~/.glanceterm/handlers/glanceterm-hook.sh` | Live hook handler — regenerated every GlanceTerm launch |

---

## 8. Rollback

Branch `feat/mobile-bridge` is independent. To get back to the
pre-feature state:

```bash
cd /Users/you/work/glanceterm/glanceterm
git checkout main          # main is untouched
# or, if you want to drop everything including dirty work:
git checkout pre-mobile-bridge
```

The tag `pre-mobile-bridge` points to the exact commit GlanceTerm was
on before any mobile-bridge work started. Dirty changes in the working
tree at that moment are preserved on `feat/mobile-bridge` only (we
deliberately didn't commit them to main — see chat history).
