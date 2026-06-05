import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { NotificationsService } from 'tabby-core'
import { ImagePasteHook, ImagePasteTarget } from 'tabby-terminal'

import { TabMonitor, AiTool } from './tab-monitor'

/**
 * AI CLIs we believe handle binary image paste themselves: they intercept
 * `Ctrl+V` (`\x16`) at the readline layer and read the OS clipboard via their
 * own code. For these tabs we skip the "save PNG + type path" routine and
 * just forward `\x16` so the agent draws its native `[Image #N]` indicator
 * (Claude Code's behaviour in iTerm/Terminal.app).
 *
 * Conservative starting set — Claude is verified. codex/gemini believed to
 * support the same pattern but unverified on this platform; add when tested.
 */
const BINARY_PASTE_TOOLS: ReadonlySet<AiTool> = new Set(['claude'])

/**
 * Image-aware paste for ANY terminal tab — registered as the
 * `IMAGE_PASTE_HOOK` provider so it runs at the top of
 * `BaseTerminalTabComponent.paste()`.
 *
 * Behaviour:
 *   - Reads the system clipboard via Electron's `clipboard.readImage()`.
 *   - If the clipboard contains a non-empty image: serialize it as PNG,
 *     save to `~/.glanceterm/clipboard-images/<ISO timestamp>.png`
 *     (mode 0600), then type the shell-quoted path + a trailing space into
 *     the focused terminal via `tab.sendInput(...)` and return `true` so
 *     the default text-paste pipeline is skipped.
 *   - If the clipboard has no image (text-only, or empty), return `false`
 *     and let `BaseTerminalTabComponent.paste()` fall through to its
 *     original `platform.readClipboard()` flow.
 *
 * Lifecycle: each saved file is scheduled for deletion 5 minutes after
 * paste. Rationale — Claude Code (and similar AI CLIs) read the image
 * bytes lazily when the user submits the prompt, not at paste time. 5 min
 * is a comfortable margin for a user composing a message; long enough
 * that Claude reads the file before we wipe it, short enough that the
 * directory doesn't grow without bound.
 *
 * Why this lives in the AI sidebar plugin (not in tabby-electron or
 * tabby-terminal): the image-paste behaviour was added for the AI-agent
 * workflow ("circle a thing, paste into Claude"). Keeping it here makes
 * the dependency direction clear and means the tabby-terminal vendored
 * change stays a single conditional in `paste()` regardless of how this
 * implementation evolves.
 *
 * Cross-platform: works on macOS, Linux, Windows — `clipboard.readImage()`
 * + `toPNG()` is uniform across all three. Path quoting branches on
 * `process.platform` for cmd/PowerShell vs POSIX shells.
 */
@Injectable({ providedIn: 'root' })
export class ImagePasteHookService implements ImagePasteHook {
    private readonly dir = path.join(os.homedir(), '.glanceterm', 'clipboard-images')

    constructor (
        private notifications: NotificationsService,
        private monitor: TabMonitor,
    ) {}

    async tryHandle (tab: ImagePasteTarget): Promise<boolean> {
        const png = readClipboardPng()
        if (!png) return false

        // Fast-path for AI agents that read the OS clipboard themselves: just
        // forward `Ctrl+V` (`\x16`). The image is already on the clipboard
        // (we got it via readClipboardPng), so the agent's own paste handler
        // will pick it up and render its native `[Image #N]` indicator. No
        // temp file, no path text.
        const aiTool = this.findAiToolForTab(tab)
        if (aiTool && BINARY_PASTE_TOOLS.has(aiTool)) {
            try {
                tab.sendInput('\x16')
                // eslint-disable-next-line no-console
                console.log(`[glanceterm] image-paste: forwarded Ctrl+V to ${aiTool}`)
            } catch (e: any) {
                // eslint-disable-next-line no-console
                console.error('[glanceterm] image-paste: Ctrl+V forward failed:', e)
                this.notifications.error(`Couldn't pass image to ${aiTool}: ${e?.message ?? e}`)
            }
            return true
        }

        let filePath: string
        try {
            filePath = await this.saveTempPng(png)
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] image-paste: failed to save temp PNG:', e)
            this.notifications.error(`Could not save pasted image: ${e?.message ?? e}`)
            // Returning true here even though we couldn't save: if we returned
            // false, paste() would fall through to text-clipboard, but the
            // text clipboard is the image's bitmap markup which would dump
            // garbage into the terminal. Better to no-op than to garble.
            return true
        }

