import { PasteAdapter, PasteArgs, PasteResult } from './adapter'
import type { AiTool } from '../../tab-monitor'

/**
 * Claude Code (CLI) accepts image attachments by either:
 *
 *   (a) typing the file path as text into the prompt — Claude detects an
 *       image-looking path and reads the file when the prompt is submitted,
 *   (b) binary paste via the OS clipboard: put image bytes on the clipboard,
 *       send `Ctrl+V` (`\x16`); Claude reads the clipboard at the readline
 *       layer and renders its native `[Image #N]` indicator.
 *
 * We ship (b) — same UX as Ctrl+V into a Claude tab via the image-paste
 * hook ([[ImagePasteHookService]]). The placeholder is what users expect:
 * a single inline token they can interleave with their own text without
 * a wall of file path noise.
 *
 * If putting the image on the clipboard or forwarding `\x16` fails, we
 * fall back to typing the shell-quoted file path so the screenshot is
 * still reachable.
 */
export class ClaudePasteAdapter implements PasteAdapter {
    readonly id: AiTool = 'claude'
    readonly displayName = 'Claude Code'

    async paste (args: PasteArgs): Promise<PasteResult> {
        if (writePngToClipboard(args.pngBuffer)) {
            try {
                ;(args.tab as any).sendInput?.('\x16')
                return {
                    summary: 'Pasted screenshot into Claude Code as [Image]. Press Enter to send.',
                    written: true,
                }
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] claude adapter: Ctrl+V forward failed, falling back to path:', e)
            }
        }

        const text = quoteForShell(args.filePath) + ' '
        ;(args.tab as any).sendInput?.(text)
        return {
            summary: `Pasted screenshot path into Claude Code (${args.filePath}). Press Enter to send.`,
            written: true,
        }
    }
}

/**
 * Put the PNG on the OS clipboard so Claude's readline can read it on
 * `\x16`. Returns false on any failure — caller falls back to typing the
 * file path. Goes through `@electron/remote` because the renderer's local
 * clipboard API doesn't expose image writes.
 */
function writePngToClipboard (buf: Buffer): boolean {
    let remote: any
    try {
        remote = require('@electron/remote')
    } catch {
        return false
    }
    try {
        const clipboard: any = remote.getBuiltin?.('clipboard') ?? remote.clipboard
        const nativeImage: any = remote.getBuiltin?.('nativeImage') ?? remote.nativeImage
        if (!clipboard?.writeImage || !nativeImage?.createFromBuffer) return false
        const img = nativeImage.createFromBuffer(buf)
        if (!img || img.isEmpty?.()) return false
        clipboard.writeImage(img)
        return true
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[glanceterm] claude adapter: clipboard write failed:', e)
        return false
    }
}

function quoteForShell (p: string): string {
    if (process.platform === 'win32') {
        // cmd.exe / PowerShell both accept "..." — and Claude only re-parses
        // the text it receives, not via cmd, so we don't need to worry about
        // CMD's `^` escaping. Just double up embedded `"`.
        return '"' + p.replaceAll('"', '""') + '"'
    }
    // POSIX: wrap in single quotes; close-reopen around any embedded single
    // quote. e.g. `it's` → `'it'"'"'s'`.
    return "'" + p.replaceAll("'", "'\"'\"'") + "'"
}
