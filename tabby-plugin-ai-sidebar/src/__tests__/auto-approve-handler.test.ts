import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'

import { HookRuntimeService } from '../hook-runtime.service'

/**
 * Behavioural regression test for the embedded POSIX hook handler's
 * auto-approve branch — specifically the AskUserQuestion exclusion.
 *
 * Bug it pins: auto-approve used to answer EVERY Claude `PermissionRequest`
 * with `decision.behavior:"allow"`, including `AskUserQuestion`. But
 * AskUserQuestion is a multiple-choice question whose RESULT is the option
 * the user picks — "allow" runs it with no selection, so Claude gets an
 * empty answer and the turn dies ("no answer") or proceeds on a wrong
 * default. The handler must NOT auto-approve AskUserQuestion; it should emit
 * nothing so Claude falls back to its interactive selector (and the sidebar
 * row stays needs_permission until the user answers).
 *
 * We exercise the REAL artifact: `HookRuntimeService.ensureReady()` writes
 * `glanceterm-hook.sh` to a temp HOME (the service reads $HOME at
 * construction precisely so tests can redirect it), then we run it through
 * `/bin/sh` with crafted payloads. POSIX-only — the handler is a shell
 * script; the PowerShell sibling carries the same guard but isn't executed
 * here.
 */

const isPosix = process.platform !== 'win32'
const d = isPosix ? describe : describe.skip