        try {
            tab.sendInput(quoteForShell(filePath) + ' ')
            this.scheduleCleanup(filePath)
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] image-paste: sendInput failed:', e)
            this.notifications.error(`Couldn't insert image path: ${e?.message ?? e}. File saved at ${filePath}`)
        }
        return true
    }

    /**
     * Match the paste target against TabMonitor's current snapshot. Reference
     * equality on `innerTab` works because both are the same
     * `BaseTerminalTabComponent` instance — the monitor stores the live tab
     * objects, and `paste()` passes `this` as the ImagePasteTarget.
     *
     * Returns null when the tab isn't an AI tab (or TabMonitor hasn't seen
     * it yet — first poll within ~1.5s of spawn).
     */
    private findAiToolForTab (tab: ImagePasteTarget): AiTool | null {
        const states = this.monitor.current
        const match = states.find(s => (s.innerTab as unknown) === tab)
        return match?.aiTool ?? null
    }

    private async saveTempPng (buf: Buffer): Promise<string> {
        await fs.mkdir(this.dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const filePath = path.join(this.dir, `clip-${stamp}.png`)
        await fs.writeFile(filePath, buf, { mode: 0o600 })
        return filePath
    }

    /**
     * Delete the temp file 5 minutes after paste. Window picked to outlast
     * "user is composing a long Claude prompt" without leaking files
     * indefinitely. Errors are logged but swallowed — a stuck file is a
     * minor disk-space issue, not a user-facing fault.
     */
    private scheduleCleanup (filePath: string): void {
        const FIVE_MINUTES_MS = 5 * 60 * 1000
        setTimeout(() => {
            void fs.unlink(filePath).catch(e => {
                // ENOENT is fine — user (or another sweeper) already removed it.
                if (e?.code !== 'ENOENT') {
                    // eslint-disable-next-line no-console
                    console.warn(`[glanceterm] image-paste: cleanup failed for ${filePath}:`, e)
                }
            })
        }, FIVE_MINUTES_MS).unref?.()
    }
}

/**
 * Pull a non-empty PNG from the Electron clipboard, or null if there's no
 * image. We go through `@electron/remote` because this runs in the renderer
 * and the renderer's local `clipboard` API only handles text/HTML — image
 * reads are exposed via the main-process clipboard module.
 *
 * Returns null (rather than throwing) for ALL failure modes — missing
 * remote, isEmpty image, exception — because the caller treats null as
 * "no image, fall through to text paste".
 */
function readClipboardPng (): Buffer | null {
    let remote: any
    try {
        remote = require('@electron/remote')
    } catch {
        return null
    }
    try {
        const clipboard: any = remote.getBuiltin?.('clipboard') ?? remote.clipboard
        if (!clipboard?.readImage) return null
        const img = clipboard.readImage()
        if (!img || img.isEmpty?.()) return null
        const png: Buffer = img.toPNG()
        return png && png.length > 0 ? png : null
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[glanceterm] image-paste: clipboard read failed:', e)
        return null
    }
}

function quoteForShell (p: string): string {
    if (process.platform === 'win32') {
        // cmd / PowerShell — "..." with doubled embedded quotes. Claude
        // Code reparses the text Itself, not via cmd, so we don't need
        // CMD's `^` escapes.
        return '"' + p.replaceAll('"', '""') + '"'
    }
    // POSIX: single-quote everything, close-and-reopen around embedded
    // single quotes: `it's` → `'it'"'"'s'`.
    return "'" + p.replaceAll("'", "'\"'\"'") + "'"
}
