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
- [x] **Stale Tabby translated READMEs deleted (2026-06-12).** `git rm`'d all 10
      `README.<lang>.md` (de/es/id/it/ja/ko/pl/pt/ru/zh-CN) — they described
      *Tabby*, carried its ko-fi button and GA tracking beacon. Shipping
      English-only for v1; a hand-written `README.zh-CN.md` can follow (see the
      bilingual section below).

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

- [x] **Telemetry — already disabled (earlier "Firebase analytics" note was
      wrong).** Re-audited 2026-06-12: the app does **not** wire Firebase. Upstream
      Tabby used Mixpanel; the fork already made `homeBase.service.ts`
      `enableAnalytics()` a **no-op** and dropped the constructor auto-fire, so no
      telemetry runs and no analytics key is committed. Nothing to disclose or
      replace today. If a telemetry backend is added later: default it OFF and add
      a PRIVACY.md. The only "firebase" file is `firebase.json` (docs hosting) —
      see the CI section.
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

## README + bilingual (中文/English)

Current state (audited 2026-06-12):
- `README.md` is GlanceTerm's own — well-written, honest, links the feature
  matrix. ✅ Keep as the canonical English entry point.
- `README.<lang>.md` (de/es/ja/ko/zh-CN/ru/…, ~60 KB each) are **Tabby's**
  translated READMEs, not ours. They describe the wrong app AND embed Tabby's
  GA tracking beacon (`ga-beacon…UA-3278102-18` in ru/ko) and ko-fi donate
  button. **Delete all of them** for v1 — shipping them misattributes the app
  and pings Tabby's analytics on every README view.

Bilingual plan (the lightweight convention, no tooling needed):
- [x] `git rm README.{de-DE,es-ES,id-ID,it-IT,ja-JP,ko-KR,pl-PL,pt-BR,ru-RU,zh-CN}.md`
      — done 2026-06-12 (these were Tabby's, not translations of *our* README).
- [ ] Keep `README.md` (English) as canonical.
- [ ] Author `README.zh-CN.md` as a real translation of OUR README (the
      glance pitch, the ASCII demo, the agent-support summary, install/build).
- [ ] Add a language-switcher line at the very top of BOTH files, e.g.
      `English | [简体中文](README.zh-CN.md)` and the mirror. GitHub renders the
      repo root `README.md` by default; the link is the whole "support" mechanism.
- [ ] Don't auto-generate or machine-translate and forget it — a stale second
      README is worse than none. Treat zh-CN as hand-maintained, English as
      source of truth, and only translate the stable top sections.

## main branch protection (PRs open to all, merge needs your approval)

**Status (audited 2026-06-12 via `gh`): NOT set, and currently BLOCKED.** The
repo is **private** on a **free plan**, and GitHub returns 403 "Upgrade to
GitHub Pro or make this repository public" for both branch protection AND
rulesets. So this cannot be configured now — it **unlocks for free the moment
the repo is made public.** Treat the whole section below as a "day you flip to
public" task, not a pending item. (Dependabot vulnerability alerts are also
OFF; `security_and_analysis` is empty — see the going-public security list.)

This is exactly GitHub's default "require review" model. On
`github.com/<org>/glanceterm` → Settings → **Rules → Rulesets** (or the older
Branch protection rules) targeting `main`:
- [ ] **Require a pull request before merging** + **Require approvals: 1**.
      Since you're the sole maintainer, you are the approver — nobody (including
      outside contributors) can merge without your ✅.
- [ ] **Require status checks to pass** so a red CI can't be merged. NOTE: the
      `Package-Build` workflow was deleted 2026-06-12 (see CI section) — until a
      new build/test workflow is added, the only check to select is
      `codeql-analysis`. Add the plugin unit tests as a CI check when you re-add
      build.
- [ ] **Require branches to be up to date before merging** (optional, avoids
      merge-skew breakage).
- [ ] **Do not allow bypassing the above settings** — OR leave yourself a bypass
      so you can hotfix; your call. For a solo maintainer, allowing your own
      bypass is pragmatic.
- [ ] **Restrict who can push to matching branches**: keep `main` push-protected
      so even you go through PRs by habit (optional but tidy).
- [ ] Fork PRs: GitHub already requires maintainer approval to RUN workflows on
      first-time-contributor PRs — good default, leave on.

