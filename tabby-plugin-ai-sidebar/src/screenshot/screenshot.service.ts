import { Injectable } from '@angular/core'

import { NotificationsService } from 'tabby-core'

import { openCaptureWindow, CaptureResult } from './capture-window'

/**
 * Public surface used by the sidebar button.
 *
 * `capture({ hideWindow })` does the full flow: optionally hide the main
 * GlanceTerm window, grab the primary display via `desktopCapturer`, hand it
 * to the overlay window, await the user's confirm/cancel, then restore the
 * main window. Returns a Node Buffer of the cropped PNG, or null on cancel.
 *
 * `hideWindow` is now a per-invocation intent set by the caller, not a
 * persisted toggle: the main screenshot button passes `false` (GlanceTerm
 * stays on-screen — the common "snip another GlanceTerm tab and route it to
 * a different agent" case), and the split-button's "Hide Window Screenshot"
 * menu action passes `true` (hide GlanceTerm so its UI isn't in the frame).
 *
 * Multi-display support: v1 captures the display where the GlanceTerm window
 * currently lives (`screen.getDisplayMatching(window.bounds)`). A user with
 * multiple monitors capturing on the "wrong" one can drag GlanceTerm to the
 * monitor they want first. Spanning all displays at once is left as a v2.
 */
@Injectable({ providedIn: 'root' })
export class ScreenshotService {
    private inProgress = false
    /**
     * Session-scoped escape hatch for the macOS Screen Recording preflight.
     *
     * The preflight (`systemPreferences.getMediaAccessStatus('screen')`)
     * can disagree with the OS's real TCC state: stale cache after the
     * user just enabled the toggle, bundle-identifier / signature mismatch
     * between the running binary and the TCC entry, dev-build vs released-
     * build confusion. When that happens — pre-fix — the user was stuck in
     * an infinite "permission needed" dialog loop every time they clicked
     * the screenshot button, even with the toggle visibly on.
     *
     * The dialog now offers a "Permission is already granted — try anyway"
     * button. Picking it flips this flag for the rest of the session, so
     * the preflight is bypassed and `desktopCapturer.getSources()` runs
     * directly. If permission is genuinely granted, capture succeeds and
     * the flag remains true. If it isn't, getSources fails (worst case:
     * the macOS "Quit & Reopen" sheet appears, which is the standard
     * recovery path — strictly better than being stuck in our dialog).
     */
    private preflightBypassed = false

    constructor (
        private notifications: NotificationsService,
    ) {}