d('hook handler (POSIX) — auto-approve exclusion + tab-id recovery', () => {
    let tmpHome: string
    let prevHome: string | undefined
    let handlerPath: string

    beforeAll(async () => {
        prevHome = process.env.HOME
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-autoapprove-'))
        // HookRuntimeService roots at homeFromEnv() === $HOME at construction.
        process.env.HOME = tmpHome
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        handlerPath = runtime.shHandlerPath
        expect(fs.existsSync(handlerPath)).toBe(true)
    })

    afterAll(() => {
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
        try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
    })

    /** Run the handler with `auto-approve.flag` content + a PermissionRequest
     *  payload for `toolName`; return its stdout. No relay flag is written, so
     *  a hypothetical regression can never enter the 25-min relay poll. */
    function runPermissionRequest (autoFlag: string, toolName: string, agent = 'claude'): string {
        fs.writeFileSync(path.join(tmpHome, '.glanceterm', 'auto-approve.flag'), autoFlag)
        const payload = JSON.stringify({
            hook_event_name: 'PermissionRequest',
            tool_name: toolName,
            session_id: 'sess-1',
            cwd: '/tmp/project',
        })
        return execFileSync('/bin/sh', [handlerPath, agent], {
            input: payload,
            encoding: 'utf8',
            env: { ...process.env, HOME: tmpHome, GLANCETERM_TAB_ID: 'test-tab' },
            timeout: 10_000,
        })
    }

    it('does NOT auto-approve AskUserQuestion even with the flag on', () => {
        const out = runPermissionRequest('1', 'AskUserQuestion')
        expect(out).not.toContain('"behavior":"allow"')
        // Nothing on stdout → Claude falls back to its interactive selector.
        expect(out.trim()).toBe('')
    })

    it('DOES auto-approve a normal action tool (Bash) with the flag on', () => {
        const out = runPermissionRequest('1', 'Bash')
        expect(out).toContain('"hookSpecificOutput"')
        expect(out).toContain('"behavior":"allow"')
    })

    it('does not auto-approve anything when the flag is off', () => {
        const out = runPermissionRequest('0', 'Bash')
        expect(out.trim()).toBe('')
    })

    // ── Codex auto-approve (PR #17563 — same decision JSON as Claude) ─────

    it('auto-approves a Codex Bash permission with the flag on', () => {
        const out = runPermissionRequest('1', 'Bash', 'codex')
        expect(out).toContain('"behavior":"allow"')
    })

    it('does NOT auto-approve Codex AskUserQuestion even with the flag on', () => {
        const out = runPermissionRequest('1', 'AskUserQuestion', 'codex')
        expect(out.trim()).toBe('')
    })

    it('does not auto-approve Codex when the flag is off', () => {
        const out = runPermissionRequest('0', 'Bash', 'codex')
        expect(out.trim()).toBe('')
    })

    it('still does NOT auto-approve other agents (gemini) — only claude/codex', () => {
        // Gemini cannot honor the allow JSON; emitting it would be noise.
        const out = runPermissionRequest('1', 'Bash', 'gemini')
        expect(out.trim()).toBe('')
    })

    it('still records the PermissionRequest in the per-tab log for the sidebar', () => {
        // The per-tab .log line is written BEFORE the auto-approve branch, so
        // AskUserQuestion still surfaces as needs_permission in the sidebar.
        runPermissionRequest('1', 'AskUserQuestion')
        const log = fs.readFileSync(
            path.join(tmpHome, '.glanceterm', 'hooks', 'test-tab.log'), 'utf8',
        )
        const lastLine = log.trim().split('\n').pop() ?? ''
        const rec = JSON.parse(lastLine)
        expect(rec.event).toBe('PermissionRequest')
        expect(rec.tool_name).toBe('AskUserQuestion')
    })

    // ── auto_approved marker (unsticks needs_permission for auto-approved,
    //    long-running tools — see HookWatcher.processEvent) ────────────────

    /** Read the last per-tab log record for the default 'test-tab'. */
    function lastTestTabRecord (): any {
        const log = fs.readFileSync(
            path.join(tmpHome, '.glanceterm', 'hooks', 'test-tab.log'), 'utf8',
        )
        return JSON.parse(log.trim().split('\n').pop() as string)
    }

    it('stamps auto_approved:1 on a PermissionRequest it auto-approves (Bash, flag on)', () => {
        // This is the marker HookWatcher maps to `working` instead of leaving the
        // row stuck on needs_permission for the tool's whole runtime.
        runPermissionRequest('1', 'Bash')
        expect(lastTestTabRecord().auto_approved).toBe(1)
    })

    it('stamps auto_approved:0 when the flag is OFF (genuine local/relay prompt)', () => {
        runPermissionRequest('0', 'Bash')
        expect(lastTestTabRecord().auto_approved).toBe(0)
    })

    it('stamps auto_approved:0 on AskUserQuestion even with the flag on', () => {
        // Excluded from auto-approve → must still surface as needs_permission.
        runPermissionRequest('1', 'AskUserQuestion')
        expect(lastTestTabRecord().auto_approved).toBe(0)
    })

    it('stamps auto_approved:1 for Codex too (same auto-approve path)', () => {
        runPermissionRequest('1', 'Bash', 'codex')
        expect(lastTestTabRecord().auto_approved).toBe(1)
    })

    it('never stamps auto_approved for other agents (gemini), even with flag on', () => {
        const tabId = 'gem-marker-tab'
        const payload = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: 's', cwd: '/tmp/g' })
        fs.writeFileSync(path.join(tmpHome, '.glanceterm', 'auto-approve.flag'), '1')
        execFileSync('/bin/sh', [handlerPath, 'gemini'], {
            input: payload, encoding: 'utf8',
            env: { ...process.env, HOME: tmpHome, GLANCETERM_TAB_ID: tabId }, timeout: 10_000,
        })
        const rec = JSON.parse(
            fs.readFileSync(path.join(tmpHome, '.glanceterm', 'hooks', `${tabId}.log`), 'utf8').trim().split('\n').pop() as string,
        )
        expect(rec.auto_approved).toBe(0)
    })

    it('does not stamp auto_approved on non-PermissionRequest events (flag on)', () => {
        // PreToolUse already maps to `working`; the marker is only meaningful for
        // PermissionRequest. A PreToolUse with the flag on must stay auto_approved:0.
        const tabId = 'pre-marker-tab'
        const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's', cwd: '/tmp/p' })
        fs.writeFileSync(path.join(tmpHome, '.glanceterm', 'auto-approve.flag'), '1')
        execFileSync('/bin/sh', [handlerPath, 'claude'], {
            input: payload, encoding: 'utf8',
            env: { ...process.env, HOME: tmpHome, GLANCETERM_TAB_ID: tabId }, timeout: 10_000,
        })
        const rec = JSON.parse(
            fs.readFileSync(path.join(tmpHome, '.glanceterm', 'hooks', `${tabId}.log`), 'utf8').trim().split('\n').pop() as string,
        )
        expect(rec.event).toBe('PreToolUse')
        expect(rec.auto_approved).toBe(0)
    })

    // ── SessionStart `source` capture (drives the compact → not-idle fix) ──

    /** Run an arbitrary event payload through the handler under a throwaway tab
     *  id and return the last log record for it. */
    function runEvent (tabId: string, payload: object, agent = 'claude'): any {
        execFileSync('/bin/sh', [handlerPath, agent], {
            input: JSON.stringify(payload), encoding: 'utf8',
            env: { ...process.env, HOME: tmpHome, GLANCETERM_TAB_ID: tabId }, timeout: 10_000,
        })
        return JSON.parse(
            fs.readFileSync(path.join(tmpHome, '.glanceterm', 'hooks', `${tabId}.log`), 'utf8').trim().split('\n').pop() as string,
        )
    }

    it('captures source:"compact" on a post-compaction SessionStart', () => {
        const rec = runEvent('src-compact', {
            hook_event_name: 'SessionStart', source: 'compact', session_id: 's', cwd: '/repo', model: 'claude-opus-4-8[1m]',
        })
        expect(rec.event).toBe('SessionStart')
        expect(rec.source).toBe('compact')
    })

    it('captures source:"startup" on a fresh SessionStart', () => {
        const rec = runEvent('src-startup', {
            hook_event_name: 'SessionStart', source: 'startup', session_id: 's', cwd: '/repo',
        })
        expect(rec.source).toBe('startup')
    })

    it('does NOT leak a nested "source" from a non-SessionStart payload (scoped extraction)', () => {
        // A tool whose payload happens to contain a "source" key must not stamp
        // it — only SessionStart carries the field we act on.
        const rec = runEvent('src-scoped', {
            hook_event_name: 'PostToolUse', tool_name: 'Read', session_id: 's', cwd: '/repo',
            tool_response: { source: 'compact' },
        })
        expect(rec.event).toBe('PostToolUse')
        expect(rec.source).toBe('')
    })

    it('extracts the active model slug into the per-tab log record', () => {
        // Codex sends a top-level `model` on every event; the handler writes it
        // to the log so the sidebar can show it. Drive a UserPromptSubmit with
        // a model field and assert it round-trips (flag off — model capture is
        // independent of auto-approve).
        fs.writeFileSync(path.join(tmpHome, '.glanceterm', 'auto-approve.flag'), '0')
        const payload = JSON.stringify({
            hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/tmp/p', model: 'gpt-5.5',
        })
        execFileSync('/bin/sh', [handlerPath, 'codex'], {
            input: payload, encoding: 'utf8',
            env: { ...process.env, HOME: tmpHome, GLANCETERM_TAB_ID: 'test-tab' }, timeout: 10_000,
        })
        const rec = JSON.parse(
            fs.readFileSync(path.join(tmpHome, '.glanceterm', 'hooks', 'test-tab.log'), 'utf8').trim().split('\n').pop() as string,
        )
        expect(rec.event).toBe('UserPromptSubmit')
        expect(rec.model).toBe('gpt-5.5')
    })

    it('does not write an audit-log entry for the skipped AskUserQuestion', () => {
        // Audit log answers "what got auto-approved" — a tool we deliberately
        // pass through to the user must not appear there.
        const auditPath = path.join(tmpHome, '.glanceterm', 'auto-approve.log')
        const before = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : ''
        runPermissionRequest('1', 'AskUserQuestion')
        const after = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : ''
        expect(after).toBe(before)
    })

    // ── Sanitized-env tab-id recovery (Gemini) ───────────────────────────

    it('is valid POSIX sh (sh -n syntax check)', () => {
        // Parses the whole handler without executing — guards the tab-id
        // recovery block (and everything else) against a shell syntax error
        // that would silently break hooks for ALL agents.
        expect(() => execFileSync('/bin/sh', ['-n', handlerPath], { encoding: 'utf8' }))
            .not.toThrow()
    })

    it('uses argv[2] as the tab id when its own env lacks GLANCETERM_TAB_ID (Gemini path)', () => {
        // Gemini sanitizes the hook env, so its installed command passes the id
        // as a 2nd arg (gemini expands "$GLANCETERM_TAB_ID" itself). Simulate
        // the post-expansion call: var ABSENT from the handler's own env, id in
        // argv[2]. The handler must route on the arg.
        const tabId = 'arg-tab-123'
        const payload = JSON.stringify({ hook_event_name: 'BeforeAgent', session_id: 's', cwd: '/tmp/g' })
        execFileSync('/bin/sh', ['-c', `'${handlerPath}' gemini '${tabId}'`], {
            input: payload,
            encoding: 'utf8',
            env: { HOME: tmpHome, PATH: process.env.PATH },  // deliberately no GLANCETERM_TAB_ID
            timeout: 10_000,
        })
        const logPath = path.join(tmpHome, '.glanceterm', 'hooks', `${tabId}.log`)
        expect(fs.existsSync(logPath)).toBe(true)
        const rec = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n').pop() as string)
        expect(rec.event).toBe('BeforeAgent')
        expect(rec.agent).toBe('gemini')
        expect(rec.tab_id).toBe(tabId)
    })

    it('ignores an UNEXPANDED "$GLANCETERM_TAB_ID" placeholder in argv[2]', () => {
        // If the agent didn't expand the var, the literal arrives. We must NOT
        // create a garbage-named log — exit cleanly with no output.
        const payload = JSON.stringify({ hook_event_name: 'BeforeAgent', session_id: 's', cwd: '/tmp/g' })
        const out = execFileSync('/bin/sh', ['-c', `'${handlerPath}' gemini '$GLANCETERM_TAB_ID'`], {
            input: payload,
            encoding: 'utf8',
            env: { HOME: tmpHome, PATH: process.env.PATH },
            timeout: 10_000,
        })
        expect(out.trim()).toBe('')
        const hooksDir = path.join(tmpHome, '.glanceterm', 'hooks')
        const files = fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir) : []
        expect(files.some(f => f.includes('$') || f.includes('GLANCETERM_TAB_ID'))).toBe(false)
    })

    it('env var still wins over argv[2] (Claude/Codex unaffected by the Gemini path)', () => {
        // When the env var is present (claude/codex), it takes precedence and
        // any stray 2nd arg is ignored.
        const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's', cwd: '/tmp/g' })
        execFileSync('/bin/sh', ['-c', `'${handlerPath}' claude 'ignored-arg'`], {
            input: payload,
            encoding: 'utf8',
            env: { HOME: tmpHome, PATH: process.env.PATH, GLANCETERM_TAB_ID: 'env-tab' },
            timeout: 10_000,
        })
        expect(fs.existsSync(path.join(tmpHome, '.glanceterm', 'hooks', 'env-tab.log'))).toBe(true)
        expect(fs.existsSync(path.join(tmpHome, '.glanceterm', 'hooks', 'ignored-arg.log'))).toBe(false)
    })
})
