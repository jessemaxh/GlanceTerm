# Open-Source Readiness Checklist

**Status:** drafting · **Added:** 2026-06-11 · **Owner:** maintainer

This is the gate list for publishing GlanceTerm publicly. It is grounded in an
actual audit of the repo on 2026-06-11, not generic advice. GlanceTerm is a
**fork of [Tabby](https://github.com/Eugeny/tabby)** (MIT), so most legal /
CI / community scaffolding is inherited and already present — the remaining
work is small.

---

## Core principle — what gates the launch, and what does NOT

There are two different things people call "tests". Only one is a launch gate.

| | Gates launch? | Why |
|---|---|---|
| **Unit tests** (correctness of the logic we wrote) | ✅ Yes | CI must be green. Mostly there already: ai-sidebar ~20 test files, auto-resume 70/70, mobile-bridge 4. |
| **Live e2e per-agent / per-platform validation** (the `🧪` cells in [feature-matrix.md](feature-matrix.md)) | ❌ No | This is ongoing, community-assisted work. Open-sourcing is the *best way to get it done* — users on Gemini / opencode / Windows / Linux validate cells the solo maintainer can't. |

**Do not** gate the release on flipping every `🧪 → ✅` in the feature matrix.
Ship the matrix as-is, honestly labelled, and let the "Update protocol" in
that file collect validations via PRs. Gating open-source on completing the
matrix is backwards — it makes the maintainer do alone the work the community
is best positioned to do.

### The readiness bar (this is the whole gate)
1. Unit-test CI is green.
2. Clean build + run on the maintainer's primary platform (macOS).
3. No secret / personal-info leaks (small scrub — see 🔴 below).
4. README / marketing claims match the feature matrix (no overclaiming).
5. License + fork attribution correct (inherited from Tabby — present).

---

## 🔴 Must do before publishing (real blockers — all small)

> **Status 2026-06-11: the scrub items below were all executed in this pass.**

- [x] **Scrubbed personal paths from shipped source.** The `tailer.service.ts`
      slug-example comment genericised to `/Users/you/work/myproject`; the README
      ASCII-demo shell prompt username genericised to `you@host`.
- [x] **Genericised the internal dogfood doc.** `docs/mobile-bridge-dogfood.md`
      personal paths → `/path/to/glanceterm/...`; the maintainer-only "delete my
      Claude memory file" step removed. (It still reads as a private runbook —
      see the internal-docs note at the bottom if you'd rather exclude it.)
- [x] **Untracked `.env`.** `git rm --cached .env` done (it held only a commented
      `TABBY_CONFIG_DIRECTORY` template — no secret); `.env` / `.env.local` added
      to `.gitignore` so a future secret can't land there by reflex.
- [x] **README ⊆ feature matrix.** Removed the stale `aider` / `goose` mentions
      (both dropped from `AI_PATTERNS` on 2026-06-10, so the README was claiming
      process-detection that no longer exists) and corrected Codex from
      "untested" to "status detection verified" to match the matrix.
- [ ] **(Carried — your call) Stale Tabby content in translated READMEs.**
      `README.<lang>.md` (de/es/ja/zh/…) still describe *Tabby* and carry Tabby's
      ko-fi donate button (~line 10) — i.e. they'd misattribute donations and
      describe the wrong app. Decide: delete them (ship English-only for v1) or
      rewrite later. Not a launch blocker.

> **Corrected findings (my earlier draft was wrong on two):**
> - The README `hiveterm.com` (line 112) is **not** rename residue — it's a
>   *competitor* in the comparison table; intentional, keep it.
>   `docs/hiveterm-*.png` are unreferenced orphan shots; harmless, optional delete.
> - **Funding is already neutral:** `.well-known/funding-manifest-urls` points at
>   `https://null.page/funding.json` (a placeholder, not Tabby's). `docs/kofi.png`
>   is an unreferenced orphan — optional delete, not a blocker.
>
> Not a blocker: `electron-builder.yml:2 appId: com.souplin.glanceterm` is the
> intentional bundle id, not a leak. `firebase.json` is hosting config only — no
> API key is committed.

## 🟡 Should do (polish — improves the launch, not a blocker)

- [ ] **Disclose telemetry.** The app wires Firebase analytics. Add a short
      "What we collect / how to turn it off" note to the README or a PRIVACY.md.
      Open-source users expect this and it's cheap goodwill. (No analytics key is
      leaked — the concern is disclosure, not exposure.)
- [ ] **Confirm the Windows build still works in CI.** `.github/workflows/build.yml`
      builds macOS (arm64/x64) and Linux (multi-arch); verify Windows is still in
      the matrix and not broken by the fork's changes. The new plugins *do* carry
      win32/linux code paths (`tab-monitor.ts` uses PowerShell / `/proc` for
      process detection), so the cross-platform intent is real — it's just only
      been e2e-validated on macOS.
- [ ] **Add a short "Agent support" section to the README** that distils the
      feature matrix: Claude first-class, Codex solid, Gemini/opencode
      experimental, contributions welcome. This converts "tests aren't finished"
      from a weakness into a contribution on-ramp.
- [ ] **A 60-second demo GIF/video** at the top of the README. For a visual
      devtool this is the single highest-leverage launch asset.

## 🟢 Explicitly post-launch (do NOT gate the release on these)

- [ ] Flip `🧪 → ✅` for Gemini / opencode as they get validated (community or
      maintainer, over time) — tracked in [feature-matrix.md](feature-matrix.md).
- [ ] Windows / Linux end-to-end validation of the sidebar + hooks.
- [ ] In-flight features — none are v1 prerequisites:
  - `docs/todo-mobile-bridge.md` (v1) — scoped, not started.
  - `docs/todo-mobile-bridge-v2.md` (RC-effect parity) — scoped, not started.
  - `docs/todo-discord-bridge.md` — code complete, not yet dogfooded.
  - Ship these behind an "experimental" flag or disabled by default rather than
    blocking on them.

---

## Publishing — where the repo should live

Recommendation: a **dedicated project org `glanceterm`**, with the maintainer's
**personal account as the visible lead**. Rationale and the personal-vs-company
trade-off are in the chat thread / decision note below; short version:

- A project-named org (`github.com/glanceterm/glanceterm`) reads as a real
  project with its own identity, supports multiple maintainers, and is
  future-proof for a team / monetization — without the cold "corporate" feel of
  launching under the company org (`souplin`).
- The maintainer stays the human face (indie-maker narrative), which is what
  actually drives early-stage attractiveness for a devtool.
- Avoid launching under the company brand (`souplin/glanceterm`): it ties the
  project's fate to a B2B company name and is messier to spin out later.

## A note on the internal docs

Two files are maintainer-internal planning/runbook docs, not user documentation:
this checklist (`docs/open-source-checklist.md`) and the dogfood guide
(`docs/mobile-bridge-dogfood.md`). They're harmless now that they're scrubbed,
but if you'd rather not publish planning docs at all, `.gitignore` them (or move
them under a `internal/` dir that's gitignored) before the first public push.

## Definition of done

Release is unblocked when every 🔴 box is checked, unit-test CI is green, and a
clean macOS build runs. Everything 🟡 is "do if there's an afternoon"; nothing
🟢 blocks.