    /**
     * Run a screenshot session. Returns the PNG bytes on confirm, null on
     * cancel or any error. Errors surface as a toast AND a console log — the
     * button caller doesn't need to wrap this in try/catch, but the user
     * still gets feedback when something blew up (otherwise the click looks
     * like a no-op).
     */
    async capture (opts?: { hideWindow?: boolean }): Promise<{ buffer: Buffer; ext: 'png' } | null> {
        const hideWindow = opts?.hideWindow ?? false
        if (this.inProgress) return null
        this.inProgress = true
        // Outer try/finally guarantees `inProgress = false` on EVERY exit
        // path, including throws from the bare `@electron/remote` calls
        // below — `remote.getCurrentWindow()`, `ourWindow.isMinimized()`,
        // `ourWindow.isVisible()`, `pickDisplay`, `checkMacScreenPermission`.
        // Pre-fix those sat outside any try/finally, so a renderer-window
        // teardown race (or any other thrown error) left `inProgress = true`
        // forever and the screenshot button silently dead until app restart.
        try {
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
            if (process.platform === 'darwin' && !this.preflightBypassed) {
                const blocked = await this.checkMacScreenPermission(remote, ourWindow, desktopCapturer)
                if (blocked) return null
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
                if (hideWindow) {
                    // Hide so the GlanceTerm UI isn't in the screenshot. minimize()
                    // on macOS triggers a Genie animation; hide() is instant + invisible.
                    ourWindow.hide()
                    // Tiny breather lets the compositor catch up before the capture
                    // call — without it the screenshot can still include the window
                    // frame on slow machines.
                    await new Promise(r => setTimeout(r, 120))
                }

                const screenDataURL = await this.captureDisplay(desktopCapturer, target)
                if (!screenDataURL) {
                    this.notifications.error('Screenshot failed: could not capture display.')
                    return null
                }

                // globalShortcut (main-process module) lets Esc cancel the
                // overlay even when the frameless window can't take key focus
                // on macOS. Best-effort: a getBuiltin failure must not abort the
                // capture — the overlay still works via its toolbar buttons.
                let globalShortcut: any = null
                try { globalShortcut = remote.getBuiltin('globalShortcut') } catch { /* */ }

                const result: CaptureResult = await openCaptureWindow({
                    displayBounds: target.bounds,
                    scaleFactor: target.scaleFactor,
                    screenDataURL,
                    BrowserWindow: remote.BrowserWindow,
                    globalShortcut,
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
                    if (hideWindow && wasVisible) {
                        ourWindow.show()
                        ourWindow.focus()
                    }
                } catch { /* */ }
                // Always re-assert dock visibility — covers the case where the
                // overlay window or main-window hide somehow flipped a
                // presentation flag we didn't expect.
                ensureDockVisible(remote)
            }
        } finally {
            this.inProgress = false
        }
    }

    /**
     * Run the macOS Screen Recording permission gate on its own, so callers can
     * verify/prompt permission BEFORE their own "is this an AI agent tab" check
     * — a missing permission then surfaces regardless of which tab is focused,
     * instead of being hidden behind the agent gate. Returns true if it's OK to
     * proceed (granted, or the user chose "try anyway"), false if blocked. On
     * non-darwin or a missing Electron API it returns true (nothing to gate);
     * capture()'s own internal gate then no-ops (status granted, or
     * preflightBypassed was just set by the "try anyway" path).
     */
    async ensureScreenPermission (): Promise<boolean> {
        if (process.platform !== 'darwin' || this.preflightBypassed) return true
        let remote: any
        try {
            remote = require('@electron/remote')
        } catch {
            return true
        }
        try {
            const desktopCapturer = remote.getBuiltin('desktopCapturer')
            const ourWindow = remote.getCurrentWindow()
            return !(await this.checkMacScreenPermission(remote, ourWindow, desktopCapturer))
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] ensureScreenPermission failed — letting capture() handle the gate:', e?.message ?? e)
            return true
        }
    }

    /**
     * macOS Screen Recording permission gate.
     *
     * Returns `true` when capture should be aborted, `false` when it can
     * proceed (permission is granted, or the user chose "try anyway"). Three
     * cases, by live status:
     *
     *   granted        → proceed immediately.
     *
     *   not-determined → FIRST RUN. We trigger the OS's own native prompt with
     *     a throwaway `desktopCapturer.getSources()` call (see
     *     `triggerAndAwaitScreenGrant`). That single act does two things
     *     nothing else can: it registers GlanceTerm into the Screen Recording
     *     list, and it shows Apple's "GlanceTerm would like to record this
     *     computer's screen" dialog whose "Open System Settings" button
     *     deep-links straight to the pane with GlanceTerm already listed and
     *     highlighted. We then poll the live status and resolve the moment it
     *     flips to 'granted', so capture continues on its own — no second
     *     click, and on Electron 38 + macOS 13+ (ScreenCaptureKit) no restart.
     *
     *     Why trigger the native prompt instead of bouncing to Settings like
     *     we used to: `getMediaAccessStatus('screen')`
     *     (CGPreflightScreenCaptureAccess) only READS status — it never
     *     registers the app. The old "go enable GlanceTerm in Settings" dialog
     *     therefore sent users to a list that did NOT contain GlanceTerm. The
     *     getSources() call is what puts it there.
     *
     *   denied / restricted / unknown → the user previously denied, or an MDM
     *     profile locked it. The OS will not re-prompt on its own, so we fall
     *     back to the explicit "Open System Settings" dialog with the session
     *     "try anyway" escape hatch (see `preflightBypassed`).
     *
     * Live-status correctness: on macOS 13+ Chromium reads permission via
     * CGPreflightScreenCaptureAccess, which reflects the real current state
     * with no restart. GlanceTerm targets macOS 13+, so polling for 'granted'
     * resolves as soon as the user flips the toggle.
     *
     * Defensive against missing API surface: if `getMediaAccessStatus('screen')`
     * throws or returns undefined (older/unexpected Electron) we fall through to
     * the legacy capture flow rather than blocking the button outright, logging
     * a warning so a future regression shows up in console.
     */
    private async checkMacScreenPermission (remote: any, win: any, desktopCapturer: any): Promise<boolean> {
        let systemPreferences: any
        const readStatus = (): string | undefined => {
            try {
                systemPreferences = systemPreferences ?? remote.getBuiltin('systemPreferences')
                return systemPreferences?.getMediaAccessStatus?.('screen')
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] getMediaAccessStatus(screen) threw:', e)
                return undefined
            }
        }

