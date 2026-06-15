import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { HookRuntimeService } from '../hook-runtime.service'

/**
 * Format-consistency guard between the REAL on-disk hook handler and the
 * hand-authored fixtures / types the watcher relies on.
 *
 * Every other replay/reducer test feeds the watcher SYNTHETIC NDJSON
 * (TraceEvent objects, fixture lines) that a human typed. Those stay useful
 * only while they match what the handler ACTUALLY writes. This spec spawns
 * the real POSIX handler (`runtime.shHandlerPath`, same pattern as
 * codex-runtime-watcher / monitor-timeout-extraction) for one representative
 * payload per event class, parses the emitted JSON line, and asserts its KEY
 * SET is EXACTLY the documented field set below — no more, no fewer.
 *
 * Why this is the load-bearing assertion:
 *   - If the handler starts emitting a NEW field, this fails with the field
 *     name so we go add it to HookStatusFile / TraceEvent (otherwise the
 *     watcher silently ignores a signal the handler is paying to compute).
 *   - If the handler DROPS or RENAMES a field, this fails too — catching the
 *     case where a fixture keeps asserting on `spawn_agent_id` after the
 *     handler quietly renamed it, which would make every reducer test green
 *     against a contract that no longer exists.
 *   - The record shape is INVARIANT across event types (the handler's printf
 *     is unconditional), so we assert the same 20-key set for a Stop as for a
 *     PostToolUse(Monitor). A future refactor that makes the key set
 *     event-dependent would break the watcher's JSON.parse expectations; this
 *     pins it.
 *
 * Note on TraceEvent: the test harness's `TraceEvent` interface deliberately
 * omits `transcript_path` (it's consumed by mobile-bridge's transcript
 * tailer, never by the watcher's reducers), so the authoritative list here is
 * the HANDLER's documented output — the production `HookStatusFile` interface
 * mirrors it 1:1.
 */

// The exact field set the POSIX handler's printf emits (hook-runtime.service.ts).
// Keep in sync with HookStatusFile in hook-watcher.service.ts.
const EXPECTED_KEYS = [
    'tab_id', 'agent', 'event', 'matcher', 'tool_name', 'session_id', 'cwd',
    'transcript_path', 'ts', 'bg', 'interrupted', 'agent_id', 'agent_type',
    'spawn_agent_id', 'monitor_task_id', 'monitor_timeout_ms', 'stop_task_id',
    'model', 'auto_approved', 'source',
].sort()

const TAB_ID = '33333333-3333-4333-8333-333333333333'
let oldHome: string | undefined
let oldUserProfile: string | undefined
let tempHome: string

async function runHandler (runtime: HookRuntimeService, agent: string, payload: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(runtime.shHandlerPath, [agent], {
            env: { ...process.env, HOME: tempHome, GLANCETERM_TAB_ID: TAB_ID },
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', c => { stderr += c })
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`handler exited ${code}: ${stderr}`)))
        child.stdin.end(JSON.stringify(payload))
    })
}

async function lastEmitted (runtime: HookRuntimeService): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(path.join(runtime.stateDir, `${TAB_ID}.log`), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    return JSON.parse(lines[lines.length - 1])
}

beforeEach(async () => {
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-handler-format-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
})

interface Case {
    name: string
    agent: string
    payload: Record<string, unknown>
    /** Field/value pairs the emitted record must carry — proves the handler
     *  actually POPULATES (not just emits-empty) the field this event class
     *  is responsible for. */
    expects: Record<string, unknown>
}

