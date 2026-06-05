import { PasteAdapter, PasteArgs, PasteResult } from './adapter'

/**
 * Fallback adapter used when:
 *   - the focused tab has no AI tool (`state.aiTool === null`), OR
 *   - the focused tab's tool has no registered adapter yet (codex, gemini,
 *     opencode, aider, goose — until they get their own).
 *
 * Behaviour matches [[ClaudePasteAdapter]]: writes a shell-quoted path with
 * a trailing space, no newline. Most CLI agents will at least let the user
 * see "here is a path you can refer to"; the per-agent adapters will
 * eventually replace this with whatever native attachment syntax each one
 * supports.
 */
export class GenericPasteAdapter implements PasteAdapter {
    readonly id = 'generic' as const
    readonly displayName = 'Terminal'

    async paste (args: PasteArgs): Promise<PasteResult> {
        const text = quoteForShell(args.filePath) + ' '
        ;(args.tab as any).sendInput?.(text)
        return {
            summary: `Saved screenshot to ${args.filePath} and inserted path into the terminal.`,
            written: true,
        }
    }
}

function quoteForShell (p: string): string {
    if (process.platform === 'win32') {
        return '"' + p.replaceAll('"', '""') + '"'
    }
    return "'" + p.replaceAll("'", "'\"'\"'") + "'"
}
