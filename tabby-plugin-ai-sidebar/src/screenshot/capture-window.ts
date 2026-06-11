import type { BrowserWindow } from 'electron'

import { overlayHtml } from './overlay/overlay-source'

/**
 * Result returned by the overlay BrowserWindow when the user finishes
 * (or cancels) a screenshot session.
 */
export interface CaptureResult {
    /** Null on cancel. Otherwise a PNG data URL of the cropped + annotated region. */
    dataURL: string | null
    /** Selection rect in NATIVE screen pixels (informational; null on cancel). */
    rect: { x: number; y: number; w: number; h: number } | null
}

interface OpenOpts {
    /** Display bounds in CSS pixels (renderer coordinate space). */
    displayBounds: { x: number; y: number; width: number; height: number }
    /** Device pixel ratio of that display. */
    scaleFactor: number
    /** The raw screenshot of that display as a PNG data URL. */
    screenDataURL: string
    /** Constructor for BrowserWindow, fished out of @electron/remote in the caller. */
    BrowserWindow: typeof BrowserWindow
    /** Electron `globalShortcut` (via @electron/remote). Lets Esc cancel the
     *  session even when the frameless/transparent/screen-saver-level overlay
     *  can't become the macOS *key window* (a borderless NSWindow reports
     *  canBecomeKeyWindow=NO, so the page's own keydown never sees the key).
     *  Optional — capture still works without it; the page-level Esc handler
     *  covers platforms where the overlay is focusable. */
    globalShortcut?: {
        register (accelerator: string, callback: () => void): boolean
        unregister (accelerator: string): void
    }
}

/**
 * Opens a frameless transparent BrowserWindow over the given display, loads
 * the self-contained overlay HTML, hands it the raw screenshot, and resolves
 * with the cropped result (or null on cancel/close).
 *
 * The overlay receives its payload via `postMessage` (no node integration,
 * no preload script) and replies via `postMessage` on the same window. Main
 * subscribes through a one-shot `webContents.executeJavaScript` callback that
 * forwards messages over IPC.
 */
