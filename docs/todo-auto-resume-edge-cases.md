# TODO — Auto-resume edge cases (low priority)

**Status:** backlog · **Added:** 2026-06-15 · **Source:** adversarial review of the
auto-resume-by-session-id change (working-tree review, 2026-06-15)

Two real-but-minor robustness gaps surfaced during review of the resume-by-exact
-session-id feature. Both are conservative/self-healing today and affect mainly
the experimental (🧪) agents, so they were deferred rather than fixed in that
change. Fix when convenient (good first-issue material after open-sourcing).

The one finding that WAS fixed in that change for reference:
- ✅ `hook-watcher.service.ts` — `sessionId` is now sticky like `model` (with a
  fresh-`SessionStart` guard so a new session never inherits the prior id).

## 1. `strip` flag parser assumes `-r/--resume`, `-s/--session` always take a value

- **Where:** `tabby-plugin-ai-sidebar/src/auto-resume.service.ts` (~`:657-677`,
  the `strip` helper inside `buildResumeCommand`).
- **What:** The parser unconditionally consumes the next token as the value of
  `-r/--resume` / `-s/--session`. Input like `claude -r --model opus` (resume
  short-form with no id) then eats `--model` as `-r`'s value and leaves `opus`
  as a stray positional → `claude --resume <id> opus`. Result still passes
  `isShellSafe`, so it gets typed.
- **Impact:** Low — unusual input. The common `--resume <oldid> --model opus`
  works correctly.
- **Fix:** Only skip the next token when it does NOT itself start with `-`.

## 2. Generation-gate stamps `seenAt = Date.now()` against second-granular `eventAt`

- **Where:** `tabby-plugin-ai-sidebar/src/tab-monitor.ts` (~`:813-823`).
- **What:** The generation gate sets `seenAt` at pid-*detection* time
  (millisecond `Date.now()`), but `snap.eventAt` is second-granular
  (`parsed.ts * 1000`, floored). When a new session's first hook lands BEFORE the
  poll notices the new pid, that valid event has `eventAt < seenAt` and the
  correct new-session id is suppressed until the session emits a SECOND event.
- **Impact:** Low/conservative — practical bite is: start a 2nd agent in a reused
  tab and quit the app before it fires another event → resumes fresh instead of
  `--resume <id>`. Safe direction (never resumes the wrong session); self-heals
  on the next event.
- **Fix:** Tolerate the floor — compare `snap.eventAt + 1000 < seenAt`, or stamp
  `seenAt` from the prior session's last `eventAt` rather than `Date.now()`.
