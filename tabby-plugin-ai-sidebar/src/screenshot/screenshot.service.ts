import { Injectable } from '@angular/core'

import { NotificationsService } from 'tabby-core'

import { openCaptureWindow, CaptureResult } from './capture-window'

/**
 * Public surface used by the sidebar button.
 *
 * `capture()` does the full flow: hide the main GlanceTerm window (so it
 * doesn't appear in the screenshot), grab the primary display via
 * `desktopCapturer`, hand it to the overlay window, await the user's
 * confirm/cancel, then restore the main window. Returns a Node Buffer of the
 * cropped PNG, or null on cancel.
 *
 * Multi-display support: v1 captures the display where the GlanceTerm window
 * currently lives (`screen.getDisplayMatching(window.bounds)`). A user with
 * multiple monitors capturing on the "wrong" one can drag GlanceTerm to the
 * monitor they want first. Spanning all displays at once is left as a v2.
 */
@Injectable({ providedIn: 'root' })
export class ScreenshotService {
    private inProgress = false

    constructor (private notifications: NotificationsService) {}

    /**
     * Run a screenshot session. Returns the PNG bytes on confirm, null on
     * cancel or any error. Errors surface as a toast AND a console log — the
     * button caller doesn't need to wrap this in try/catch, but the user
     * still gets feedback when something blew up (otherwise the click looks
     * like a no-op).
     */
    async capture (): Promise<{ buffer: Buffer; ext: 'png' } | null> {
        if (this.inProgress) return null
        this.inProgress = true

        // Grab Electron pieces via the renderer's `@electron/remote` bridge —
        // same pattern tabby-electron's ElectronService uses. We resolve here
        // (rather than in module init) so the plugin still loads cleanly in
        // hypothetical non-Electron hosts (tabby-web), where the button just
        // ends up no-oping with a console warning instead of crashing import.
        //
        // IMPORTANT: don't use `remote.require('electron')` — Electron 38
        // dropped `process.mainModule`, so that path throws
        // "process.mainModule.require is not a function". Pull each builtin
        // we need via `remote.getBuiltin(name)` instead, which routes through
        // the main process's `require` directly.
        let remote: any
        try {
            remote = require('@electron/remote')
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] screenshot not supported (not running under Electron)')
            this.inProgress = false
            return null
        }

        let screen: any
        let desktopCapturer: any
        try {
            screen = remote.getBuiltin('screen')
            desktopCapturer = remote.getBuiltin('desktopCapturer')
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] screenshot init failed:', e)
            this.notifications.error(`Screenshot unavailable: ${e?.message ?? e}`)
            this.inProgress = false
            return null
        }

        const ourWindow: any = remote.getCurrentWindow()
        const target = this.pickDisplay(screen, ourWindow)

        const wasVisible = !ourWindow.isMinimized() && ourWindow.isVisible()
        try {
            // Hide so the GlanceTerm UI isn't in the screenshot. minimize()
            // on macOS triggers a Genie animation; hide() is instant + invisible.
            ourWindow.hide()
            // Tiny breather lets the compositor catch up before the capture
            // call — without it the screenshot can still include the window
            // frame on slow machines.
            await new Promise(r => setTimeout(r, 120))

            const screenDataURL = await this.captureDisplay(desktopCapturer, target)
            if (!screenDataURL) {
                this.notifications.error('Screenshot failed: could not capture display.')
                return null
            }

            const result: CaptureResult = await openCaptureWindow({
                displayBounds: target.bounds,
                scaleFactor: target.scaleFactor,
                screenDataURL,
                BrowserWindow: remote.BrowserWindow,
            })

            if (!result.dataURL) return null

            // Strip the data: prefix and decode.
            const m = /^data:image\/png;base64,(.*)$/.exec(result.dataURL)
            if (!m) {
                this.notifications.error('Screenshot failed: invalid image data returned.')
                return null
            }
            return { buffer: Buffer.from(m[1], 'base64'), ext: 'png' }
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('[glanceterm] screenshot failed:', e)
            this.notifications.error(`Screenshot failed: ${e?.message ?? e}`)
            return null
        } finally {
            try {
                if (wasVisible) {
                    ourWindow.show()
                    ourWindow.focus()
                }
            } catch { /* */ }
            this.inProgress = false
        }
    }

    private pickDisplay (screen: any, win: any): any {
        try {
            const bounds = win.getBounds()
            return screen.getDisplayMatching(bounds)
        } catch {
            return screen.getPrimaryDisplay()
        }
    }

    /**
     * Capture one display via `desktopCapturer.getSources()` at native pixel
     * resolution. We match the source by its `display_id` (string form of the
     * Display.id) — the order returned by getSources isn't guaranteed to
     * match `screen.getAllDisplays()`.
     *
     * The thumbnailSize must be set to the display's NATIVE pixel size or
     * we get a 150×150 placeholder. Capping at 16383 because newer Electrons
     * silently fail above that.
     */
    private async captureDisplay (desktopCapturer: any, display: any): Promise<string | null> {
        const sf = display.scaleFactor || 1
        const w = Math.min(16383, Math.floor(display.bounds.width * sf))
        const h = Math.min(16383, Math.floor(display.bounds.height * sf))
        const sources: any[] = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: w, height: h },
        })
        if (!sources?.length) return null
        const targetId = String(display.id)
        const match = sources.find(s => s.display_id === targetId) ?? sources[0]
        const img = match.thumbnail
        if (!img || img.isEmpty?.()) return null
        return img.toDataURL()
    }
}
