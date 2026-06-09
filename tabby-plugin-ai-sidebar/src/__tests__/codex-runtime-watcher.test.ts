import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { HookAdapterRegistry } from '../hook-adapters/registry'
import { HookRuntimeService } from '../hook-runtime.service'
import { HookWatcherService } from '../hook-watcher.service'
import { TabStatus } from '../tab-monitor'

const TAB_ID = '11111111-1111-4111-8111-111111111111'

let oldHome: string | undefined
let oldUserProfile: string | undefined
let tempHome: string

async function waitFor<T> (fn: () => T | null | undefined, timeoutMs = 1000): Promise<T> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const value = fn()
        if (value) return value
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('timed out waiting for condition')
}

function makeRuntime (): HookRuntimeService {
    return new HookRuntimeService()
}

function makeWatcher (runtime: HookRuntimeService): HookWatcherService {
    return new HookWatcherService(new HookAdapterRegistry(), runtime)
}

function logLine (event: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        tab_id: TAB_ID,
        agent: 'codex',
        event,
        matcher: '',
        tool_name: '',
        session_id: 'codex-session-1',
        cwd: '/tmp/project',
        transcript_path: '',
        ts: Math.floor(Date.now() / 1000),
        bg: 0,
        agent_id: '',
        agent_type: '',
        spawn_agent_id: '',
        monitor_task_id: '',
        stop_task_id: '',
        ...extra,
    }) + '\n'
}

async function runHandler (runtime: HookRuntimeService, payload: unknown): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
        const child = spawn(runtime.shHandlerPath, ['codex'], {
            env: {
                ...process.env,
                HOME: tempHome,
                GLANCETERM_TAB_ID: TAB_ID,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.on('error', reject)
        child.on('close', code => {
            if (code === 0) resolve({ stdout, stderr })
            else reject(new Error(`handler exited ${code}: ${stderr}`))
        })
        child.stdin.end(JSON.stringify(payload))
    })
}

beforeEach(async () => {
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-codex-runtime-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
})

describe('HookRuntimeService — Codex handler', () => {
    it('writes a Codex hook payload to the per-tab NDJSON log', async () => {
        const runtime = makeRuntime()
        await runtime.ensureReady()

        await runHandler(runtime, {
            hook_event_name: 'PreToolUse',
            session_id: 'codex-session-1',
            cwd: '/tmp/project',
            tool_name: 'Bash',
        })

        const raw = await fs.readFile(path.join(runtime.stateDir, `${TAB_ID}.log`), 'utf8')
        const parsed = JSON.parse(raw.trim())
        expect(parsed).toMatchObject({
            tab_id: TAB_ID,
            agent: 'codex',
            event: 'PreToolUse',
            session_id: 'codex-session-1',
            cwd: '/tmp/project',
            tool_name: 'Bash',
        })
    })

    it('does not emit Claude auto-approve output for Codex PermissionRequest', async () => {
        const runtime = makeRuntime()
        await runtime.ensureReady()
        await fs.writeFile(path.join(runtime.root, 'auto-approve.flag'), '1')

        const { stdout } = await runHandler(runtime, {
            hook_event_name: 'PermissionRequest',
            session_id: 'codex-session-1',
            cwd: '/tmp/project',
            tool_name: 'Bash',
        })

        expect(stdout).toBe('')
        const raw = await fs.readFile(path.join(runtime.stateDir, `${TAB_ID}.log`), 'utf8')
        expect(JSON.parse(raw.trim())).toMatchObject({
            agent: 'codex',
            event: 'PermissionRequest',
        })
    })
})

describe('HookWatcherService — Codex logs', () => {
    it('cold-loads a Codex log and exposes a working snapshot', async () => {
        const runtime = makeRuntime()
        await runtime.ensureReady()
        await fs.writeFile(path.join(runtime.stateDir, `${TAB_ID}.log`), logLine('PreToolUse', {
            tool_name: 'Bash',
        }))

        const watcher = makeWatcher(runtime)
        try {
            const snapshot = await waitFor(() => watcher.getStatus(TAB_ID))
            expect(snapshot).toMatchObject({
                tabId: TAB_ID,
                tool: 'codex',
                status: TabStatus.Working,
                sessionId: 'codex-session-1',
                cwd: '/tmp/project',
            })
        } finally {
            watcher.ngOnDestroy()
        }
    })

    it('updates Codex status from working to needs_permission to idle as new log lines arrive', async () => {
        const runtime = makeRuntime()
        await runtime.ensureReady()
        const file = path.join(runtime.stateDir, `${TAB_ID}.log`)
        await fs.writeFile(file, logLine('PreToolUse'))
        const watcher = makeWatcher(runtime)

        try {
            await waitFor(() => watcher.getStatus(TAB_ID)?.status === TabStatus.Working ? true : null)

            await fs.appendFile(file, logLine('PermissionRequest'))
            await waitFor(() => watcher.getStatus(TAB_ID)?.status === TabStatus.NeedsPermission ? true : null)

            await fs.appendFile(file, logLine('Stop'))
            await waitFor(() => watcher.getStatus(TAB_ID)?.status === TabStatus.Idle ? true : null)
        } finally {
            watcher.ngOnDestroy()
        }
    })
})