Net effect = anyone can fork + open a PR; only your approval merges to `main`.
Exactly what you asked for. No extra tooling.

## CI — NONE (deliberate: no CI budget for now); builds are local

**Decision (2026-06-12): ALL GitHub Actions workflows were DELETED.** No CI
budget at this stage, so there is no automated build/test/release. Builds are
done **locally on the maintainer's Mac** via `npm run dmg:mac` (see root
`CLAUDE.md` — the only correct packaging command), and releases are uploaded by
hand.

Deleted: `build.yml` (Package-Build, 3-platform packaging), `release.yml`
(tagged-release draft), `codeql-analysis.yml` (security scan), `docs.yml`
(Tabby `tabby-docs` Firebase deploy). `.github/workflows/` is now empty.

Still present (config, NOT Actions workflows, no CI cost — leave or prune):
- `.github/dependabot.yml` — will keep opening dependency-bump PRs. With no CI
  they can't be auto-checked; harmless but noisy. Disable if the PR noise is
  unwanted.
- `.github/stale.yml` — stale-bot config (a GitHub App, not Actions). Fine.

Consequences to reconcile before a public release:
- [x] ⚠️ **README CI-installer overclaim fixed (2026-06-12).** README.md +
      README.zh-CN.md no longer say `.AppImage`/`.deb`/`.rpm`/`.exe` are "produced
      by CI"; the Linux/Windows install section now states no prebuilt installers
      are provided yet (no CI), only local macOS `.dmg`, and points to build-from-
      source. Re-add the installer claim if/when CI is restored.
- [ ] **Branch-protection "require status checks"** has nothing to select now
      (no workflows). Skip that rule until the workflow below is added.

**Plan / decision (2026-06-12): add the CI workflow AFTER open-sourcing, not
before.** The "no budget" concern that drove deleting the workflows does **not**
apply once the repo is public: GitHub-hosted **standard runners are free for
public repositories — including macOS**, so a full 3-platform build costs **$0**
(researched 2026-06-12; only *larger*/GPU runners and self-hosted runners are
billed). Private-repo cost would be ~$2–3 per 3-platform build, almost all from
macOS ($0.062/min vs Linux $0.006). Self-hosted runners are no longer free
either (GitHub began billing them March 2026), so for a public repo the free
GitHub-hosted runners are the cheapest path.

- [ ] 🟢 **After the repo is public**, add a clean build/test workflow: plugin
      unit tests on PRs, plus a `v*`-tag job that builds mac/win/linux via
      `electron-builder` (macOS uses `npm run dmg:mac`) and drafts a release.
      Free on a public repo. Until then, builds are local macOS-only and the
      README reflects that.

---

## Other open-source necessities (quick scan)

Already present (inherited from Tabby, verified): `LICENSE` (MIT, dual
copyright Tabby 2017 + Jesse Ma 2026 ✅), `NOTICE` (clear fork attribution +
modification list, tracks Tabby v1.0.234 ✅), `CODE_OF_CONDUCT.md`,
`CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/`, `dependabot.yml`, `stale.yml`.

Still to do / verify:
- [ ] **`CONTRIBUTING.md`** — confirm it describes GlanceTerm's flow (build with
      `npm run dmg:mac`, PR-to-`main`, run the plugin tests), not Tabby's Weblate /
      upstream process.
- [ ] **`.github/FUNDING.yml`** — audit: must not point at Tabby's/Eugeny's
      sponsor accounts. Set to your own or delete.
- [ ] **`.github/ISSUE_TEMPLATE/`** — they currently say "Tabby"; reword to
      GlanceTerm, drop fields that don't apply.
- [x] **PR template** — added `.github/PULL_REQUEST_TEMPLATE.md` (2026-06-12):
      what/why, how-to-test (platform + agent), build/test/matrix checklist.
- [x] **SECURITY.md** — added (2026-06-12): private vulnerability reporting via
      the GitHub Security tab, fork-scope note. **Action still needed:** enable
      "Private vulnerability reporting" in repo Settings → Security so the
      "Report a vulnerability" button exists.
- [ ] **Repo metadata** — description, topics (`terminal`, `ai-agents`,
      `claude-code`, `electron`), and a social-preview image in repo Settings.
