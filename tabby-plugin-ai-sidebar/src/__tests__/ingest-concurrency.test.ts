import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { HookAdapterRegistry } from '../hook-adapters/registry'
import { HookRuntimeService } from '../hook-runtime.service'
import { HookWatcherService } from '../hook-watcher.service'

/**
 * fs.watch fires `void this.ingest(...)` per event without awaiting. Without a
 * per-file guard, two concurrent passes over one file both snapshot the same
 * tailOffset (0) and process the same line twice — the one non-idempotent
 * effect being a DOUBLE pendingBgArrivals push (→ transient `· N shell`
 * over-count). The ingestInFlight guard serializes per file and coalesces
 * concurrent calls into a single re-run.
 *
 * Subclass disables start() (no fs.watch, no cold-load) and zeroes the
 * staleness gate, so ONLY the test's two explicit ingest() calls touch the
 * file — otherwise the watcher's own cold-load / fs.watch would race them and
 * make the assertion flaky.
 */
class NoStartWatcher extends (HookWatcherService as any) {
    async start (): Promise<void> { /* no-op: skip fs.watch + cold-load */ }
    constructor (registry: HookAdapterRegistry, runtime: HookRuntimeService) {
        super(registry, runtime)
        ;(this as any).startupTs = 0
    }
}

const TAB = '55555555-5555-4555-8555-555555555555'
let oldHome: string | undefined
let oldUserProfile: string | undefined
let tempHome: string

function line (event: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        tab_id: TAB, agent: 'claude', event, matcher: '', tool_name: '',
        session_id: 's', cwd: '/tmp', transcript_path: '',
        ts: Math.floor(Date.now() / 1000), bg: 0, agent_id: '', agent_type: '',
        spawn_agent_id: '', monitor_task_id: '', stop_task_id: '', ...extra,
    }) + '\n'
}

beforeEach(async () => {
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'glanceterm-ingest-conc-'))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
})

afterEach(async () => {
    process.env.HOME = oldHome
    process.env.USERPROFILE = oldUserProfile
    await fs.rm(tempHome, { recursive: true, force: true })
})

describe('ingest per-file concurrency guard', () => {
    it('two concurrent ingests of one file push the bg arrival only once', async () => {
        const runtime = new HookRuntimeService()
        await runtime.ensureReady()
        const watcher = new NoStartWatcher(new HookAdapterRegistry(), runtime) as unknown as {
            ingest(p: string): Promise<void>
            peekBgArrivals(t: string): number[]
            ngOnDestroy(): void
        }
        try {
            const file = path.join(runtime.stateDir, `${TAB}.log`)
            await fs.writeFile(file, line('PreToolUse', { tool_name: 'Bash', bg: 1 }))
            // Fire both BEFORE awaiting — they race on the same tailOffset.
            const p1 = watcher.ingest(file)
            const p2 = watcher.ingest(file)
            await Promise.all([p1, p2])
            expect(watcher.peekBgArrivals(TAB).length).toBe(1) // was 2 (double push) without the guard
        } finally {
            watcher.ngOnDestroy()
        }
    })
})
