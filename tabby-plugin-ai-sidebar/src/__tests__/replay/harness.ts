/**
 * Layer 2 test harness — drives HookWatcherService from synthetic or
 * captured NDJSON traces without touching the filesystem, without
 * needing Angular DI, and without standing up the renderer.
 *
 * What it covers:
 *   - Replays one fixture line at a time so a spec can assert state
 *     after specific events (e.g. "phantom SubagentStop doesn't pop").
 *   - Skips the watcher's start() side effects (fs.watch, periodic
 *     rescan, hooks dir create), so a CI run leaves no file artefacts
 *     and runs in milliseconds.
 *   - Resets startupTs to 0 so fixture timestamps from years ago still
 *     pass the staleness gate that gates counter mutations on the real
 *     `Date.now()`-derived value.
 *
 * Design intent: this is the seam Layer 3 (CDP-driven E2E) will plug
 * into a different driver (renderer + real watcher fed from real
 * Tabby tabs). Tests stay declarative; the harness is the only piece
 * that knows how to talk to one transport vs another.
 */

import * as fs from 'fs'
import * as path from 'path'

import { HookAdapterRegistry } from '../../hook-adapters/registry'
import type { HookRuntimeService } from '../../hook-runtime.service'
import { HookWatcherService, HookSnapshot } from '../../hook-watcher.service'

/**
 * Shape of one NDJSON line the on-disk handler writes. Kept as a wide
 * type because fixtures are authored by hand and may omit optional
 * fields the runtime would populate; the real `HookStatusFile`
 * interface inside hook-watcher.service.ts is the same shape but
 * private. Mirrored here so tests can construct events without
 * exposing the production interface.
 */
export interface TraceEvent {
    tab_id: string
    agent: string
    event: string
    matcher?: string
    tool_name?: string
    session_id?: string
    cwd?: string
    ts: number
    bg?: 0 | 1
    interrupted?: 0 | 1
    /** Top-level on subagent-context events (its tool calls, its
     *  SubagentStop). Empty / missing on main-agent events. */
    agent_id?: string
    /** Companion to agent_id — informational. */
    agent_type?: string
    /** Extracted from PostToolUse(Agent).tool_response.agentId in the
     *  real handler. Empty / missing on every other event. */
    spawn_agent_id?: string
    /** Extracted from PostToolUse(Monitor).tool_response.{taskId,task_id}
     *  in the real handler. Empty / missing on every other event. */
    monitor_task_id?: string
    /** Extracted from PreToolUse(TaskStop).tool_input.{task_id,taskId}
     *  in the real handler. Empty / missing on every other event. */
    stop_task_id?: string
}

/**
 * Test-friendly subclass of HookWatcherService:
 *   - start() is a no-op (real version creates the hooks dir, attaches
 *     fs.watch, schedules a 30s rescan — all of which the harness
 *     replaces with explicit replay() calls).
 *   - startupTs is forced to 0 so any fixture timestamp counts as
 *     "fresh" and runs through the counter-mutation path (real value
 *     is `Date.now()` floored to the second).
 *   - replay() exposes the private processEvent() under a clean name
 *     and dispatches to the registry adapter for the event's `agent`
 *     field. Returns the same `changed` boolean processEvent does so
 *     a future test can assert "this event was a no-op for state".
 */
class ReplayWatcher extends (HookWatcherService as any) {
    async start (): Promise<void> {
        // Intentionally empty — see class docstring.
    }

    constructor (registry: HookAdapterRegistry, runtime: HookRuntimeService) {
        super(registry, runtime)
        // Force-zero the staleness gate. Done in the subclass constructor
        // because the parent set it from Date.now() before this body runs;
        // overwriting `private readonly` here is a deliberate test seam.
        ;(this as any).startupTs = 0
    }

    replay (parsed: TraceEvent): boolean {
        const reg = (this as any).registry as HookAdapterRegistry
        const adapter = reg.forTool(parsed.agent as any)
        if (!adapter) return false
        return (this as any).processEvent(parsed, adapter)
    }

    /** Direct read of the per-tab live-id set for assertions that go
     *  beyond just the count. Returns a frozen copy so tests can't
     *  mutate state by accident. */
    liveAgentIdsFor (tabId: string): ReadonlySet<string> {
        const set = (this as any).liveAgentIds.get(tabId) as Set<string> | undefined
        return new Set(set ?? [])
    }
}

/**
 * Public harness API used by spec files. Hides the DI / subclass
 * mechanics; specs deal in `process(event)` + `getSubagentInFlight()`.
 */
export class ReplayHarness {
    readonly watcher: ReplayWatcher

    constructor () {
        const registry = new HookAdapterRegistry()
        // HookWatcherService only touches `runtime` inside start() /
        // rescan paths, both of which the subclass disables. A typed
        // stub is enough — the harness will throw if a future refactor
        // makes processEvent reach into runtime.
        const runtime = {} as HookRuntimeService
        this.watcher = new ReplayWatcher(registry, runtime)
    }

    /** Feed one event through the watcher. Returns whether internal
     *  state changed — useful for asserting "phantom event was dropped
     *  on the floor". */
    process (event: TraceEvent): boolean {
        return this.watcher.replay(event)
    }

    /** Convenience: process every line in a fixture in order, without
     *  checkpoints. For specs that just want end-state assertions. */
    processAll (events: TraceEvent[]): void {
        for (const e of events) this.process(e)
    }

    getSubagentInFlight (tabId: string): number {
        return this.watcher.getSubagentInFlight(tabId)
    }

    getMonitorInFlight (tabId: string): number {
        return this.watcher.getMonitorInFlight(tabId)
    }

    getStatus (tabId: string): HookSnapshot | null {
        return this.watcher.getStatus(tabId)
    }

    liveAgentIdsFor (tabId: string): ReadonlySet<string> {
        return this.watcher.liveAgentIdsFor(tabId)
    }
}

/**
 * Load and parse an NDJSON fixture file by name. Fixtures live in a
 * fixed location relative to the package root (`src/__tests__/replay/
 * fixtures/`); vitest runs from the package directory so process.cwd()
 * resolves correctly. Skips blank lines so fixtures can be visually
 * grouped with empty separators.
 *
 * Authoring choice over import.meta-relative resolution: the root
 * tsconfig still targets module=es2015 for the production bundle,
 * which forbids import.meta. A fixed lookup directory keeps tests
 * portable across both the bundler-built and ts-node-direct paths.
 */
export function loadFixture (name: string): TraceEvent[] {
    const fullPath = path.resolve(process.cwd(), 'src/__tests__/replay/fixtures', name)
    const raw = fs.readFileSync(fullPath, 'utf8')
    return raw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as TraceEvent)
}
