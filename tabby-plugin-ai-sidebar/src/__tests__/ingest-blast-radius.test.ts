import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import type { HookAdapterRegistry } from '../hook-adapters/registry'
import { HookRuntimeService } from '../hook-runtime.service'
import { HookWatcherService } from '../hook-watcher.service'
import { TabStatus } from '../tab-monitor'

/**
 * Blast-radius isolation: one throwing event must not abort the rest of a file's
 * lines (nor, via coldLoad, every later file). Without the per-line try/catch a
 * single poison event would stall a tab — or all tabs — forever (the freeze
 * class of bug). We inject an adapter that throws on a sentinel event and assert
 * the GOOD line after it still lands.
 */

const TAB = '66666666-6666-4666-8666-666666666666'
let oldHome: string | undefined
let oldUserProfile: string | undefined
let tempHome: string

// Adapter whose mapEventToStatus throws on the sentinel 'THROW' event.
const throwingAdapter = {
    id: 'claude',
    mapEventToStatus (event: string): TabStatus | null {
        if (event === 'THROW') throw new Error('boom — poison event')
        if (event === 'PreToolUse') return TabStatus.Working
        if (event === 'Stop') return TabStatus.Idle
        return null
    },
    signalsBgJobs () { return false },
    spawnsNativeHelper () { return false },
}
const throwingRegistry = {
    forTool: (tool: string) => (tool === 'claude' ? throwingAdapter : null),
} as unknown as HookAdapterRegistry

function line (event: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        tab_id: TAB, agent: 'claude', event, matcher: '', tool_name: '',
        session_id: 's', cwd: '/tmp', transcript_path: '',
        ts: Math.floor(Date.now() / 1000), bg: 0, agent_id: '', agent_type: '',
        spawn_agent_id: '', monitor_task_id: '', stop_task_id: '', ...extra,
    }) + '\n'
}

async function waitFor<T> (fn: () => T | null | undefined, timeoutMs = 1000): Promise<T> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const v = fn()
        if (v) return v
        await new Promise(r => setTimeout(r, 20))
    }
    throw new Error('timed out')
}

beforeEach(async () => {
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-blast-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
})

describe('ingest blast-radius: one throwing event does not abort the rest', () => {
    it('processes the good Stop line after a throwing event in the same file', async () => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        const file = path.join(runtime.stateDir, `${TAB}.log`)
        // working → (poison) → idle. If the throw aborted the loop, status would
        // stay Working (Stop never processed).
        await fs.writeFile(file, line('PreToolUse', { tool_name: 'Bash' }) + line('THROW') + line('Stop'))

        const watcher = new HookWatcherService(throwingRegistry, runtime)
        try {
            const snap = await waitFor(() => watcher.getStatus(TAB))
            expect(snap.status).toBe(TabStatus.Idle) // Stop landed despite the poison line before it
        } finally {
            watcher.ngOnDestroy()
        }
    })
})
