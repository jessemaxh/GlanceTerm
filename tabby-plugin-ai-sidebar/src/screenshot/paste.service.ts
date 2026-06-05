import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { AppService, BaseTabComponent, NotificationsService } from 'tabby-core'

import type { AiTool, TabState } from '../tab-monitor'
import { TabMonitor } from '../tab-monitor'
import { PasteAdapter } from './adapters/adapter'
import { ClaudePasteAdapter } from './adapters/claude'
import { GenericPasteAdapter } from './adapters/generic'

/**
 * Owns the "screenshot exists — now what" half of the flow.
 *
 * Responsibilities:
 *   1. Pick the target terminal tab (focused leaf, fallback to most recent
 *      AI tab).
 *   2. Write the PNG to `~/.glanceterm/screenshots/<ts>.png`.
 *   3. Route to the matching adapter (`AiTool` → adapter; fallback = generic).
 *   4. Show a toast describing what was pasted (or why it couldn't be).
 *
 * Adapter wiring mirrors `HookAdapterRegistry`. To add an agent, write a
 * class implementing [[PasteAdapter]] and register it in the constructor.
 */
@Injectable({ providedIn: 'root' })
export class ScreenshotPasteService {
    private readonly adapters: Map<AiTool, PasteAdapter>
    private readonly fallback: PasteAdapter = new GenericPasteAdapter()

    constructor (
        private app: AppService,
        private monitor: TabMonitor,
        private notifications: NotificationsService,
    ) {
        this.adapters = new Map<AiTool, PasteAdapter>([
            ['claude', new ClaudePasteAdapter()],
        ])
    }

    /** True if the sidebar has at least one terminal tab to paste into. */
    canPaste (): boolean {
        return this.pickTarget() !== null
    }

    async paste (pngBuffer: Buffer): Promise<void> {
        const target = this.pickTarget()
        if (!target) {
            this.notifications.error('Open a terminal first, then take a screenshot.')
            return
        }

        let filePath: string
        try {
            filePath = await this.savePng(pngBuffer)
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] failed to save screenshot:', e)
            this.notifications.error(`Couldn't save screenshot: ${e?.message ?? e}`)
            return
        }

        const adapter = (target.state.aiTool && this.adapters.get(target.state.aiTool)) || this.fallback
        try {
            // Bring the target tab to the foreground so the user sees the path
            // appear in the prompt they're about to act on. Without this the
            // sidebar's "active" tab might be a different tab than where the
            // text lands.
            this.app.selectTab(target.state.outerTab)
            if (target.state.outerTab !== target.state.innerTab) {
                try { (target.state.outerTab as any).focus?.(target.state.innerTab) } catch { /* */ }
            }

            const result = await adapter.paste({
                pngBuffer,
                filePath,
                tab: target.tab,
                state: target.state,
            })
            if (result.written) {
                this.notifications.info(result.summary)
            } else {
                this.notifications.info(`Saved screenshot to ${filePath}`)
            }
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] paste adapter failed:', e)
            this.notifications.error(`Paste failed: ${e?.message ?? e}. File saved at ${filePath}`)
        }
    }

    /**
     * Pick the terminal pane to paste into.
     *
     * Order of preference:
     *   1. Focused inner pane of the currently-active outer tab, IF it's a
     *      terminal.
     *   2. Any AI tab listed in the sidebar (rank: needs_permission → working
     *      → idle → no_ai; tabs of equal rank — most-recent activity first).
     *   3. null — caller shows a "no terminal open" toast.
     */
    private pickTarget (): { tab: BaseTabComponent; state: TabState } | null {
        const states = this.monitor.current
        if (states.length === 0) return null

        // 1. Focused outer tab match.
        const activeOuter = this.app.activeTab
        if (activeOuter) {
            const focusedInner = focusedInnerOf(activeOuter)
            const match = states.find(s => s.outerTab === activeOuter && s.innerTab === focusedInner)
                ?? states.find(s => s.outerTab === activeOuter)
            if (match) return { tab: match.innerTab, state: match }
        }

        // 2. Best AI tab. Lower rank = higher priority.
        const rank: Record<TabState['status'], number> = {
            needs_permission: 0,
            working:          1,
            idle:             2,
            no_ai:            3,
        }
        const sorted = [...states].sort((a, b) => {
            const dr = (rank[a.status] ?? 99) - (rank[b.status] ?? 99)
            if (dr !== 0) return dr
            const am = a.lastActiveMs ?? Number.MAX_SAFE_INTEGER
            const bm = b.lastActiveMs ?? Number.MAX_SAFE_INTEGER
            return am - bm
        })
        const best = sorted[0]
        return best ? { tab: best.innerTab, state: best } : null
    }

    private async savePng (buf: Buffer): Promise<string> {
        const dir = path.join(os.homedir(), '.glanceterm', 'screenshots')
        await fs.mkdir(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const filename = `screenshot-${stamp}.png`
        const filePath = path.join(dir, filename)
        await fs.writeFile(filePath, buf, { mode: 0o600 })
        return filePath
    }
}

function focusedInnerOf (outer: BaseTabComponent): BaseTabComponent {
    try {
        const fn = (outer as any).getFocusedTab
        if (typeof fn === 'function') {
            const inner = fn.call(outer)
            if (inner) return inner
        }
    } catch { /* fall through */ }
    return outer
}
