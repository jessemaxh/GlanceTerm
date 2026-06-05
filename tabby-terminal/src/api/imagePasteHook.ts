import { InjectionToken } from '@angular/core'

/**
 * Minimal slice of a terminal tab the image-paste hook needs. Defined here
 * (rather than importing the full BaseTerminalTabComponent) so plugins
 * providing the hook don't pick up a build-time dependency on the terminal's
 * internals — only `sendInput` matters.
 */
export interface ImagePasteTarget {
    sendInput (data: string | Buffer): void
}

/**
 * Optional extension point for the terminal's `paste()` flow.
 *
 * Wired-up flow (see `baseTerminalTab.component.ts paste()`):
 *
 *   1. paste() is invoked (keyboard shortcut, right-click menu, middle-click,
 *      or programmatic).
 *   2. If a hook is injected, paste() calls `hook.tryHandle(this)` FIRST.
 *   3. The hook inspects the system clipboard. If it sees a payload it can
 *      handle (typically: an image — saved to a temp file, then the path
 *      gets typed into the terminal), it returns `true` and the default
 *      text-paste pipeline is skipped.
 *   4. If the hook returns `false`, paste() falls through to the normal
 *      `platform.readClipboard()` text path — fully backwards-compatible.
 *
 * Why a hook instead of inline image-clipboard code in paste():
 *   - Image-paste logic needs filesystem access + the Electron clipboard's
 *     image API, both of which belong in an electron-aware plugin, not in
 *     the platform-agnostic tabby-terminal package.
 *   - Keeps tabby-terminal's vendored change small (~one conditional in
 *     `paste()`), which makes upstream rebases cheap.
 *
 * Implemented in tabby-plugin-ai-sidebar (`ImagePasteHookService`). At most
 * one hook is wired today (DI `@Optional()` single binding); if multiple
 * sources need to inject hooks in the future, switch to a `multi: true`
 * provider and chain the calls in `paste()`.
 */
export interface ImagePasteHook {
    /**
     * @returns true if the hook fully handled the paste (terminal should NOT
     *          fall through to text-clipboard paste); false to let the
     *          default text path run.
     */
    tryHandle (tab: ImagePasteTarget): Promise<boolean>
}

export const IMAGE_PASTE_HOOK = new InjectionToken<ImagePasteHook>('IMAGE_PASTE_HOOK')
