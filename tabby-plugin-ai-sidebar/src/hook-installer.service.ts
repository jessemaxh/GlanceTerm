import { Injectable } from '@angular/core'
import { NotificationsService } from 'tabby-core'

import { HookAdapterRegistry } from './hook-adapters/registry'
import { HookRuntimeService } from './hook-runtime.service'
import { claudeConfigDirExistsSync } from './hook-adapters/claude'
import { codexConfigDirExistsSync } from './hook-adapters/codex'
import { geminiConfigDirExistsSync } from './hook-adapters/gemini'
import { opencodeConfigDirExistsSync } from './hook-adapters/opencode'
import type { HookAdapter, InstallReport } from './hook-adapters/adapter'
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
        private notifications: NotificationsService,
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
        const report = await this.tryInstall(adapter)

        // Runtime path only: tab-monitor calls installFor() because it just
        // saw this agent's PROCESS running. If we wrote FRESH hook entries
        // just now (installed === true), that in-flight session started before
        // the hooks existed and won't emit events until it restarts — the
        // agent reads its settings file once at session start. Surface a
        // one-shot notice so the first "no status" session isn't a mystery.
        //
        // This never fires at boot: installAll() ignores tryInstall()'s return,
        // and once hooks are present a re-fire reports installed === false. So
        // it shows exactly in the "installed agent AFTER GlanceTerm, then ran
        // it without relaunching" case — the one rough edge of that ordering.
        if (report?.installed) {
            this.notifications.info(
                `已为 ${adapter.displayName} 配置好 GlanceTerm hook`,
                '正在运行的会话需重开后才会加载 hook；之后启动的会话自动生效。',
            )
        }
    }

    private async tryInstall (adapter: HookAdapter): Promise<InstallReport | null> {
        if (!this.gatePasses(adapter)) {
            // Quiet log — common case: user has GlanceTerm but not this agent.
            // eslint-disable-next-line no-console
            console.log(`[glanceterm] skipping ${adapter.displayName} hook install — agent not detected on this machine yet`)
            return null
        }
        try {
            const command = this.runtime.handlerInvocation(adapter.id)
            const result = await adapter.installHooks(command)
            if (result.installed) {
                // eslint-disable-next-line no-console
                console.log(`[glanceterm] installed ${adapter.displayName} hooks → ${result.settingsPath}`)
            }
            return result
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error(`[glanceterm] could not install ${adapter.displayName} hooks:`, e?.message ?? e)
            return null
        }
    }

    /**
     * Per-adapter "is this agent established on the machine" check. Each
     * adapter would ideally expose its own gate as a method on HookAdapter;
     * now at three entries (claude/codex/gemini) this switch is a candidate
     * to move to `adapter.installedOnMachine()` — left inline for now since
     * each gate is a one-liner and the indirection would spread the logic
     * across three more files. Refactor when the 4th lands.
     */
    private gatePasses (adapter: HookAdapter): boolean {
        switch (adapter.id) {
            case 'claude': return claudeConfigDirExistsSync()
            case 'codex':  return codexConfigDirExistsSync()
            case 'gemini': return geminiConfigDirExistsSync()
            case 'opencode': return opencodeConfigDirExistsSync()
            default: return false       // unknown adapter — fail closed
        }
    }
}
