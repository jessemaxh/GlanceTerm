import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { AutoResumeHarness, makeTabState } from './auto-resume-harness'

/**
 * Integration tests for AutoResumeService — the CAPTURE / CLEANUP / REPLAY
 * state machine and its two recently-fixed regressions:
 *
 *   Bug 1 — focus-gated REPLAY: a restored tab whose cwd lands BEFORE the
 *           user actually looks at it must not auto-launch the agent.
 *           Only `app.activeTab` (seeded at construction) and tabs that
 *           subsequently fire `activeTabChange$` are eligible.
 *   Bug 2 — per-cwd quota: persisted entries now carry `{ command, count }`.
 *           When N restored tabs share a cwd whose count is K < N, only
 *           the first K focused tabs get the replay; the rest are silently
 *           skipped (used to be all-N — the "3 tabs share /repo, only 1
 *           had claude" surprise).
 *
 * Pure-function coverage (parsePersistedEntry, isShellSafe, toRunnableCommand)
 * lives next door in auto-resume.test.ts. This file exercises the live
 * service via the harness so the state machine and side effects are what's
 * actually tested.
 *
 * Fake timers: scheduleResume waits 2 s before sendInput; tests opt in
 * to `vi.useFakeTimers()` so the resume fires on demand via
 * `harness.advance(2000)`.
 */