- [ ] **`CHANGELOG.md`** — `release.yml` uses `generate_release_notes: true`, so
      autogenerated notes cover v1; a hand-curated CHANGELOG is optional.
- [ ] **Demo GIF** at the top of the README (highest-leverage launch asset —
      also tracked in 🟡 above).
- [ ] **First tag + draft release dry-run**: push a `v0.2.0-rc` tag to a private
      copy (or accept the draft is draft-only) and confirm all three platform
      assets attach before announcing.

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

---

# Change Audit Log

Running ledger of every deliberate change, for later audit. Newest session on
top. Each entry records **what / where (file:line) / why / verification / review**
so a future auditor can reconstruct intent without re-reading the whole diff.
Line numbers are accurate as of the entry date and may drift — the anchor text
in each entry is the durable locator.

## Session 2026-06-12 — token display fix, tooltip latency, hook notice, OSS prep

Status legend: ✅ verified · 🔬 reviewed (adversarial) · 📝 docs only · ⬜ pending

| ID | Area | Files | Status |
|----|------|-------|--------|
| CL-01 | Tooltip shows instantly | `sidebar.component.ts` | ✅ 🔬 |
| CL-02 | Token display format `in:/out:` | `sidebar.component.ts` | ✅ 🔬 |
| CL-03 | Token count includes cache (correctness fix) | `usage-tracker.service.ts`, `sidebar.component.ts`, `usage-tracker.test.ts` | ✅ 🔬 |
| CL-04 | `fmtTokens` rounding-boundary fix | `sidebar.component.ts` | ✅ 🔬 |
| CL-05 | Feature-matrix row synced to CL-02/03 | `docs/feature-matrix.md` | 📝 |
| CL-06 | Hook-install one-shot notice | `hook-installer.service.ts` | ✅ |
| CL-07 | Open-source prep cleanup | many (see entry) | ✅ 📝 |

### CL-01 — Action-toolbar tooltips show immediately (no 750 ms delay)

- **What:** Added `[openDelay]="0"` to the four bottom-toolbar buttons.
- **Where:** `tabby-plugin-ai-sidebar/src/sidebar.component.ts`
  - L204 screenshot main button (`[ngbTooltip]="screenshotTitle()"`)
  - L227 screenshot-options caret (`ngbTooltip="Screenshot options"`)
  - L257 split button (`[ngbTooltip]="splitTitle()"`)
  - L279 settings button (`ngbTooltip="Settings"`)
- **Why:** Global `ngbTooltipConfig.openDelay = 750` in `tabby-core/src/index.ts:206`
  delayed *every* tooltip by 0.75 s. Override to instant on just these buttons
  rather than changing the global (which affects the whole app).
- **Verification:** Reviewer confirmed `openDelay` is a valid `NgbTooltip` @Input
  (ng-bootstrap 14.2.0), that `+this.openDelay` coercion makes `0` win over the
  global config, and that hide (`closeDelay`) is untouched.
- **Review:** 🔬 adversarial reviewer — APPROVE, no issues.

### CL-02 — Token usage rendered as `in: 200k, out: 1.2m`

- **What:** Merged the two `<span class="usage">` (`X in` / `Y out`) into one
  chip `in: {{ fmtTokens(s.tokensIn) }}, out: {{ fmtTokens(s.tokensOut) }}`;
  lowercased the millions suffix `M`→`m` in `fmtTokens`.
- **Where:** `sidebar.component.ts` L147 (template span), L2117 (`fmtTokens` `m`),
  L811 (CSS comment updated to new format).
- **Why:** User-requested format change for readability.
- **Verification:** `*ngIf="s.tokensIn || s.tokensOut"` semantics preserved
  (hidden when both 0/null); `.usage` flex layout intact (reviewer checked).
- **Review:** 🔬 APPROVE.

### CL-03 — Token input count now includes cache (correctness bug fix)

- **What:** Input total changed from `input_tokens` only to
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
- **Where:**
  - `usage-tracker.service.ts` L168–169 (the two new `inTok +=` lines in
    `sumClaudeAssistantUsage`); class doc L13–14 and function doc L143–147 updated.
  - `sidebar.component.ts` L2122 — hover text `(cache excluded)` →
    `(input includes cache read/creation)`.
  - `__tests__/usage-tracker.test.ts` L8/L10 (`asst()` helper gained
    `cacheCreate`), L24/L28 (test flipped from "EXCLUDES" to "INCLUDES",
    asserts `inTok: 9_000_600`).
