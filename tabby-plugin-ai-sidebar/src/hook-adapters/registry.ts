import { Injectable } from '@angular/core'

import type { AiTool } from '../tab-monitor'
import { HookAdapter } from './adapter'
import { ClaudeHookAdapter } from './claude'
import { CodexHookAdapter } from './codex'
import { GeminiHookAdapter } from './gemini'
import { OpencodeHookAdapter } from './opencode'

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
        // Codex: status detection + auto-approve (Codex added hook-driven
        // PermissionRequest allow/deny in PR #17563, same decision JSON as
        // Claude — verified against codex-rs source 2026-06-10). UNTESTED
        // end-to-end — adapter written from Codex hooks docs. See codex.ts.
        ['codex',  new CodexHookAdapter()],
        // Gemini CLI: working/idle status via shell hooks in
        // ~/.gemini/settings.json (BeforeAgent/AfterAgent). UNTESTED
        // end-to-end, but the tab-id routing is source-confirmed (gemini runs
        // hooks via `bash -c` with the full env, so "$GLANCETERM_TAB_ID"
        // expands). See gemini.ts head comment. needs_permission + auto-approve
        // are not supported (see the matrix).
        ['gemini', new GeminiHookAdapter()],
        // opencode: status via a shipped JS plugin (no config-file shell
        // hook). Routing is clean — the plugin runs in opencode's process and
        // reads GLANCETERM_TAB_ID from process.env directly. UNTESTED; the
        // global plugin dir name + event firing are the validation points.
        // See opencode.ts head comment.
        ['opencode', new OpencodeHookAdapter()],
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
