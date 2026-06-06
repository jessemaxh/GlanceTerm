import { Injectable } from '@angular/core'

import type { AiTool } from '../tab-monitor'
import { HookAdapter } from './adapter'
import { ClaudeHookAdapter } from './claude'
import { CodexHookAdapter } from './codex'

/**
 * Single point that hands out HookAdapter instances by tool id. The whole
 * pipeline (installer, watcher, tab monitor) routes through here so adding
 * a new agent later means:
 *
 *   1. write `hook-adapters/codex.ts` implementing HookAdapter
 *   2. add one line below
 *
 * No edits to the watcher, installer, or sidebar.
 */
@Injectable({ providedIn: 'root' })
export class HookAdapterRegistry {
    private readonly adapters: Map<AiTool, HookAdapter> = new Map<AiTool, HookAdapter>([
        ['claude', new ClaudeHookAdapter()],
        // Codex: status detection only — auto-approve not supported by
        // Codex's hook output schema (PermissionRequest doesn't accept the
        // decision JSON the way Claude's does). UNTESTED — adapter written
        // from Codex hooks docs, see codex.ts head comment.
        ['codex',  new CodexHookAdapter()],
        // Future:
        // ['gemini', new GeminiHookAdapter()],
    ])

    /** All adapters in registration order. */
    all (): HookAdapter[] {
        return Array.from(this.adapters.values())
    }

    /** Lookup by tool id; null if this tool isn't hook-supported (yet). */
    forTool (tool: AiTool | null): HookAdapter | null {
        if (!tool) return null
        return this.adapters.get(tool) ?? null
    }

    /** True if this tool has a registered adapter — i.e. we can show fine-grained status. */
    supports (tool: AiTool | null): boolean {
        return !!tool && this.adapters.has(tool)
    }
}
