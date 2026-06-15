import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { HookRuntimeService } from '../hook-runtime.service'

/**
 * The live-monitor badge ("M monitor") self-evicts an id at
 * start + monitor_timeout_ms (a monitor fires no end hook; it runs until its
 * timeout or an explicit TaskStop). The deadline is only correct if we capture
 * the monitor's REAL timeout. Claude puts that authoritative value in
 * tool_response.timeoutMs (the value the Monitor actually uses, incl. its
 * default like 3600000); tool_input.timeout_ms is present only when the agent
 * passes one explicitly — absent in most real traces, which used to fall back
 * to a wrong 30-min default and mis-bound the badge. These run the REAL sh
 * handler and assert it extracts tool_response.timeoutMs, preferring it over
 * tool_input.timeout_ms.
 */

const TAB_ID = '22222222-2222-4222-8222-222222222222'
let oldHome: string | undefined
let oldUserProfile: string | undefined
let tempHome: string

async function runHandler (runtime: HookRuntimeService, payload: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(runtime.shHandlerPath, ['claude'], {
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

async function emittedMonitorFields (runtime: HookRuntimeService): Promise<{ monitor_task_id: string; monitor_timeout_ms: number }> {
    const raw = await fs.readFile(path.join(runtime.stateDir, `${TAB_ID}.log`), 'utf8')
    const d = JSON.parse(raw.trim())
    return { monitor_task_id: d.monitor_task_id, monitor_timeout_ms: d.monitor_timeout_ms }
}

beforeEach(async () => {
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-monitor-timeout-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
})

describe('Monitor timeout extraction (sh handler) — prefers authoritative tool_response.timeoutMs', () => {
    it('reads tool_response.timeoutMs when the agent passed no explicit timeout (the bug case)', async () => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        await runHandler(runtime, {
            hook_event_name: 'PostToolUse',
            session_id: 's1',
            cwd: '/tmp/p',
            tool_name: 'Monitor',
            tool_response: { taskId: 'bcaao0zf1', timeoutMs: 3600000, persistent: false },
        })
        expect(await emittedMonitorFields(runtime)).toEqual({
            monitor_task_id: 'bcaao0zf1',
            monitor_timeout_ms: 3600000, // was 0 (→ wrong 30-min default) before the fix
        })
    })

    it('falls back to tool_input.timeout_ms when tool_response has none', async () => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        await runHandler(runtime, {
            hook_event_name: 'PostToolUse',
            session_id: 's1',
            cwd: '/tmp/p',
            tool_name: 'Monitor',
            tool_response: { taskId: 'taskA' },
            tool_input: { timeout_ms: 5000 },
        })
        expect(await emittedMonitorFields(runtime)).toEqual({ monitor_task_id: 'taskA', monitor_timeout_ms: 5000 })
    })

    it('prefers tool_response.timeoutMs over tool_input.timeout_ms when both are present', async () => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        await runHandler(runtime, {
            hook_event_name: 'PostToolUse',
            session_id: 's1',
            cwd: '/tmp/p',
            tool_name: 'Monitor',
            tool_response: { taskId: 'taskB', timeoutMs: 3600000 },
            tool_input: { timeout_ms: 5000 },
        })
        expect((await emittedMonitorFields(runtime)).monitor_timeout_ms).toBe(3600000)
    })
})
