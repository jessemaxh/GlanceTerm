import { Injectable, NgZone, OnDestroy } from '@angular/core'

import { PlatformService } from 'tabby-core'

/** Delay the FIRST check so it never competes with app-launch work. */
const FIRST_CHECK_DELAY_MS = 8_000
/** Re-check cadence for a long-running window. Releases land on the order of
 *  days, so 6h keeps an always-open window current without being noisy. */
const INTERVAL_HOURS = 6

/**
 * In-app auto-update driver (renderer side).
 *
 * GlanceTerm ships with electron-updater wired in the main process
 * ({@link ../../app/lib/window.ts} `setupUpdater`): it polls the GitHub release
 * feed (`latest-${arch}-mac.yml`, baked via `build.publish` in
 * `scripts/build-macos.mjs`), auto-downloads a newer signed build, and — with
 * `autoInstallOnAppQuit` — applies it on the next quit. The main process only
 * *checks* when the renderer asks it to (`updater:check-for-updates`), so this
 * service is the thing that asks: once shortly after launch, then on an
 * interval. GitHub releases are the single source of truth — there is no config
 * to maintain (cf. the dormant JSON-config {@link UpdateCheckService}).
 *
 * On `updater:update-downloaded` it offers an immediate restart; declining is
 * fine because the update installs on quit regardless. Any updater error
 * (unreachable feed, unpacked dev app, signature mismatch …) is swallowed —
 * a broken update path must never disrupt normal terminal use (fail-open).
 */
@Injectable({ providedIn: 'root' })
export class AutoUpdateService implements OnDestroy {
    /** Electron `ipcRenderer`, resolved the same way tabby-electron's
     *  ElectronService does. Null in a non-Electron host (tabby-web) or dev. */
    private ipc: any | null = null
    private timer?: ReturnType<typeof setInterval>
    private firstCheck?: ReturnType<typeof setTimeout>
    /** Guards against stacking a second dialog while one is still open. NOT a
     *  once-ever latch: electron-updater fires `update-downloaded` once per
     *  downloaded version, so dropping the latch lets a NEWER build (downloaded
     *  later in a long-running session) re-prompt — which is the whole point of
     *  the 6h re-check cadence. */
    private prompting = false

    constructor (
        private zone: NgZone,
        private platform: PlatformService,
    ) {
        try {
            // Bare `require('electron')` — externalised by webpack (see the
            // plugin webpack configs), so it stays a runtime require. Throws in
            // a non-Electron host, where auto-update simply doesn't apply.
            this.ipc = require('electron').ipcRenderer
        } catch {
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] auto-update unavailable (not running under Electron)')
            return
        }

        // electron-updater can't update an unpacked app and would only emit
        // `updater:error` on every tick. TABBY_DEV is this repo's dev signal
        // (cross-env TABBY_DEV=1 in `npm start`/`watch`/`prod`).
        if (process.env.TABBY_DEV) {
            return
        }

        this.ipc.on('updater:update-downloaded', () =>
            this.zone.run(() => void this.onDownloaded()))
        this.ipc.on('updater:error', (_e: any, message: string, integrity?: boolean) => {
            // Fail-open: never disrupt normal use. But split a security-relevant
            // integrity/signature failure (possible tampering — main classifies
            // it) from a benign network/feed error, so the former isn't buried
            // in the noise of expected offline ticks. Both land in
            // ~/.glanceterm/debug.log via DebugLogService's console tee.
            if (integrity) {
                // eslint-disable-next-line no-console
                console.error('[glanceterm] auto-update INTEGRITY/signature failure (possible tampering):', message)
            } else {
                // eslint-disable-next-line no-console
                console.warn('[glanceterm] auto-update check failed (benign — network/feed):', message)
            }
        })

        this.firstCheck = setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS)
        this.timer = setInterval(() => this.check(), INTERVAL_HOURS * 3_600_000)
    }

    private check (): void {
        this.ipc?.send('updater:check-for-updates')
    }

    private async onDownloaded (): Promise<void> {
        if (this.prompting) {
            return
        }
        this.prompting = true
        try {
            const r = await this.platform.showMessageBox({
                // Tabby's MessageBoxOptions only allows 'warning' | 'error';
                // 'warning' is the non-alarmist choice for an informational nudge.
                type: 'warning',
                message: 'A GlanceTerm update is ready',
                detail: 'It installs automatically when you quit GlanceTerm. Restart now to apply it immediately.',
                buttons: ['Restart now', 'Later'],
                defaultId: 0,
                cancelId: 1,
            })
            if (r.response === 0) {
                this.ipc?.send('updater:quit-and-install')
            }
        } finally {
            this.prompting = false
        }
    }

    ngOnDestroy (): void {
        if (this.firstCheck) {
            clearTimeout(this.firstCheck)
        }
        if (this.timer) {
            clearInterval(this.timer)
        }
    }
}
