import type { BaseTabComponent } from 'tabby-core'

import type { AiTool, TabState } from '../../tab-monitor'

/**
 * Per-agent contract for "user just took a screenshot — get it into the
 * agent's prompt." Mirrors the hook-adapter pattern in `hook-adapters/`:
 * one adapter per AI tool, registry routes by `AiTool` id.
 *
 * v1 ships [[ClaudePasteAdapter]] + a [[GenericPasteAdapter]] fallback. As
 * each new agent is wired we add a class here. See [[screenshot-feature-spec]]
 * for the feature-wide design.
 */
export interface PasteAdapter {
    readonly id: AiTool | 'generic'
    readonly displayName: string

    /**
     * Deliver the screenshot to the AI agent running in this tab. Implementers
     * usually save the PNG somewhere stable and write the resulting path (or
     * an agent-specific token like `@path`) into the terminal's input buffer
     * via `tab.sendInput(text)`.
     *
     * MUST NOT auto-submit (no trailing newline). The user should review the
     * pasted content and press Enter themselves.
     */
    paste (args: PasteArgs): Promise<PasteResult>
}

export interface PasteArgs {
    /** Cropped + annotated screenshot bytes. */
    pngBuffer: Buffer
    /** Stable on-disk path where the PNG has been written (see directory layout below). */
    filePath: string
    /** The terminal tab to write into. */
    tab: BaseTabComponent
    /** The full TabState (lets adapters branch on tool, awaitingFirstEvent, cwd, …). */
    state: TabState
}

export interface PasteResult {
    /** Human-readable message for the toast/log. */
    summary: string
    /** True if input was written to the terminal; false if the adapter no-oped. */
    written: boolean
}