export async function openCaptureWindow (opts: OpenOpts): Promise<CaptureResult> {
    const { displayBounds, scaleFactor, screenDataURL, BrowserWindow: BW } = opts

    const win = new BW({
        x: displayBounds.x,
        y: displayBounds.y,
        width: displayBounds.width,
        height: displayBounds.height,
        frame: false,
        transparent: true,
        fullscreen: false,
        // macOS clamps a normal (non-fullscreen) window's frame to the display's
        // WORK AREA — i.e. below the menu bar. Without this, the overlay opens at
        // y≈menuBarHeight even though we asked for y=0, so the full-display
        // snapshot it paints is pushed down by one menu-bar height: the real menu
        // bar stays visible above the overlay (band 1) and the snapshot's own menu
        // bar lands just below it (band 2) — the "two toolbars" + whole-screen
        // downward "jitter". `enableLargerThanScreen` lifts the work-area clamp so
        // the window can actually occupy y=0..height and cover the menu bar, making
        // the snapshot line up 1:1 with the real screen behind it.
        enableLargerThanScreen: true,
        // NO kiosk on macOS. Kiosk applies NSApplicationPresentationHideDock
        // (and HideMenuBar) — Electron has a long-standing bug where closing
        // a kiosk window doesn't restore those flags, leaving the user with
        // a permanently-hidden Dock until they log out or relaunch the
        // Dock process. `setAlwaysOnTop(_, 'screen-saver')` already paints
        // the overlay above the Dock (screen-saver level 1000 > Dock level
        // 20), so we don't need to ASK macOS to hide it — we just cover it.
        alwaysOnTop: true,
        movable: false,
        resizable: false,
        skipTaskbar: true,
        focusable: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
        },
        show: false,
    })

    win.setAlwaysOnTop(true, 'screen-saver')
    // Re-assert the full-display frame AFTER construction. macOS may still have
    // clamped the initial frame to the work area during `new BrowserWindow`
    // (the constructor applies position before our options fully settle); with
    // `enableLargerThanScreen` now in effect this setBounds sticks at y=0 and
    // covers the menu-bar strip, so the snapshot aligns pixel-for-pixel.
    win.setBounds({
        x: displayBounds.x,
        y: displayBounds.y,
        width: displayBounds.width,
        height: displayBounds.height,
    })
    // On macOS the overlay should show across all spaces so a user with the
    // Mission Control workspace picker open can still snip them.
    try { (win as any).setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true }) } catch { /* */ }

    const html = overlayHtml()
    const url = 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64')

    return new Promise<CaptureResult>((resolve) => {
        let settled = false
        let shown = false
        // Session-scoped Esc → cancel. The page registers its own keydown Esc,
        // but a frameless transparent screen-saver-level overlay often can't
        // become the macOS key window, so that handler never fires. A global
        // shortcut sidesteps focus entirely; it's torn down the instant the
        // session settles (in `done`) so Esc isn't swallowed app-wide after.
        let escRegistered = false
        const unregisterEsc = (): void => {
            if (!escRegistered) return
            escRegistered = false
            try { opts.globalShortcut?.unregister('Escape') } catch { /* */ }
        }
        // Reveal the overlay only once its first frame is painted (the 'ready'
        // handshake below). Showing while the renderer hasn't drawn yet flashes
        // the live desktop through the transparent window for a frame before the
        // frozen+dimmed snapshot snaps in — that swap was the whole-screen
        // "jitter" users saw on capture.
        const reveal = (): void => {
            if (shown || settled) return
            shown = true
            try { win.show(); win.focus() } catch { /* window torn down */ }
        }
        const done = (result: CaptureResult): void => {
            if (settled) return
            settled = true
            unregisterEsc()
            try {
                // Belt-and-braces: if a future change ever reintroduces kiosk
                // (or a future Electron defaults a different presentation flag
                // on transparent always-on-top windows), clearing it here
                // before close stops the Dock-vanishes-forever regression
                // from coming back.
                if (process.platform === 'darwin' && typeof (win as any).setKiosk === 'function' && (win as any).isKiosk?.()) {
                    (win as any).setKiosk(false)
                }
            } catch { /* */ }
            try { win.close() } catch { /* */ }
            resolve(result)
        }

        // Register Esc → cancel now (before the overlay even paints) so an early
        // Esc — while the snapshot is still decoding — also aborts cleanly.
        // register() returns false if some other app already holds Esc; we fall
        // back to the page-level handler in that case. globalShortcut intercepts
        // the key ahead of any window, so the page handler simply doesn't
        // double-fire while this is active (and `done` is idempotent anyway).
        try {
            escRegistered = opts.globalShortcut?.register('Escape', () => done({ dataURL: null, rect: null })) ?? false
        } catch { /* best-effort; page-level Esc still covers focusable platforms */ }

        win.webContents.once('did-finish-load', async () => {
            // Inject a postMessage listener that forwards results back to main
            // via `ipcRenderer` — except we don't have ipcRenderer in this
            // sandboxed renderer. So we forward via `console.log` with a magic
            // prefix; main reads it from the `console-message` event.
            // (Cleaner than wiring a preload script just for two events.)
            try {
                await win.webContents.executeJavaScript(`
                    window.addEventListener('message', (e) => {
                        if (!e.data || !e.data.kind) return;
                        try { console.log('__GLANCETERM_SHOT__' + JSON.stringify(e.data)); } catch (_) {}
                    });
                    window.postMessage(${JSON.stringify({
                        kind: 'init',
                        dataURL: screenDataURL,
                        width: displayBounds.width,
                        height: displayBounds.height,
                        dpr: scaleFactor,
                    })}, '*');
                    true;
                `)
            } catch (e) {
                done({ dataURL: null, rect: null })
                return
            }
            // Fallback: if 'ready' never arrives (decode hang / lost message),
            // reveal anyway so the overlay can't get stuck invisible with no way
            // to cancel. Normal path reveals far sooner, on the 'ready' message.
            setTimeout(() => reveal(), 600)
        })

        win.webContents.on('console-message', (...args: unknown[]) => {
            // Electron 38: console-message(event, level, message, line, source)
            // Electron 32+: console-message({event}: {message, level, …})
            // Handle both shapes.
            let msg: string | undefined
            if (typeof args[0] === 'object' && args[0] !== null && 'message' in (args[0] as object)) {
                msg = (args[0] as { message?: string }).message
            } else if (typeof args[2] === 'string') {
                msg = args[2]
            } else if (typeof args[1] === 'string') {
                msg = args[1]
            }
            if (typeof msg !== 'string') return
            if (!msg.startsWith('__GLANCETERM_SHOT__')) return
            try {
                const payload = JSON.parse(msg.slice('__GLANCETERM_SHOT__'.length))
                if (payload.kind === 'ready') {
                    reveal()
                } else if (payload.kind === 'confirm') {
                    done({ dataURL: payload.dataURL ?? null, rect: payload.rect ?? null })
                } else if (payload.kind === 'cancel') {
                    done({ dataURL: null, rect: null })
                }
            } catch { /* malformed — ignore */ }
        })

        win.on('closed', () => done({ dataURL: null, rect: null }))

        win.loadURL(url).catch(() => done({ dataURL: null, rect: null }))
    })
}