const CASES: Case[] = [
    {
        name: 'PreToolUse(Bash)',
        agent: 'claude',
        payload: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'ls' } },
        expects: { event: 'PreToolUse', tool_name: 'Bash', bg: 0 },
    },
    {
        name: 'PostToolUse(Bash)',
        agent: 'claude',
        payload: { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_response: { stdout: 'ok' } },
        expects: { event: 'PostToolUse', tool_name: 'Bash', interrupted: 0 },
    },
    {
        name: 'PreToolUse(Bash) backgrounded (bg=1)',
        agent: 'claude',
        payload: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'sleep 99', run_in_background: true } },
        expects: { event: 'PreToolUse', tool_name: 'Bash', bg: 1 },
    },
    {
        name: 'PostToolUse(Bash) interrupted',
        agent: 'claude',
        payload: { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_response: { interrupted: true } },
        expects: { event: 'PostToolUse', interrupted: 1 },
    },
    {
        name: 'PostToolUse(Agent) w/ tool_response.agentId',
        agent: 'claude',
        payload: { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p', tool_name: 'Agent', tool_response: { agentId: 'a1234567890abcdef' } },
        expects: { event: 'PostToolUse', tool_name: 'Agent', spawn_agent_id: 'a1234567890abcdef' },
    },
    {
        name: 'SubagentStop w/ agent_id',
        agent: 'claude',
        payload: { hook_event_name: 'SubagentStop', session_id: 's', cwd: '/p', agent_id: 'a1234567890abcdef', agent_type: 'reviewer' },
        expects: { event: 'SubagentStop', agent_id: 'a1234567890abcdef', agent_type: 'reviewer' },
    },
    {
        name: 'Stop',
        agent: 'claude',
        payload: { hook_event_name: 'Stop', session_id: 's', cwd: '/p' },
        expects: { event: 'Stop' },
    },
    {
        name: 'PermissionRequest (no auto-approve / relay)',
        agent: 'claude',
        payload: { hook_event_name: 'PermissionRequest', session_id: 's', cwd: '/p', tool_name: 'Bash' },
        expects: { event: 'PermissionRequest', auto_approved: 0 },
    },
    {
        name: 'PostToolUse(Monitor) w/ tool_response.timeoutMs',
        agent: 'claude',
        payload: { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p', tool_name: 'Monitor', tool_response: { taskId: 'bmonitor01', timeoutMs: 240000 } },
        expects: { event: 'PostToolUse', tool_name: 'Monitor', monitor_task_id: 'bmonitor01', monitor_timeout_ms: 240000 },
    },
    {
        name: 'PreToolUse(TaskStop) w/ tool_input.task_id',
        agent: 'claude',
        payload: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'TaskStop', tool_input: { task_id: 'bmonitor01' } },
        expects: { event: 'PreToolUse', tool_name: 'TaskStop', stop_task_id: 'bmonitor01' },
    },
    {
        name: 'SessionStart w/ source + model (compact)',
        agent: 'claude',
        payload: { hook_event_name: 'SessionStart', session_id: 's', cwd: '/p', source: 'compact', model: 'claude-opus-4-8' },
        expects: { event: 'SessionStart', source: 'compact', model: 'claude-opus-4-8' },
    },
]

describe('real sh handler — emitted NDJSON field set matches the documented contract', () => {
    it.each(CASES)('$name emits EXACTLY the documented 20-key record', async ({ agent, payload, expects }) => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        await runHandler(runtime, agent, payload)
        const rec = await lastEmitted(runtime)

        const actual = Object.keys(rec).sort()
        const extra = actual.filter(k => !EXPECTED_KEYS.includes(k))
        const missing = EXPECTED_KEYS.filter(k => !actual.includes(k))

        // Fail LOUDLY with the offending field name(s) so the fix is obvious:
        // a new/renamed field must be added to HookStatusFile + TraceEvent +
        // EXPECTED_KEYS; a dropped field means a fixture/reducer is asserting
        // on a contract the handler no longer honors.
        expect(
            extra,
            `handler emitted UNKNOWN field(s) [${extra}] — add them to HookStatusFile/TraceEvent and EXPECTED_KEYS`,
        ).toEqual([])
        expect(
            missing,
            `handler is MISSING documented field(s) [${missing}] — the handler dropped/renamed a field the watcher relies on`,
        ).toEqual([])

        // The full set must match exactly (belt-and-braces over the two checks).
        expect(actual).toEqual(EXPECTED_KEYS)

        // And the field this event class is responsible for must be populated.
        for (const [k, v] of Object.entries(expects)) {
            expect(rec[k], `expected ${k}=${JSON.stringify(v)} for this event`).toEqual(v)
        }
    })

    it('emits the SAME key set regardless of event type (invariant record shape)', async () => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        // Two very different events: a bare Stop and a rich PostToolUse(Monitor).
        await runHandler(runtime, 'claude', { hook_event_name: 'Stop', session_id: 's', cwd: '/p' })
        await runHandler(runtime, 'claude', { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p', tool_name: 'Monitor', tool_response: { taskId: 't', timeoutMs: 1000 } })
        const raw = await fs.readFile(path.join(runtime.stateDir, `${TAB_ID}.log`), 'utf8')
        const [a, b] = raw.split('\n').filter(Boolean).map(l => Object.keys(JSON.parse(l)).sort())
        expect(a).toEqual(EXPECTED_KEYS)
        expect(b).toEqual(EXPECTED_KEYS)
        expect(a).toEqual(b)
    })
})
