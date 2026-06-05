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

        // macOS Screen Recording permission gate.
        //
        // Why we don't just let `desktopCapturer.getSources()` trigger the
        // OS prompt itself: calling getSources while the TCC status is
        // `not-determined` or `denied` makes macOS engrave that rejection
        // into the process's TCC cache. After the user grants the
        // permission in System Settings, the next capture call hits the
        // cached "denied" and macOS pops the "Quit & Reopen" sheet — there
        // is no way to flush that cache short of restart.
        //
        // By intercepting BEFORE we call getSources and steering the user
        // to System Settings ourselves, no TCC cache entry gets written.
        // The next Screenshot click finds status === 'granted' and the
        // very first getSources is a fresh call: no restart required.
        if (process.platform === 'darwin') {
            const blocked = await this.checkMacScreenPermission(remote, ourWindow)
            if (blocked) {
                this.inProgress = false
                return null
            }
        }

        const target = this.pickDisplay(screen, ourWindow)

        // Defensive: macOS's NSApplicationPresentation flags (Dock visibility,
        // Dock icon presentation policy) sometimes get left in a "hidden"
        // state by a prior crashed/aborted overlay session — kiosk mode is
        // the historical offender, but other paths can leak too. Re-asserting
        // dock.show() before every capture costs nothing and recovers the
        // user's Dock + Dock icon if they were stuck hidden from a previous
        // bad run.
        ensureDockVisible(remote)

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
            // Always re-assert dock visibility — covers the case where the
            // overlay window or main-window hide somehow flipped a
            // presentation flag we didn't expect.
            ensureDockVisible(remote)
            this.inProgress = false
        }
    }

    /**
     * Pre-flight macOS Screen Recording permission check.
     *
     * Returns `true` when capture should be aborted (no permission, user was
     * shown a "go to System Settings" dialog) and `false` when capture can
     * proceed (status === 'granted'). The TCC cache caveat in the caller's
     * comment is the reason this lives upstream of any `desktopCapturer`
     * call — we MUST NOT touch getSources() until the OS-level status is
     * 'granted', otherwise the user falls into the restart trap.
     *
     * Defensive against missing API surface: `getMediaAccessStatus('screen')`
     * is supported in Electron 25+; older Electrons return undefined for
     * unknown media types. If the call throws or returns undefined we fall
     * through and let getSources do whatever it does — degraded to the old
     * (sometimes-restart-needed) flow, which is still better than blocking
     * the button outright.
     */
    private async checkMacScreenPermission (remote: any, win: any): Promise<boolean> {
        let status: string | undefined
        try {
            const systemPreferences = remote.getBuiltin('systemPreferences')
            status = systemPreferences?.getMediaAccessStatus?.('screen')
        } catch {
            return false
        }
        if (!status || status === 'granted') return false

        // status is 'not-determined' | 'denied' | 'restricted' | 'unknown'.
        // 'restricted' is MDM-locked — opening Settings won't help, but the
        // language we use is still accurate ("doesn't have permission"). We
        // collapse all three non-granted cases into one dialog.
        let dialog: any
        try {
            dialog = remote.getBuiltin('dialog')
        } catch {
            return true   // can't dialog — silently abort capture
        }

        const message = status === 'not-determined'
            ? 'GlanceTerm needs Screen Recording permission to capture screenshots.'
            : 'GlanceTerm doesn\'t have Screen Recording permission yet.'

        const detail =
            'Open System Settings → Privacy & Security → Screen Recording, ' +
            'then enable GlanceTerm. You do NOT need to restart — just click ' +
            'Screenshot again once the toggle is on.'

        let response = 1
        try {
            const result = await dialog.showMessageBox(win, {
                type: 'info',
                buttons: ['Open System Settings', 'Cancel'],
                defaultId: 0,
                cancelId: 1,
                title: 'Screen Recording permission needed',
                message,
                detail,
            })
            response = result?.response ?? 1
        } catch {
            return true
        }
        if (response !== 0) return true

        // Try the modern URL scheme (macOS 13+ Privacy_ScreenCapture). If
        // shell.openExternal fails or the URL isn't recognised, fall back
        // to the bare Security pane — better than dropping the user in
        // System Settings root.
        try {
            const shell = remote.getBuiltin('shell')
            await shell.openExternal(
                'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
            )
        } catch {
            try {
                const shell = remote.getBuiltin('shell')
                await shell.openExternal(
                    'x-apple.systempreferences:com.apple.preference.security',
                )
            } catch { /* swallow — user can navigate manually */ }
        }
        return true
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

/**
 * Force the macOS Dock and the app's Dock icon back to visible.
 *
 * Background — the first GlanceTerm release of the screenshot button set
 * `kiosk: true` on the overlay BrowserWindow. macOS kiosk mode applies
 * NSApplicationPresentationKioskMode, which includes both HideDock and
 * HideMenuBar, and Electron has a bug where closing such a window doesn't
 * always restore those flags. Users hit two visible symptoms:
 *   1. The whole macOS Dock stayed hidden.
 *   2. GlanceTerm's icon disappeared from the Dock even after Dock came back
 *      (the app's activation policy got stuck on `accessory`).
 *
 * We've since dropped `kiosk: true` from capture-window.ts, but this helper
 * stays as belt-and-braces:
 *   - `app.dock.show()` flips activation policy back to `regular`, restoring
 *     the app's icon in the Dock.
 *   - It also re-asserts default presentation options on the app, which
 *     re-shows the system Dock if a leftover flag was hiding it.
 *
 * No-op on non-macOS platforms (Linux/Windows don't have `app.dock`).
 */
function ensureDockVisible (remote: any): void {
    if (process.platform !== 'darwin') return
    try {
        const app = remote.getBuiltin?.('app') ?? remote.app
        if (app?.dock?.show) {
            void app.dock.show()
        }
    } catch {
        /* swallow — defensive call, never block the screenshot flow */
    }
}