describe('AutoResumeService — integration', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    // ── CAPTURE ────────────────────────────────────────────────────────────

    describe('CAPTURE', () => {
        it('persists { command, count: 1 } when one tab has an agent', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: '/usr/local/bin/claude --resume foo',
            })])
            // Flush the queued setPersisted microtask. The state machine
            // calls config.save() async; awaiting Promise.resolve gives the
            // pending then-handlers a chance to run.
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({
                '/repo': { command: 'claude --resume foo', count: 1 },
            })
        })

        it('counts distinct tabs at the same cwd', async () => {
            // The Bug-2 capture half: with 3 tabs each running claude at
            // /repo, the persisted count should be 3, not 1. Pre-fix
            // there was no count at all and the next-launch replay
            // surface couldn't tell this case from the one-tab case.
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            const b = h.addTab()
            const c = h.addTab()
            h.emitTick([
                makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
                makeTabState(b, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
                makeTabState(c, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
            ])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({
                '/repo': { command: 'claude', count: 3 },
            })
        })

        it('does NOT double-count the same tab across ticks', async () => {
            // Same tab observed in 5 successive ticks still represents
            // one agent. Without the WeakSet identity check we'd inflate
            // count on every poll.
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            for (let i = 0; i < 5; i++) {
                h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' })])
            }
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({
                '/repo': { command: 'claude', count: 1 },
            })
        })

        it('does not persist a shell-unsafe command that survives reduction', async () => {
            // The shell-safety gate runs on the REDUCED command —
            // toRunnableCommand strips down to the bare-tool fallback
            // for unrecognised cmdline shapes, which sanitises the
            // degenerate "claude; rm -rf /" form away to safe "claude".
            // The realistic attack vector is one where the malicious
            // argv DOES survive reduction: a process whose argv[0]
            // basename is exactly `claude` with the payload in argv[1+].
            // That's what gets persisted-and-replayed verbatim pre-fix,
            // and what the safety gate must catch.
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: 'claude \'; rm -rf ~ #\'',
            })])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({})
        })

        it('persists the bare-tool fallback for cmdlines toRunnableCommand cannot parse', async () => {
            // Documents the lossy behaviour: an exotic cmdline that
            // doesn't surface a token matching the tool name falls
            // through to just the bare tool. The bare tool is shell-safe
            // by construction, so the persist DOES happen — losing the
            // user's flags but giving them a working `claude` on next
            // launch. This isn't a security bug (bare `claude` is
            // exactly what `claude` would run) but pinning it here so a
            // future change that toughens the sanitiser surfaces in
            // review instead of silently losing legit cases.
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: 'claude; rm -rf /',
            })])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({
                '/repo': { command: 'claude', count: 1 },
            })
        })

        it('is a no-op when the master toggle is off', async () => {
            const h = new AutoResumeHarness({ autoResumeAgents: false })
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' })])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({})
            expect(h.config.saveCount).toBe(0)
        })

        it('rebalances when the same tab moves cwd', async () => {
            // Defensive path: an agent that survived a `cd` (rare —
            // agents are foreground programs). Old cwd should drop the
            // tab and have its count decremented; new cwd picks it up.
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/old', aiCommandLine: 'claude' })])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({ '/old': { command: 'claude', count: 1 } })

            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/new', aiCommandLine: 'claude' })])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({ '/new': { command: 'claude', count: 1 } })
        })
    })

    // ── CLEANUP ────────────────────────────────────────────────────────────

    describe('CLEANUP', () => {
        it('decrements count when one of N tabs quits the agent', async () => {
            // The Bug-2 cleanup half: with 3 tabs running claude, the
            // user quitting one (typing `exit`) should drop count to 2,
            // not delete the entry outright.
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            const b = h.addTab()
            const c = h.addTab()
            h.emitTick([
                makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
                makeTabState(b, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
                makeTabState(c, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
            ])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({ '/repo': { command: 'claude', count: 3 } })

            // tab b's user types `exit`. claude is gone but the shell is alive.
            h.emitTick([
                makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
                makeTabState(b, { cwd: '/repo' }),
                makeTabState(c, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
            ])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({ '/repo': { command: 'claude', count: 2 } })
        })

        it('deletes the entry when the last agent in a cwd exits', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' })])
            await Promise.resolve()
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({})
        })

        it('does not delete on bare-shell tick before any agent was seen', async () => {
            // The cleanup gate must require hadAgentThisSession — a
            // tab that was always agent-less should never wipe an
            // entry. Regression check from the pre-rewrite code.
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 1 } },
            })
            h.start()
            const a = h.addTab({ restored: 'preexisting' })
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({ '/repo': { command: 'claude', count: 1 } })
        })
    })

    // ── REPLAY: focus gate (Bug 1) ─────────────────────────────────────────

    describe('REPLAY — focus gate (Bug 1)', () => {
        it('auto-resumes all restored tabs at startup via the warm-up dance', async () => {
            // Updated semantics (2026-06-07): the user-visible expectation
            // is that EVERY restored tab gets its agent back at app start,
            // not just the one the user focuses first. The service satisfies
            // that by synthesising a focus+blur pair on each non-active
            // restored tab after WARMUP_DELAY_MS (250 ms), which in
            // production triggers Tabby's lazy `frontend.attach` and gets
            // each session running in parallel. The harness drives the
            // same code path; `emitFocused` on the FakeTab throws (no
            // method) and is swallowed, but the synthetic focus event
            // already added the tab to `focusedOuterTabs` and re-fired
            // `onStates`, so the persisted-snapshot REPLAY schedules for
            // each tab without waiting for an explicit `focus()` call.
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 3 } },
            })
            const preexisting = [{ title: 'a' }, { title: 'b' }, { title: 'c' }]
            for (const t of preexisting) h.app.tabs.push({
                id: t.title,
                sentInputs: [],
                customTitle: null,
                title: t.title,
                sendInput (s: string) { this.sentInputs.push(s) },
                emitFocused () { /* no-op — see FakeTab docstring */ },
                emitBlurred () { /* no-op — see FakeTab docstring */ },
            } as any)
            h.start()
            const [a, b, c] = h.app.tabs
            h.emitTick([
                makeTabState(a, { cwd: '/repo' }),
                makeTabState(b, { cwd: '/repo' }),
                makeTabState(c, { cwd: '/repo' }),
            ])
            // 250 ms warm-up + 2 s resume delay = 2250 ms; 3 s flushes all
            // three with margin to spare. Pre-warmup this test expected
            // all empty, blocked on a user focus per tab; the new
            // behaviour is exactly the user's request.
            h.advance(3000)
            expect(a.sentInputs).toEqual(['claude\r'])
            expect(b.sentInputs).toEqual(['claude\r'])
            expect(c.sentInputs).toEqual(['claude\r'])
        })

        it('skips warm-up when the master switch is off', async () => {
            // ai.autoResumeAgents = false short-circuits both CAPTURE and
            // REPLAY; the warm-up path must honour the same flag, otherwise
            // disabling the feature would still kick sessions awake on
            // every restart (audible/visible noise + pty spawn storm for
            // users who explicitly opted out).
            const h = new AutoResumeHarness({
                autoResumeAgents: false,
                persisted: { '/repo': { command: 'claude', count: 3 } },
            })
            const a = h.addTab({ restored: 'preexisting' })
            const b = h.addTab({ restored: 'preexisting' })
            h.start()
            h.emitTick([
                makeTabState(a, { cwd: '/repo' }),
                makeTabState(b, { cwd: '/repo' }),
            ])
            h.advance(3000)
            expect(a.sentInputs).toEqual([])
            expect(b.sentInputs).toEqual([])
        })

        it('seeds the originally-active tab so it replays immediately', async () => {
            // The auto-focus of the restored active tab fires BEFORE the
            // service subscribes to activeTabChange$, so we MUST seed
            // focusedOuterTabs from app.activeTab at construction —
            // otherwise the most important tab (the one the user was
            // working in) would never auto-resume.
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude --resume foo', count: 1 } },
            })
            const a = h.addTab({ restored: 'preexisting', active: true })
            h.start()
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            h.advance(2000)
            expect(a.sentInputs).toEqual(['claude --resume foo\r'])
        })

        it('replays when a previously-unfocused tab gains focus', async () => {
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 1 } },
            })
            const a = h.addTab({ restored: 'preexisting' })
            h.start()
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            h.advance(2000)
            expect(a.sentInputs).toEqual([])

            h.focus(a)
            // Focus triggers an immediate re-tick from monitor.current, so
            // the replay schedule lands without waiting for the next 1.5 s
            // poll. Tests don't have to emit again.
            h.advance(2000)
            expect(a.sentInputs).toEqual(['claude\r'])
        })

        it('does not surprise-launch a tab the user opens after startup', async () => {
            // tabOpened$ outside RESTORED_CAPTURE_MS → not in
            // restoredOuterTabs → no replay even at a matching cwd.
            // This is independent of the focus gate; pinning the
            // restored-tab gate so a focus-gate-only future refactor
            // still keeps user-opened tabs safe.
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 1 } },
            })
            h.start()
            // Advance past the 30 s capture window before opening.
            vi.advanceTimersByTime(31_000)
            const a = h.addTab({ restored: 'opened' })
            h.focus(a)
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            h.advance(2000)
            expect(a.sentInputs).toEqual([])
        })
    })

    // ── REPLAY: per-cwd quota (Bug 2) ─────────────────────────────────────

    describe('REPLAY — per-cwd quota (Bug 2)', () => {
        it('respects count=1: only the first focused tab replays', async () => {
            // The exact bug the user reported. Three restored tabs at
            // /repo, persisted count=1 (only one had claude last time).
            // Each tab gets focused in order; only the first should
            // receive `claude\r`.
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 1 } },
            })
            const tabs = [
                h.addTab({ restored: 'preexisting' }),
                h.addTab({ restored: 'preexisting' }),
                h.addTab({ restored: 'preexisting' }),
            ]
            h.start()

            h.focus(tabs[0])
            h.emitTick(tabs.map(t => makeTabState(t, { cwd: '/repo' })))
            h.advance(2000)
            expect(tabs[0].sentInputs).toEqual(['claude\r'])
            expect(tabs[1].sentInputs).toEqual([])
            expect(tabs[2].sentInputs).toEqual([])

            h.focus(tabs[1])
            h.advance(2000)
            expect(tabs[1].sentInputs).toEqual([])

            h.focus(tabs[2])
            h.advance(2000)
            expect(tabs[2].sentInputs).toEqual([])
        })

        it('replays all N when count matches tab count', async () => {
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 3 } },
            })
            const tabs = [
                h.addTab({ restored: 'preexisting' }),
                h.addTab({ restored: 'preexisting' }),
                h.addTab({ restored: 'preexisting' }),
            ]
            h.start()
            for (const t of tabs) h.focus(t)
            h.emitTick(tabs.map(t => makeTabState(t, { cwd: '/repo' })))
            h.advance(2000)
            expect(tabs[0].sentInputs).toEqual(['claude\r'])
            expect(tabs[1].sentInputs).toEqual(['claude\r'])
            expect(tabs[2].sentInputs).toEqual(['claude\r'])
        })

        it('replays a count=2 across N=3 tabs in focus order', async () => {
            // Quota semantics: first-focused-wins until exhausted.
            // Skipped tabs are marked attempted so they don't keep
            // re-considering every tick.
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 2 } },
            })
            const tabs = [
                h.addTab({ restored: 'preexisting' }),
                h.addTab({ restored: 'preexisting' }),
                h.addTab({ restored: 'preexisting' }),
            ]
            h.start()

            h.focus(tabs[0])
            h.emitTick(tabs.map(t => makeTabState(t, { cwd: '/repo' })))
            h.advance(2000)

            h.focus(tabs[1])
            h.advance(2000)

            h.focus(tabs[2])
            h.advance(2000)

            expect(tabs[0].sentInputs).toEqual(['claude\r'])
            expect(tabs[1].sentInputs).toEqual(['claude\r'])
            expect(tabs[2].sentInputs).toEqual([])
        })

        it('active tab wins contested quota when warmup re-fires onStates', async () => {
            // Bug repro (2026-06-07): persisted /repo has count=1 and
            // three restored tabs share it, with C currently active.
            // The constructor seeds focusedOuterTabs={C}, schedules
            // warmup for all three. At 250 ms warmup(A) and warmup(B)
            // synthetically focus A,B and each re-fire `onStates` on
            // the snapshot. Pre-fix the loop iterated in app.tabs
            // order [A,B,C]: A claimed the single quota slot via
            // warmup(A), then C (already focused via the seed) was
            // marked attempted with no resume — the user's focused
            // tab sat there with no claude while a non-focused
            // sibling got one. Post-fix the active tab is sorted to
            // the front of every onStates pass, so C wins regardless
            // of who got warmed up first.
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 1 } },
            })
            const a = h.addTab({ restored: 'preexisting' })
            const b = h.addTab({ restored: 'preexisting' })
            const c = h.addTab({ restored: 'preexisting', active: true })
            h.start()
            // Pre-populate monitor.current so warmup's re-fire reads
            // a real snapshot. Production sequence: monitor ticks
            // before warmup setTimeouts fire; the harness models that
            // by setting current directly.
            h.monitor.current = [
                makeTabState(a, { cwd: '/repo' }),
                makeTabState(b, { cwd: '/repo' }),
                makeTabState(c, { cwd: '/repo' }),
            ]
            h.advance(250)
            h.advance(2000)
            expect(c.sentInputs).toEqual(['claude\r'])
            expect(a.sentInputs).toEqual([])
            expect(b.sentInputs).toEqual([])
        })

        it('does not replay twice on the same tab across ticks', async () => {
            // attempted WeakSet must hold — a tab that's been considered
            // (replayed or quota-skipped) never re-enters the REPLAY
            // branch.
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'claude', count: 1 } },
            })
            const a = h.addTab({ restored: 'preexisting', active: true })
            h.start()
            for (let i = 0; i < 5; i++) {
                h.emitTick([makeTabState(a, { cwd: '/repo' })])
            }
            h.advance(2000)
            expect(a.sentInputs).toEqual(['claude\r'])
        })
    })

    // ── Persisted format compatibility ─────────────────────────────────────

    describe('persisted format compatibility', () => {
        it('accepts a legacy bare-string entry as count=1', async () => {
            // Pre-fix installs persisted just the command. Reads must
            // still resume one tab; an in-place upgrade to the new
            // shape happens on the next CAPTURE pass at that cwd.
            const h = new AutoResumeHarness({
                persisted: { '/repo': 'claude --resume foo' },
            })
            const a = h.addTab({ restored: 'preexisting', active: true })
            const b = h.addTab({ restored: 'preexisting' })
            h.start()
            h.focus(b)
            h.emitTick([
                makeTabState(a, { cwd: '/repo' }),
                makeTabState(b, { cwd: '/repo' }),
            ])
            h.advance(2000)
            // Legacy string parses as count=1. b is the currently-active
            // tab at emitTick time, so it claims the contested quota slot
            // via the active-tab-first sort in onStates. a being seeded
            // earlier doesn't beat "active right now" — that's the fix
            // for the "non-focused tab recovered, focused tab didn't"
            // race in the warmup path.
            expect(b.sentInputs).toEqual(['claude --resume foo\r'])
            expect(a.sentInputs).toEqual([])
        })

        it('upgrades the shape after a CAPTURE pass', async () => {
            const h = new AutoResumeHarness({
                persisted: { '/repo': 'claude' },
            })
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: 'claude --resume foo',
            })])
            await Promise.resolve()
            expect(h.getPersisted()).toEqual({
                '/repo': { command: 'claude --resume foo', count: 1 },
            })
        })
    })

    // ── End-to-end scenarios ──────────────────────────────────────────────

    describe('end-to-end scenarios', () => {
        it('handles the reported case: 3 tabs share cwd, only 1 had agent', async () => {
            // Tying both bug fixes together with the exact story the
            // user described. Session 1 captures count=1; restart with
            // 3 restored tabs; only the focused one resumes.

            // Session 1: tab A runs claude at /repo, tabs B and C are
            // bare shells at /repo too.
            const session1 = new AutoResumeHarness()
            session1.start()
            const a1 = session1.addTab()
            const b1 = session1.addTab()
            const c1 = session1.addTab()
            session1.emitTick([
                makeTabState(a1, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
                makeTabState(b1, { cwd: '/repo' }),
                makeTabState(c1, { cwd: '/repo' }),
            ])
            await Promise.resolve()
            const persisted = session1.getPersisted()
            expect(persisted).toEqual({ '/repo': { command: 'claude', count: 1 } })

            // Quit & restart. Session 2 boots with the persisted entry.
            // The 3 tabs come back as restored. User focuses tab A (the
            // one that originally had claude); quota=1 means only A
            // resumes.
            const session2 = new AutoResumeHarness({ persisted })
            const a2 = session2.addTab({ restored: 'preexisting', active: true })
            const b2 = session2.addTab({ restored: 'preexisting' })
            const c2 = session2.addTab({ restored: 'preexisting' })
            session2.start()
            session2.emitTick([
                makeTabState(a2, { cwd: '/repo' }),
                makeTabState(b2, { cwd: '/repo' }),
                makeTabState(c2, { cwd: '/repo' }),
            ])
            session2.advance(2000)
            expect(a2.sentInputs).toEqual(['claude\r'])
            expect(b2.sentInputs).toEqual([])
            expect(c2.sentInputs).toEqual([])

            // User then focuses B and C — still no surprise resume.
            session2.focus(b2)
            session2.advance(2000)
            session2.focus(c2)
            session2.advance(2000)
            expect(b2.sentInputs).toEqual([])
            expect(c2.sentInputs).toEqual([])
        })

        it('persists per-tab counts across an exit-and-quit-immediately flow', async () => {
            // Session 1: two tabs each run claude at /repo, user
            // quits the WHOLE app (no exit). Session 2 should resume
            // both (focus permitting).
            const session1 = new AutoResumeHarness()
            session1.start()
            const a1 = session1.addTab()
            const b1 = session1.addTab()
            session1.emitTick([
                makeTabState(a1, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude --r foo' }),
                makeTabState(b1, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude --r bar' }),
            ])
            await Promise.resolve()
            const persisted = session1.getPersisted()
            // The two commands differ (different --resume targets) but
            // the LAST write wins — that's a known limitation of the
            // single-command-per-cwd shape. Count is what matters for
            // Bug 2, command is whatever was captured last.
            expect(persisted).toEqual({ '/repo': { command: 'claude --r bar', count: 2 } })

            const session2 = new AutoResumeHarness({ persisted })
            const a2 = session2.addTab({ restored: 'preexisting', active: true })
            const b2 = session2.addTab({ restored: 'preexisting' })
            session2.start()
            session2.emitTick([
                makeTabState(a2, { cwd: '/repo' }),
                makeTabState(b2, { cwd: '/repo' }),
            ])
            session2.advance(2000)
            // a2 (active+seeded) gets the first slot.
            expect(a2.sentInputs).toEqual(['claude --r bar\r'])
            expect(b2.sentInputs).toEqual([])
            session2.focus(b2)
            session2.advance(2000)
            // b2 consumes the second slot.
            expect(b2.sentInputs).toEqual(['claude --r bar\r'])
        })
    })

    describe('Codex-specific replay', () => {
        it('captures a Codex command with flags and replays it on a restored focused tab', async () => {
            const session1 = new AutoResumeHarness()
            session1.start()
            const a1 = session1.addTab()
            session1.emitTick([
                makeTabState(a1, {
                    aiTool: 'codex',
                    cwd: '/repo',
                    aiCommandLine: '/opt/homebrew/bin/codex --model gpt-5 --sandbox workspace-write',
                }),
            ])
            await Promise.resolve()

            const persisted = session1.getPersisted()
            expect(persisted).toEqual({
                '/repo': { command: 'codex --model gpt-5 --sandbox workspace-write', count: 1 },
            })

            const session2 = new AutoResumeHarness({ persisted })
            const a2 = session2.addTab({ restored: 'preexisting', active: true })
            session2.start()
            session2.emitTick([makeTabState(a2, { cwd: '/repo' })])
            session2.advance(2000)

            expect(a2.sentInputs).toEqual(['codex --model gpt-5 --sandbox workspace-write\r'])
        })

        it('applies per-cwd quota to Codex tabs just like Claude tabs', async () => {
            const h = new AutoResumeHarness({
                persisted: { '/repo': { command: 'codex -m gpt-5', count: 1 } },
            })
            const a = h.addTab({ restored: 'preexisting', active: true })
            const b = h.addTab({ restored: 'preexisting' })
            h.start()
            h.emitTick([
                makeTabState(a, { cwd: '/repo' }),
                makeTabState(b, { cwd: '/repo' }),
            ])
            h.advance(2000)
            expect(a.sentInputs).toEqual(['codex -m gpt-5\r'])
            expect(b.sentInputs).toEqual([])

            h.focus(b)
            h.advance(2000)
            expect(b.sentInputs).toEqual([])
        })
    })
})
