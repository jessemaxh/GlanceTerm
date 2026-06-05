import { PasteAdapter, PasteArgs, PasteResult } from './adapter'
import type { AiTool } from '../../tab-monitor'

/**
 * Claude Code (CLI) accepts image attachments by either:
 *
 *   (a) pasting the file path as text into the prompt — Claude detects an
 *       image-looking path and reads the file when the prompt is submitted,
 *   (b) actual binary paste of an image via the OS clipboard (works in
 *       iTerm/Terminal.app on macOS only).
 *
 * (a) is the only fully cross-platform path, so that's what we ship. We type
 * the path with a trailing space (NO newline) so the user can append their
 * own message before hitting Enter — same UX as drag-dropping a file onto
 * the Claude prompt.
 *
 * Path is shell-quoted (`'…'` with embedded `'` escaped POSIX-style;
 * `"…"` on Windows because cmd doesn't honour single quotes). Claude's
 * argument parser handles either.
 */
export class ClaudePasteAdapter implements PasteAdapter {
    readonly id: AiTool = 'claude'
    readonly displayName = 'Claude Code'

    async paste (args: PasteArgs): Promise<PasteResult> {
        const text = quoteForShell(args.filePath) + ' '
        ;(args.tab as any).sendInput?.(text)
        return {
            summary: `Pasted screenshot path into Claude Code (${args.filePath}). Press Enter to send.`,
            written: true,
        }
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