        const status = readStatus()
        if (status === undefined) {
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] getMediaAccessStatus(screen) returned undefined — Electron API surface unexpected, falling through to legacy capture flow.')
            return false
        }
        if (status === 'granted') return false

        if (status === 'not-determined') {
            // granted within timeout → proceed (return false); else abort.
            return !(await this.triggerAndAwaitScreenGrant(desktopCapturer, win, readStatus))
        }

        // denied | restricted | unknown
        return await this.promptOpenScreenSettings(remote, win, desktopCapturer)
    }

    /**
     * First-run path: fire the OS's native Screen Recording prompt, then wait
     * for the user to grant it. Resolves `true` once status is 'granted' (so
     * capture continues automatically), `false` on timeout.
     *
     * The throwaway getSources() call registers GlanceTerm in the Screen
     * Recording list AND shows Apple's native dialog. It typically returns
     * empty/black frames while the grant is still pending — we don't use its
     * result, only its side effects — then we poll `readStatus()` until the
     * user flips the toggle.
     */
    private async triggerAndAwaitScreenGrant (
        desktopCapturer: any,
        win: any,
        readStatus: () => string | undefined,
    ): Promise<boolean> {
        try {
            // 1×1 thumbnail: we only need the enumeration to trip the OS prompt
            // + list registration, not the pixels.
            await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        } catch (e) {
            // Expected to fail/return empty while permission is pending — the
            // side effect (prompt + registration) still happens.
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] priming getSources() threw while triggering the Screen Recording prompt (expected if not yet granted):', e)
        }

        this.notifications.info(
            'Waiting for Screen Recording permission — enable GlanceTerm in System Settings and the screenshot will continue automatically.',
        )

        const granted = await this.waitForScreenGrant(win, readStatus)
        if (!granted) {
            this.notifications.error(
                'Screen Recording permission not granted. Enable GlanceTerm in System Settings → ' +
                'Privacy & Security → Screen & System Audio Recording, then click Screenshot again.',
            )
        }
        return granted
    }

    /**
     * Poll the live Screen Recording status until 'granted' or timeout. The
     * window 'focus' event — fired when the user tabs back from System Settings
     * — triggers an immediate re-check, so the common case resolves within a
     * frame of the user returning rather than on the next poll tick.
     */
    private waitForScreenGrant (win: any, readStatus: () => string | undefined): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            let settled = false
            const POLL_MS = 700
            const TIMEOUT_MS = 120000

            const check = (): void => {
                if (settled) return
                if (readStatus() === 'granted') finish(true)
            }
            const finish = (granted: boolean): void => {
                if (settled) return
                settled = true
                clearInterval(timer)
                clearTimeout(timeout)
                try { win.removeListener?.('focus', check) } catch { /* */ }
                resolve(granted)
            }

            const timer = setInterval(check, POLL_MS)
            const timeout = setTimeout(() => finish(false), TIMEOUT_MS)
            try { win.on?.('focus', check) } catch { /* */ }
            check()
        })
    }

    /**
     * denied / restricted / unknown path: the OS won't re-prompt, so steer the
     * user to System Settings explicitly, with the session "try anyway" escape
     * hatch for when the OS's TCC cache disagrees with reality (bundle /
     * signature mismatch, dev vs release build, …).
     *
     * Returns `true` to abort capture, `false` to proceed (user chose
     * "try anyway").
     *
     * Takes `desktopCapturer` so the "Open System Settings" path can fire a
     * throwaway getSources() first — that's what REGISTERS GlanceTerm into the
     * Screen Recording list. getMediaAccessStatus only reads status; it never
     * adds the app. Without the priming call a denied / stale-TCC app sends the
     * user to a pane that doesn't list GlanceTerm to toggle (the "enable an app
     * that isn't there" trap).
     */
    private async promptOpenScreenSettings (remote: any, win: any, desktopCapturer: any): Promise<boolean> {
        let dialog: any
        try {
            dialog = remote.getBuiltin('dialog')
        } catch {
            return true   // can't dialog — silently abort capture
        }

        const detail =
            'Open System Settings → Privacy & Security → Screen & System Audio ' +
            'Recording, then enable GlanceTerm. On macOS 13+ you do NOT need to ' +
            'restart — the screenshot works as soon as the toggle is on.\n\n' +
            'If the toggle is already on and you\'re still seeing this, the OS\'s ' +
            'permission cache may disagree with reality (bundle / signature ' +
            'mismatch, dev vs release build, …). Click "Already granted — try ' +
            'anyway" to skip this check for the rest of this session.'

        // Button index → action contract:
        //   0  Open System Settings — opens the relevant pane and aborts capture.
        //   1  Already granted — try anyway — flips the session bypass and lets
        //      capture proceed. If permission is genuinely missing, the next
        //      `desktopCapturer.getSources()` call will fail and macOS may show
        //      the "Quit & Reopen" sheet — still strictly better than being
        //      trapped in this dialog forever.
        //   2  Cancel — aborts capture, no state change.
        const BTN_OPEN = 0
        const BTN_TRY = 1
        const BTN_CANCEL = 2

        let response = BTN_CANCEL
        try {
            const result = await dialog.showMessageBox(win, {
                type: 'info',
                buttons: ['Open System Settings', 'Already granted — try anyway', 'Cancel'],
                defaultId: BTN_OPEN,
                cancelId: BTN_CANCEL,
                title: 'Screen Recording permission needed',
                message: 'GlanceTerm doesn\'t have Screen Recording permission yet.',
                detail,
            })
            response = result?.response ?? BTN_CANCEL
        } catch {
            return true
        }
        if (response === BTN_TRY) {
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] user opted to bypass macOS Screen Recording preflight — proceeding without verified permission')
            this.preflightBypassed = true
            return false
        }
        if (response !== BTN_OPEN) return true

        // Register GlanceTerm into the Screen Recording list BEFORE steering the
        // user to the pane. CGPreflightScreenCaptureAccess (what
        // getMediaAccessStatus reads) only READS status — a throwaway
        // getSources() is the only thing that ADDS the app to the list. Without
        // it, a denied / stale-TCC app opens a pane that doesn't contain
        // GlanceTerm to toggle — the user is told to enable an app that isn't
        // there. Best-effort: it returns empty/black while denied; we only want
        // the registration side effect, so failures are swallowed.
        try {
            await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        } catch { /* expected to fail while denied — the registration side effect still happens */ }

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