- **Why:** For a Claude agent the whole context is re-read from cache every turn,
  so cache-read is the bulk of real input. Counting only `input_tokens` produced
  the abnormal `in ≪ out` display the user reported. Proven on a real transcript:
  old algo `in 12.6k / out 30.6k`; fixed `in 1.9m / out 30.6k`. The three input
  fields are mutually exclusive (no double-count). Matches Anthropic console /
  `/cost` input semantics.
- **Verification:** ✅ 11/11 usage-tracker tests pass; real-transcript check.
- **Review:** 🔬 reviewer confirmed no double-count, incremental-read path
  unchanged, field-type guards complete.

### CL-04 — `fmtTokens` rounding boundaries no longer spill magnitude

- **What:** Thresholds moved just below the round boundary: `< 1_000_000` →
  `< 999_500`, and decimal cutoff `< 10_000` → `< 9_950`. Docstring `M`→`m`.
- **Where:** `sidebar.component.ts` L2116 (and docstring above `fmtTokens`).
- **Why:** Pre-existing cosmetic glitch surfaced by reviewer: `999_999` rendered
  `1000k` (should be `1.0m`), `9999` rendered `10.0k`. Now `1.0m` / `10k`.
- **Verification:** ✅ boundary table checked via node (`null,0,999,1000,9949,
  9950,9999,10000,200000,999499,999500,999999,1000000,1200000`).
- **Review:** 🔬 flagged by reviewer as the boundary to fix; fix verified.

### CL-05 — Feature matrix row 35 synced to CL-02/CL-03

- **What:** `Session token usage shown` row label `↑in ↓out, k/M` → `in: … out: …,
  k/m`; Claude cell `cache excluded` → `input includes cache read/creation`.
- **Where:** `docs/feature-matrix.md:35`.
- **Why:** MEMORY designates this file authoritative for "does X agent support Y";
  the stale claim would have propagated. Caught by reviewer.
- **Review:** 📝 docs.

### CL-06 — One-shot notice when hooks are installed at runtime

- **What:** `HookInstallerService` now injects `NotificationsService`; `tryInstall`
  returns `InstallReport | null`; `installFor` shows a toast only when fresh hooks
  were written (`report?.installed === true`).
- **Where:** `hook-installer.service.ts` L2 (import), L10 (`InstallReport` type),
  L43 (DI), L85–91 (toast in `installFor`), L93 (`tryInstall` signature →
  `Promise<InstallReport | null>`).
- **Why:** "Installed GlanceTerm first, then the agent, then ran it without
  relaunching" is the one ordering with a rough edge: the in-flight agent session
  started before hooks existed and won't emit events until restart. The notice
  ("正在运行的会话需重开后才会加载 hook") explains the otherwise-mysterious first
  "no status" session. Fires ONLY on the runtime path (`installFor`), never at
  boot (`installAll` ignores the return), and is naturally one-shot
  (`installTriggered` Set + `installed:false` on re-fire).
- **Verification:** ✅ `tsc --noEmit` 0 errors; full plugin suite 243/243 pass.
- **Review:** ⬜ not separately reviewed (offered).

### CL-07 — Open-source preparation cleanup (de-Tabby + scaffolding)

- **Deletions** (`git rm`):
  - 10 Tabby translated READMEs: `README.{de-DE,es-ES,id-ID,it-IT,ja-JP,ko-KR,
    pl-PL,pt-BR,ru-RU,zh-CN}.md` — described Tabby, carried its ko-fi button and a
    GA tracking beacon (`UA-3278102-18`).
  - `.github/workflows/docs.yml` + `firebase.json` — deployed to Tabby's
    `tabby-docs` Firebase project on every push with a secret we don't have
    (red-X every commit).
- **Edit:** `.github/workflows/build.yml` — removed the
  `Upload packages to packagecloud.io` step (pushed Linux packages to the
  `eugeny/tabby` packagecloud repo on tag push); replaced with an explanatory
  comment. Platform artifacts still upload via `actions/upload-artifact` for
  `release.yml`. YAML re-validated.
