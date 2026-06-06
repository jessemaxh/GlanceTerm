import { Injectable } from '@angular/core'

import { HookAdapterRegistry } from './hook-adapters/registry'
import { HookRuntimeService } from './hook-runtime.service'
import { claudeConfigDirExistsSync } from './hook-adapters/claude'
import { codexConfigDirExistsSync } from './hook-adapters/codex'
import type { HookAdapter } from './hook-adapters/adapter'
import type { AiTool } from './tab-monitor'

/**
 * On boot, walks every registered HookAdapter and ensures its hook entries
 * are present in the agent's settings file. Idempotent — subsequent launches
 * detect existing entries and no-op.
 *
 * Pre-install gating (issue M6 in the v0.2 review):
 *   We only mutate an agent's config when that agent has clearly been used
 *   on this machine — for Claude, that means `~/.claude/` already exists as
 *   a directory. Without this gate, GlanceTerm would create `~/.claude/` on
 *   first launch for users who don't even have Claude installed, which can
 *   confuse Claude's first-run wizard later.
 *
 *   Users who install Claude AFTER GlanceTerm: re-launch GlanceTerm (or use
 *   tab-monitor's runtime detection — see `installFor`) to wire up hooks.
 *
 * Concurrency:
 *   Each adapter's installHooks() is itself protected by a per-settings-file
 *   advisory lock (see hook-adapters/claude.ts:withFileLock). The lock makes
 *   two concurrent Tabby launches safe — both serialize on the same lock
 *   and the second observes the first's writes via the post-lock re-read.
 *
 * Failure policy:
 *   Each adapter's failure is isolated. A malformed Claude settings.json
 *   doesn't block Codex install (when we ship one) and vice versa.
 */
@Injectable({ providedIn: 'root' })
export class HookInstallerService {
    constructor (
        private registry: HookAdapterRegistry,
        private runtime: HookRuntimeService,
    ) {
        void this.installAll()
    }

    /** Install hooks for every adapter whose pre-install gate passes. */
    private async installAll (): Promise<void> {
        try {
            await this.runtime.ensureReady()
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] hook runtime setup failed:', e?.message ?? e)
            return
        }

        for (const adapter of this.registry.all()) {
            await this.tryInstall(adapter)
        }
    }

    /**
     * Public hook for TabMonitor: when it detects an AI tool running in a
     * tab but `isInstalled()` is false (e.g. user installed Claude after
     * GlanceTerm), trigger a one-shot install attempt. Idempotent and lock-
     * protected, so it's safe to call from any code path.
     */
    async installFor (tool: AiTool): Promise<void> {
        const adapter = this.registry.forTool(tool)
        if (!adapter) return
        await this.tryInstall(adapter)
    }

    private async tryInstall (adapter: HookAdapter): Promise<void> {
        if (!this.gatePasses(adapter)) {
            // Quiet log — common case: user has GlanceTerm but not this agent.
            // eslint-disable-next-line no-console
            console.log(`[glanceterm] skipping ${adapter.displayName} hook install — agent not detected on this machine yet`)
            return
        }
        try {
            const command = this.runtime.handlerInvocation(adapter.id)
            const result = await adapter.installHooks(command)
            if (result.installed) {
                // eslint-disable-next-line no-console
                console.log(`[glanceterm] installed ${adapter.displayName} hooks → ${result.settingsPath}`)
            }
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error(`[glanceterm] could not install ${adapter.displayName} hooks:`, e?.message ?? e)
        }
    }

    /**
     * Per-adapter "is this agent established on the machine" check. Each
     * adapter would ideally expose its own gate as a method on HookAdapter,
     * but with a 2-entry switch the indirection isn't earning its keep yet.
     * When a third gate lands, move this to `adapter.installedOnMachine()`.
     */
    private gatePasses (adapter: HookAdapter): boolean {
        switch (adapter.id) {
            case 'claude': return claudeConfigDirExistsSync()
            case 'codex':  return codexConfigDirExistsSync()
            default: return false       // unknown adapter — fail closed
        }
    }
}
