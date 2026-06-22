import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { AutoResumeHarness, makeTabState } from './auto-resume-harness'

/**
 * Integration tests for AutoResumeService — the CAPTURE / CLEANUP / REPLAY
 * state machine under the per-tab recovery-token model.
 *
 * The headline fix this file pins down: the agent command is keyed PER TAB
 * (stored on the tab, ferried across restart in the tab's own recovery
 * token), not per cwd. Two tabs sharing a directory but running different
 * agents — or the same agent with different flags — each get their own
 * command back on restart instead of collapsing onto one cwd-keyed entry.
 * That collapse was the reported bug ("same path, two tabs, two agents →
 * both come back as one").
 *
 * Pure-function coverage (isShellSafe, toRunnableCommand) lives next door in
 * auto-resume.test.ts. This file exercises the live service via the harness.
 *
 * Fake timers: scheduleResume waits 2 s before sendInput, scheduleWarmup
 * waits 250 ms; tests opt in to `vi.useFakeTimers()` and advance on demand.
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
        it('stashes the reduced command on the tab when an agent is alive', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: '/usr/local/bin/claude --resume foo',
            })])
            expect(a.glancetermResumeCommand).toBe('claude --resume foo')
        })

        it('keeps each tab\'s own command — no cross-tab collision at one cwd', async () => {
            // The core of the fix. Two tabs in /repo, one claude one codex.
            // Pre-fix these collapsed onto a single cwd entry (last write
            // won). Now each tab carries its own command.
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            const b = h.addTab()
            h.emitTick([
                makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude --resume A' }),
                makeTabState(b, { aiTool: 'codex', cwd: '/repo', aiCommandLine: 'codex --model gpt-5' }),
            ])
            expect(a.glancetermResumeCommand).toBe('claude --resume A')
            expect(b.glancetermResumeCommand).toBe('codex --model gpt-5')
        })

        it('refreshes the command as flags drift across ticks', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' })])
            expect(a.glancetermResumeCommand).toBe('claude')
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude --resume foo' })])
            expect(a.glancetermResumeCommand).toBe('claude --resume foo')
        })

        it('upgrades to claude --resume <id> when a session id is known', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            const sid = 'ea59366a-a2d5-43e1-b894-aa40a8188fb6'
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: 'claude --model opus',
                sessionId: sid,
            })])
            expect(a.glancetermResumeCommand).toBe(`claude --resume ${sid} --model opus`)
        })

        it('uses codex resume <id> for codex tabs', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            const sid = '019eba31-ac54-7311-949e-fde38fe88a03'
            h.emitTick([makeTabState(a, {
                aiTool: 'codex', cwd: '/repo', aiCommandLine: 'codex', sessionId: sid,
            })])
            expect(a.glancetermResumeCommand).toBe(`codex resume ${sid}`)
        })

        it('falls back to the fresh command when autoResumeSession is off', async () => {
            const h = new AutoResumeHarness({ autoResumeSession: false })
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: 'claude',
                sessionId: 'ea59366a-a2d5-43e1-b894-aa40a8188fb6',
            })])
            expect(a.glancetermResumeCommand).toBe('claude')
        })

        it('falls back to the fresh command for gemini (no resume-by-id)', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'gemini',
                cwd: '/repo',
                aiCommandLine: 'gemini',
                sessionId: 'ea59366a-a2d5-43e1-b894-aa40a8188fb6',
            })])
            expect(a.glancetermResumeCommand).toBe('gemini')
        })

        it('end-to-end: a restored claude tab replays --resume <id> into the shell', async () => {
            const sid = 'ea59366a-a2d5-43e1-b894-aa40a8188fb6'
            // The replay path runs demoteStaleClaudeResume, which demotes a
            // `claude --resume <uuid>` back to a bare `claude` when Claude no
            // longer holds that session's transcript on disk. Point $HOME at a
            // temp tree that DOES contain the transcript so the (valid) resume
            // survives — otherwise this only passes on a machine that happens to
            // have this exact session in ~/.claude and fails on a clean CI
            // runner. os.homedir() honours $HOME on POSIX, which is how the
            // service resolves the transcript path.
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'glanceterm-replay-'))
            const proj = path.join(home, '.claude', 'projects', '-repo')
            fs.mkdirSync(proj, { recursive: true })
            fs.writeFileSync(path.join(proj, `${sid}.jsonl`), '{}\n')
            const prevHome = process.env.HOME
            process.env.HOME = home
            try {
                // Restored, active tab that captured a session id before quit.
                const h = new AutoResumeHarness({
                    preexistingTabs: [{ active: true, resumeCommand: `claude --resume ${sid}` }],
                })
                h.start()
                const a = h.app.tabs[0]
                // Shell comes alive: cwd known, no agent yet (recovered bare shell).
                h.emitTick([makeTabState(a, { aiTool: null, cwd: '/repo' })])
                await vi.advanceTimersByTimeAsync(2_000)
                expect(a.sentInputs).toContain(`claude --resume ${sid}\r`)
            } finally {
                if (prevHome === undefined) {
                    delete process.env.HOME
                } else {
                    process.env.HOME = prevHome
                }
                fs.rmSync(home, { recursive: true, force: true })
            }
        })

        it('does not stash a shell-unsafe command that survives reduction', async () => {
            // The realistic attack vector: argv[0] basename is exactly
            // `claude` with the payload in argv[1+], so it survives
            // toRunnableCommand and must be caught by the safety gate.
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: 'claude \'; rm -rf ~ #\'',
            })])
            expect(a.glancetermResumeCommand).toBeUndefined()
        })

        it('stashes the bare-tool fallback for cmdlines toRunnableCommand cannot parse', async () => {
            // An exotic cmdline that doesn't surface a token matching the
            // tool name falls through to just the bare tool — shell-safe by
            // construction, so the stash happens (losing flags, not safety).
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, {
                aiTool: 'claude',
                cwd: '/repo',
                aiCommandLine: 'claude; rm -rf /',
            })])
            expect(a.glancetermResumeCommand).toBe('claude')
        })

        it('is a no-op when the master toggle is off', async () => {
            const h = new AutoResumeHarness({ autoResumeAgents: false })
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' })])
            expect(a.glancetermResumeCommand).toBeUndefined()
        })

        it('does not need a cwd to capture — the command is cwd-agnostic now', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: null, aiCommandLine: 'claude' })])
            expect(a.glancetermResumeCommand).toBe('claude')
        })
    })

    // ── CLEANUP ────────────────────────────────────────────────────────────

    describe('CLEANUP', () => {
        it('clears the command when the user quits the agent', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' })])
            expect(a.glancetermResumeCommand).toBe('claude')
            // claude is gone but the shell is alive (cwd known).
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            expect(a.glancetermResumeCommand).toBeUndefined()
        })

        it('clears only the quitting tab, leaving siblings at the same cwd intact', async () => {
            const h = new AutoResumeHarness()
            h.start()
            const a = h.addTab()
            const b = h.addTab()
            h.emitTick([
                makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' }),
                makeTabState(b, { aiTool: 'codex', cwd: '/repo', aiCommandLine: 'codex' }),
            ])
            // tab a's user types exit; b keeps running.
            h.emitTick([
                makeTabState(a, { cwd: '/repo' }),
                makeTabState(b, { aiTool: 'codex', cwd: '/repo', aiCommandLine: 'codex' }),
            ])
            expect(a.glancetermResumeCommand).toBeUndefined()
            expect(b.glancetermResumeCommand).toBe('codex')
        })

        it('does not clear a restored command on a bare-shell tick before any agent ran', async () => {
            // The cleanup gate requires hadAgentThisSession — a restored tab
            // legitimately carries a command but has not run its agent THIS
            // session yet, so the first bare-shell tick must NOT wipe it
            // (that tick is REPLAY's cue, not CLEANUP's).
            const h = new AutoResumeHarness()
            const a = h.addTab({ restored: 'preexisting', resumeCommand: 'claude' })
            h.start()
            // No focus → REPLAY won't fire, but CLEANUP must also leave it be.
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            expect(a.glancetermResumeCommand).toBe('claude')
        })
    })

    // ── REPLAY ──────────────────────────────────────────────────────────────

    describe('REPLAY — per-tab command', () => {
        it('headline fix: same cwd, two restored tabs, two different agents', async () => {
            // The exact reported bug, end to end. Two tabs recovered at the
            // same /repo, each token carrying a different command. Each must
            // replay its OWN command, not a shared one.
            const h = new AutoResumeHarness()
            const a = h.addTab({ restored: 'preexisting', active: true, resumeCommand: 'claude --resume A' })
            const b = h.addTab({ restored: 'preexisting', resumeCommand: 'codex --model gpt-5' })
            h.start()
            h.emitTick([
                makeTabState(a, { cwd: '/repo' }),
                makeTabState(b, { cwd: '/repo' }),
            ])
            // 250 ms warm-up (b) + 2 s resume; 3 s flushes both.
            h.advance(3000)
            expect(a.sentInputs).toEqual(['claude --resume A\r'])
            expect(b.sentInputs).toEqual(['codex --model gpt-5\r'])
        })

        it('auto-resumes all restored tabs at startup via the warm-up dance', async () => {
            // Every restored tab carrying a command gets its agent back at
            // app start (warm-up synthesises focus on each non-active one),
            // not just the focused tab.
            const h = new AutoResumeHarness({
                preexistingTabs: [
                    { title: 'a', resumeCommand: 'claude' },
                    { title: 'b', resumeCommand: 'claude' },
                    { title: 'c', resumeCommand: 'claude' },
                ],
            })
            h.start()
            const [a, b, c] = h.app.tabs
            h.emitTick([
                makeTabState(a, { cwd: '/repo' }),
                makeTabState(b, { cwd: '/repo' }),
                makeTabState(c, { cwd: '/repo' }),
            ])
            h.advance(3000)
            expect(a.sentInputs).toEqual(['claude\r'])
            expect(b.sentInputs).toEqual(['claude\r'])
            expect(c.sentInputs).toEqual(['claude\r'])
        })

        it('skips warm-up when the master switch is off', async () => {
            const h = new AutoResumeHarness({ autoResumeAgents: false })
            const a = h.addTab({ restored: 'preexisting', resumeCommand: 'claude' })
            const b = h.addTab({ restored: 'preexisting', resumeCommand: 'claude' })
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
            // recoverTabs() auto-focuses the originally-active tab BEFORE the
            // service subscribes to activeTabChange$, so we MUST seed
            // focusedOuterTabs from app.activeTab at construction.
            const h = new AutoResumeHarness()
            const a = h.addTab({ restored: 'preexisting', active: true, resumeCommand: 'claude --resume foo' })
            h.start()
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            h.advance(2000)
            expect(a.sentInputs).toEqual(['claude --resume foo\r'])
        })

        it('replays when a previously-unfocused tab gains focus', async () => {
            const h = new AutoResumeHarness()
            const a = h.addTab({ restored: 'preexisting', resumeCommand: 'claude' })
            // Suppress the startup warm-up for this test by NOT advancing past
            // it before focusing — assert the pre-focus state first.
            h.start()
            // Active tab is something else so warm-up would normally fire for
            // `a`; advance only the resume delay, not the warm-up, to observe
            // the focus-driven path explicitly.
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            // Before warm-up fires (250 ms) and before focus, nothing.
            h.advance(100)
            expect(a.sentInputs).toEqual([])

            h.focus(a)
            h.advance(2000)
            expect(a.sentInputs).toEqual(['claude\r'])
        })

        it('does not replay a restored tab that carries no command (bare shell)', async () => {
            // A tab that was a plain shell last session has no command in its
            // token → nothing to replay, even when focused at a cwd where a
            // sibling tab DID have an agent.
            const h = new AutoResumeHarness()
            const a = h.addTab({ restored: 'preexisting', active: true /* no resumeCommand */ })
            h.start()
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            h.advance(3000)
            expect(a.sentInputs).toEqual([])
        })

        it('does not surprise-launch a tab the user opens after startup', async () => {
            // tabOpened$ outside RESTORED_CAPTURE_MS → not restored → no
            // replay even if the token somehow carried a command.
            const h = new AutoResumeHarness()
            h.start()
            vi.advanceTimersByTime(31_000)
            const a = h.addTab({ restored: 'opened', resumeCommand: 'claude' })
            h.focus(a)
            h.emitTick([makeTabState(a, { cwd: '/repo' })])
            h.advance(2000)
            expect(a.sentInputs).toEqual([])
        })

        it('does not replay twice on the same tab across ticks', async () => {
            const h = new AutoResumeHarness()
            const a = h.addTab({ restored: 'preexisting', active: true, resumeCommand: 'claude' })
            h.start()
            for (let i = 0; i < 5; i++) {
                h.emitTick([makeTabState(a, { cwd: '/repo' })])
            }
            h.advance(2000)
            expect(a.sentInputs).toEqual(['claude\r'])
        })

        it('does not replay while an agent is already running in the restored tab', async () => {
            // If the restored shell came back with its agent still detected
            // (live-pty restore), REPLAY's !aiTool gate suppresses the resend.
            const h = new AutoResumeHarness()
            const a = h.addTab({ restored: 'preexisting', active: true, resumeCommand: 'claude' })
            h.start()
            h.emitTick([makeTabState(a, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' })])
            h.advance(2000)
            expect(a.sentInputs).toEqual([])
        })
    })

    // ── End-to-end scenarios ──────────────────────────────────────────────

    describe('end-to-end scenarios', () => {
        it('two tabs, two agents at one cwd: capture in session 1, restore both in session 2', async () => {
            // Session 1: tab A runs claude, tab B runs codex, both in /repo.
            const session1 = new AutoResumeHarness()
            session1.start()
            const a1 = session1.addTab()
            const b1 = session1.addTab()
            session1.emitTick([
                makeTabState(a1, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude --resume foo' }),
                makeTabState(b1, { aiTool: 'codex', cwd: '/repo', aiCommandLine: 'codex --model gpt-5' }),
            ])
            // Each tab's recovery token would carry its own command.
            const cmdA = a1.glancetermResumeCommand
            const cmdB = b1.glancetermResumeCommand
            expect(cmdA).toBe('claude --resume foo')
            expect(cmdB).toBe('codex --model gpt-5')

            // Quit & restart. Session 2 boots; recovery restores each tab with
            // its own command (the harness models recover() via resumeCommand).
            const session2 = new AutoResumeHarness()
            const a2 = session2.addTab({ restored: 'preexisting', active: true, resumeCommand: cmdA })
            const b2 = session2.addTab({ restored: 'preexisting', resumeCommand: cmdB })
            session2.start()
            session2.emitTick([
                makeTabState(a2, { cwd: '/repo' }),
                makeTabState(b2, { cwd: '/repo' }),
            ])
            session2.advance(3000)
            expect(a2.sentInputs).toEqual(['claude --resume foo\r'])
            expect(b2.sentInputs).toEqual(['codex --model gpt-5\r'])
        })

        it('3 tabs share a cwd, only 1 had an agent: only that tab resumes', async () => {
            // Previously handled by a per-cwd count/quota hack. Now it falls
            // out for free: only the tab that had an agent carries a command.
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
            expect(a1.glancetermResumeCommand).toBe('claude')
            expect(b1.glancetermResumeCommand).toBeUndefined()
            expect(c1.glancetermResumeCommand).toBeUndefined()

            const session2 = new AutoResumeHarness()
            const a2 = session2.addTab({ restored: 'preexisting', active: true, resumeCommand: 'claude' })
            const b2 = session2.addTab({ restored: 'preexisting' })
            const c2 = session2.addTab({ restored: 'preexisting' })
            session2.start()
            session2.emitTick([
                makeTabState(a2, { cwd: '/repo' }),
                makeTabState(b2, { cwd: '/repo' }),
                makeTabState(c2, { cwd: '/repo' }),
            ])
            session2.advance(3000)
            expect(a2.sentInputs).toEqual(['claude\r'])
            expect(b2.sentInputs).toEqual([])
            expect(c2.sentInputs).toEqual([])
        })

        it('quitting the agent before app exit prevents the resume next launch', async () => {
            // Session 1: run claude, then exit it. Command cleared → token
            // carries nothing → session 2 restores a bare shell.
            const session1 = new AutoResumeHarness()
            session1.start()
            const a1 = session1.addTab()
            session1.emitTick([makeTabState(a1, { aiTool: 'claude', cwd: '/repo', aiCommandLine: 'claude' })])
            expect(a1.glancetermResumeCommand).toBe('claude')
            session1.emitTick([makeTabState(a1, { cwd: '/repo' })])
            expect(a1.glancetermResumeCommand).toBeUndefined()

            const session2 = new AutoResumeHarness()
            const a2 = session2.addTab({ restored: 'preexisting', active: true, resumeCommand: a1.glancetermResumeCommand })
            session2.start()
            session2.emitTick([makeTabState(a2, { cwd: '/repo' })])
            session2.advance(3000)
            expect(a2.sentInputs).toEqual([])
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
            const cmd = a1.glancetermResumeCommand
            expect(cmd).toBe('codex --model gpt-5 --sandbox workspace-write')

            const session2 = new AutoResumeHarness()
            const a2 = session2.addTab({ restored: 'preexisting', active: true, resumeCommand: cmd })
            session2.start()
            session2.emitTick([makeTabState(a2, { cwd: '/repo' })])
            session2.advance(2000)
            expect(a2.sentInputs).toEqual(['codex --model gpt-5 --sandbox workspace-write\r'])
        })
    })
})
