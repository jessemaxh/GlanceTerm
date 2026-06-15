import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { HookAdapterRegistry } from '../hook-adapters/registry'
import { HookRuntimeService } from '../hook-runtime.service'
import { HookWatcherService } from '../hook-watcher.service'

/**
 * Long-runtime IO thrash: the on-disk handler never unlinks a closed tab's log,
 * and retainOnly drops that tab's map/tailOffset every tick. Without a gate, the
 * 30 s coldLoad rescan re-ingests every closed-tab log from offset 0 (full read
 * + parse + Buffer.alloc) only to have retainOnly drop it again — work that
 * scales with on-disk log volume. coldLoad now skips logs whose tab isn't in the
 * last live set TabMonitor reported, while the INITIAL load (live set unknown)
 * still reads everything.
 */

const CLOSED = '33333333-3333-4333-8333-333333333333'
const LIVE = '44444444-4444-4444-8444-444444444444'
let oldHome: string | undefined
let oldUserProfile: string | undefined
let tempHome: string

function line (tabId: string, event: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        tab_id: tabId, agent: 'claude', event, matcher: '', tool_name: '',
        session_id: 's', cwd: '/tmp', transcript_path: '', ts: Math.floor(Date.now() / 1000),
        bg: 0, agent_id: '', agent_type: '', spawn_agent_id: '', monitor_task_id: '', stop_task_id: '',
        ...extra,
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
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-coldload-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
})

describe('coldLoad skips closed-tab logs on the periodic rescan', () => {
    it('does NOT resurrect a closed tab once the live set is known', async () => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        await fs.writeFile(path.join(runtime.stateDir, `${CLOSED}.log`), line(CLOSED, 'PreToolUse', { tool_name: 'Bash' }))
        const watcher = new HookWatcherService(new HookAdapterRegistry(), runtime)
        try {
            // initial cold load (live set still unknown) discovers it
            await waitFor(() => watcher.getStatus(CLOSED))
            // TabMonitor reports a DIFFERENT tab as the only live one → CLOSED is gone
            watcher.retainOnly(new Set([LIVE]))
            expect(watcher.getStatus(CLOSED)).toBeFalsy()
            // a periodic rescan must NOT re-ingest the closed tab's log
            await (watcher as unknown as { coldLoad(): Promise<void> }).coldLoad()
            expect(watcher.getStatus(CLOSED)).toBeFalsy() // was re-created (thrash) before the fix
        } finally {
            watcher.ngOnDestroy()
        }
    })

    it('still re-reads a LIVE tab on rescan (fs.watch-drop recovery preserved)', async () => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        const watcher = new HookWatcherService(new HookAdapterRegistry(), runtime)
        try {
            watcher.retainOnly(new Set([LIVE])) // LIVE is the (only) live tab
            await fs.writeFile(path.join(runtime.stateDir, `${LIVE}.log`), line(LIVE, 'PreToolUse', { tool_name: 'Bash' }))
            await (watcher as unknown as { coldLoad(): Promise<void> }).coldLoad()
            // coldLoad's ingest may coalesce with the fs.watch ingest of the same
            // write (per-file serialization), so the state can land via the async
            // re-run — poll for it rather than asserting synchronously.
            expect(await waitFor(() => watcher.getStatus(LIVE))).toBeTruthy()
        } finally {
            watcher.ngOnDestroy()
        }
    })
})
