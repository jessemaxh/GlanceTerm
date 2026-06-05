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
        // `fullscreen: true` on macOS animates into a separate Space which is
        // jarring and slow. `kiosk` covers the screen instantly without the
        // animation, and we set alwaysOnTop to be safe.
        kiosk: process.platform === 'darwin',
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
    // On macOS the overlay should show across all spaces so a user with the
    // Mission Control workspace picker open can still snip them.
    try { (win as any).setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true }) } catch { /* */ }

    const html = overlayHtml()
    const url = 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64')

    return new Promise<CaptureResult>((resolve) => {
        let settled = false
        const done = (result: CaptureResult): void => {
            if (settled) return
            settled = true
            try { win.close() } catch { /* */ }
            resolve(result)
        }

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
            win.show()
            win.focus()
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
                if (payload.kind === 'confirm') {
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