- **New files:**
  - `SECURITY.md` — private vuln reporting via GitHub Security tab; fork-scope note.
  - `.github/PULL_REQUEST_TEMPLATE.md` — what/why, how-to-test (platform+agent),
    build/test/matrix checklist.
- **Docs:** `docs/open-source-checklist.md` — corrected the stale "app wires
  Firebase analytics" item (telemetry is a no-op; upstream used Mixpanel, not
  Firebase), added README-bilingual / branch-protection / CI / other-OSS
  sections, and checked off the executed items.
- **Why:** First-time open-source readiness — remove Tabby-specific attribution
  leaks and CI that targets Tabby's infra; add expected community scaffolding.
- **Status:** ✅ executed (staged, **not committed**). Verification: workflows no
  longer contain real `eugeny/tabby` / `tabby-docs` / firebase references (only an
  explanatory comment).
- **Not done in code (require GitHub web settings):** main branch protection
  (require PR + 1 approval + status checks), enable Private vulnerability
  reporting, repo description/topics/social-preview, audit `FUNDING.yml` +
  ISSUE_TEMPLATE for residual "Tabby"/Eugeny references.

### CL-08 — OSS scrub round 2: FUNDING, ISSUE templates, build CI, zh-CN README

- **What / where:**
  - **Deleted `.github/FUNDING.yml`** — it pointed the repo's Sponsor button
    entirely at Tabby's author (`github: eugeny`, `open_collective: tabby`,
    `ko_fi: eugeny`), i.e. sponsor money would flow to upstream. Removed (user
    chose delete over repointing).
  - **Deleted `.github/workflows/build.yml`** — inherited Tabby multi-platform
    packaging + signing pipeline. User decision: remove now, add our own clean
    one later. ⚠️ `release.yml` depends on it (`workflow_run: ["Package-Build"]`)
    and is now **dormant**; `codeql-analysis.yml` unaffected.
  - **De-Tabby'd ISSUE templates:** `feature_request.md:14` and
    `issue-report.md:14-15` pointed at `Eugeny/tabby/issues` + "latest Tabby
    version" → repointed to `jessemaxh/glanceterm` issues/releases.
  - **`README.md`** — added language switcher `**English** | [简体中文](README.zh-CN.md)`
    under the title.
  - **New `README.zh-CN.md`** — faithful hand translation of OUR README (not
    Tabby's). Code blocks / commands / the directory tree / ASCII diagram kept
    verbatim (English is source of truth); prose translated. Switcher mirrored.
  - **`docs/open-source-checklist.md`** — CI section rewritten (build.yml
    deleted, release.yml dormant), branch-protection status-check note updated.
- **Why:** Continue first-time OSS scrub — stop misdirecting sponsorship, remove
  Tabby-targeted CI, give Chinese users a real README, fix issue-template links.
- **Verification:** `git rm` confirmed for FUNDING.yml + build.yml; no real
  `eugeny`/`tabby` refs remain in `.github/` except intentional attribution.
- **Known follow-up:** README still claims CI-built Linux/Windows installers —
  untrue until build CI is re-added (flagged in the CI section). Review: ⬜.

### CL-09 — Delete all CI workflows (no CI budget) + analytics research

- **What / where:**
  - **`git rm` `.github/workflows/codeql-analysis.yml` + `release.yml`** — together
    with build.yml/docs.yml (CL-07/CL-08) this empties `.github/workflows/`.
    Decision: **no CI budget for now**; builds are local (`npm run dmg:mac`),
    releases uploaded by hand.
  - `.github/dependabot.yml` + `stale.yml` kept (config, not Actions; no CI cost).
  - `docs/open-source-checklist.md` CI section rewritten to "CI — NONE
    (deliberate)".
- **Analytics research (2026-06-12) — verdict: do NOT add Firebase; ship v1 with
  no telemetry.** Grounding:
  - Firebase Analytics is **not officially supported on Electron** (web/Apple/
    Android/Flutter only); the web SDK's analytics assumes a browser context and
    gives poor desktop data + a Google dependency privacy-sensitive OSS users
    dislike. Wrong tool.
  - OSS dev-tool norm (Go telemetry backlash, GitHub CLI): **opt-in is the only
    ethical default**; default-on telemetry erodes trust. This app touches
    sensitive data (cwd, agent activity) — extra reason to stay clean.
  - The fork already removed Tabby's Mixpanel; re-adding phone-home reverses the
    just-completed scrub. Community (issues/PRs) is the v1 validation channel.
  - **If/when usage signal is wanted later:** use **Aptabase** (open-source,
    privacy-first, official `aptabase-electron` SDK, anonymous — no MAU/retention)
    or PostHog (heavier, user-level); make it **opt-in** + `DO_NOT_TRACK` +
    disclosed in a PRIVACY.md; **never collect content** (no command text, paths,
    or agent output). NOT Firebase.
- **Why:** User has no CI budget now; user asked whether Firebase analytics is
  needed.
- **Review:** 📝 decision/docs.

### CL-10 — Repo security audit (branch protection, secrets, git history)

- **What:** Audited the GitHub repo's security posture via `gh` and scanned git
  history for leaked secrets. No file changes — findings only.
- **Findings (2026-06-12):**
  - Repo is **private** on a **free plan**. Branch protection + rulesets are
    **blocked** (HTTP 403 "upgrade to Pro or make public"). They unlock free on
    going public. NOT set today.
  - Dependabot **vulnerability alerts OFF** (404); `security_and_analysis`
    empty (no secret scanning / push protection — those are free only on public
    repos or with Advanced Security).
  - **Git history secret scan: CLEAN.** Token/key signatures (ghp_/AKIA/AIza/
    sk-/xox-/PRIVATE KEY/hardcoded password) over fork paths
    (`tabby-plugin-ai-sidebar`, `app/`, `scripts/`, `.github/`, `extras/`)
    returned nothing. `.env` (which was `git rm --cached`'d earlier) only ever
    held a `CONFIG_DIRECTORY` path — no credential; the one value carrying a
    person's name (`Nathaniel Walser`) is from upstream Tabby's already-public
    history, not a fork addition.
- **Going-public security checklist (all FREE on public repos, do on flip day):**
  - [ ] Branch protection / ruleset on `main`: require PR + 1 approval + block
        force-push + block deletion (+ require status checks once CI exists).
  - [ ] Enable **secret scanning + push protection** (Settings → Security).
  - [ ] Enable **private vulnerability reporting** (makes SECURITY.md's button
        work).
  - [x] Enable **Dependabot alerts** — DONE 2026-06-12 via
        `gh api -X PUT .../vulnerability-alerts` (free on all repos/plans;
        verified 204). Auto-security-fixes still off (`enabled:false`) — optional.
  - [ ] When workflows are added: default `GITHUB_TOKEN` to read-only, require
        approval to run workflows on fork PRs (GitHub default), never use
        self-hosted runners on the public repo.
- **Review:** 📝 audit/decision.

### CL-11 — README presentation polish (header, badges, feature list)

- **What / where:** Gave `README.md` + `README.zh-CN.md` a polished top-of-page:
  centered `app/assets/logo.svg` (GlanceTerm's own logo, verified — not Tabby's),
  HTML-centered title + tagline, a row of **honest static badges** (License MIT,
  platforms, `v0.2 pre-release`, Built on Tabby, PRs welcome — deliberately NO
  build-status/stars badges since there's no CI and 0 stars yet), language
  switcher, and a scannable **"What you get"** feature list (6 bullets, all from
  existing真实 content — no overclaiming).
- **Why:** README content was already solid/honest; it just lacked the visual
  front door that makes a repo read as "a real project." Badges + logo + feature
  bullets are the cheap, honest wins.
- **Verification:** logo confirmed GlanceTerm-branded via Read; `docs/readme.png`
  confirmed to be **Tabby's** old banner (NOT used). Badges are static shields.io
  (no live data to break).
- **Still missing (human / app-run needed, NOT done):**
  - **A real screenshot / demo GIF** of the sidebar in action — the single
    highest-leverage visual. Needs the app running with live agents; can't be
    generated from source. The ASCII sketch stays as a stand-in until then.
  - **Orphan Tabby images** `docs/readme.png`, `docs/readme-terminal.png`,
    `docs/readme-ssh.png`, `docs/hiveterm-*.png`, `docs/kofi.png` are unreferenced
    leftovers — optional delete (not blocking).
- **Review:** 📝 docs/presentation.

### CL-12 — Upgrade vitest 1.6 → 3.2.6 (fix CVE-2026-47429, the 2 "our" criticals)

- **What / where:** Bumped `vitest` `^1.6.0` → `^3.2.6` in both fork plugins and
  regenerated their lockfiles:
  - `tabby-plugin-ai-sidebar/package.json` + `yarn.lock` + `package-lock.json`
    (the latter synced via `npm install --package-lock-only` — this plugin has
    both lockfiles).
  - `tabby-plugin-mobile-bridge/package.json` + `yarn.lock`.
- **Why:** Of the 14 critical Dependabot alerts, exactly 2 were "ours" — both
  CVE-2026-47429 in `vitest` (a dev-only test runner) in the two fork-added
  plugins. CVE patched only in 3.2.6 (no 1.x/2.x fix), so a major bump was
  required. The other 12 criticals are inherited Tabby transitive deps
  (root/web/app `yarn.lock`) — left for a separate pass / Dependabot.
- **Verification:** ✅ Major-version jump caused NO breakage — configs use only
  1→3-stable APIs (`include`/`environment`/`pool`/`poolOptions`/`reporters`).
  ai-sidebar **243/243** pass; mobile-bridge **26/26** pass under vitest 3.2.6.
  All manifests + node_modules confirmed on 3.2.6.
- **Note:** `tabby-plugin-ai-sidebar` carries BOTH `yarn.lock` and
  `package-lock.json` (pre-existing dual-lock anti-pattern). Both were synced to
  3.2.6; consider removing one (repo is yarn-based) as a separate cleanup.
- **Review:** ✅ tests green.

### CL-13 — Process-tree chips restyled to designer spec (clearer)

- **What / where:** `sidebar.component.ts` — the `.conc` process-tree chips
  (agents / shells·bgs / monitors on line3) were plain dim text; restyled to
  legible pills per a designer handoff.
  - New tokens in `:host` (L444-445): `--gt-proc: #45CFE0`,
    `--gt-proc-bg: rgba(69,207,224,0.13)` (dark). Light-theme values
    (`#0E8FA3` / `rgba(14,143,163,0.12)`) documented in a comment, to wire up
    when the deferred sidebar light theme lands.
  - `.conc` CSS (L857+): each chip is now a pill — `var(--gt-mono)` 10px,
    color `--gt-proc` on `--gt-proc-bg`, padding `1.5px 6px`, radius `5px`,
    inter-chip `gap: 6px`; number `<b>` weight 700 + `margin-right: 3px`, label
    weight 600. Exact values from the spec.
- **Why:** User feedback — the shell/agent status counts were hard to read as
  flat dim text; the cyan-tinted pill makes them clear without competing with
  the status rail.
- **Verification:** `tsc --noEmit` 0 errors. Visual: pending a rebuild/reload
  (CSS lives in a template string; not covered by unit tests).
- **Note:** screenshot mockup shows pluralized "shells/bgs"; current `bgLabel()`
  returns singular — separate from this styling change, left as-is.
- **Review:** ⬜ visual check pending.

### CL-14 — feature-matrix: add platform (macOS/Linux/Windows) support section

- **What / where:** `docs/feature-matrix.md` — added a "Platform support" section
  before "Dropped agents". The existing matrix is agent-dimensioned and
  implicitly macOS; the new section adds the OS dimension: a capability × OS
  table (✅/🧪/❌), a test-first risk order, and the 🧪→✅ validation procedure.
- **Why:** User asked whether features actually work when built on Linux/Windows.
  Answer (from a 2026-06-12 code audit): the win/linux code paths EXIST
  (`/proc` reads, PowerShell process detection, a full `HANDLER_PS1`) but have
  NEVER been run — so "compiles + probably works, unproven." The matrix is the
  authoritative doc (per MEMORY) and lacked the platform view; now it has one.
- **Highest-risk cell flagged:** the Windows PowerShell hook handler.
- **Verification:** reused the existing legend; no code change.
- **Review:** 📝 docs.

### Pre-existing uncommitted changes NOT from this session

For audit completeness — these were already modified/untracked in the working
tree before this session and were **not** touched here:
`tab-monitor.ts`, `ai-config-provider.ts`, `ai-hotkey-provider.ts`,
`auto-resume.service.ts`, `index.ts`, `screenshot/overlay/overlay-source.ts`
(modified); `docs/sidebar-design-brief.md`, `ai-hotkey-actions.service.ts`
(untracked).
