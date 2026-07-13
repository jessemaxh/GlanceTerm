import { Injectable, NgZone, OnDestroy } from '@angular/core'

import { PlatformService } from 'tabby-core'

/** Delay the FIRST check so it never competes with app-launch work. */
const FIRST_CHECK_DELAY_MS = 8_000
/** Re-check cadence for a long-running window. Releases land on the order of
 *  days, so 6h keeps an always-open window current without being noisy. */
const INTERVAL_HOURS = 6
/** localStorage key holding the last `version` the user dismissed with "Later",
 *  so the notify shows once per NEW version, not every 6h poll. */
const DISMISS_KEY = 'glanceterm.autoUpdate.dismissedVersion'

/**
 * In-app update NOTIFIER (renderer side).
 *
 * GlanceTerm's main process ({@link ../../app/lib/window.ts} `setupUpdater`)
 * polls the GitHub release feed for a newer version but — deliberately — does
 * NOT download or install it: the in-process install runs Squirrel's ShipIt,
 * which on macOS 15/26 pops an "add a new helper tool" admin-password prompt
 * (and Cancel aborts the update). Instead, on `updater:update-available` the
 * main process hands us the new version + a direct `.dmg` URL, and this service
 * offers a one-click **Download** that opens it in the browser. The user
 * drag-installs — which touches no launchd helper and so never prompts.
 *
 * This service is the thing that ASKS the main process to check
 * (`updater:check-for-updates`): once shortly after launch, then on an interval.
 * GitHub releases are the single source of truth — there is no config to
 * maintain (cf. the dormant JSON-config {@link UpdateCheckService}). Any updater
 * error (unreachable feed, unpacked dev app, signature mismatch …) is swallowed
 * — a broken update path must never disrupt normal terminal use (fail-open).
 */
@Injectable({ providedIn: 'root' })
export class AutoUpdateService implements OnDestroy {
    /** Electron `ipcRenderer`, resolved the same way tabby-electron's
     *  ElectronService does. Null in a non-Electron host (tabby-web) or dev. */
    private ipc: any | null = null
    private timer?: ReturnType<typeof setInterval>
    private firstCheck?: ReturnType<typeof setTimeout>
    /** Guards against stacking a second dialog while one is still open. NOT a
     *  once-ever latch: `update-available` fires once per poll that finds a newer
     *  version, and a NEWER build appearing later in a long-running session
     *  should re-notify — which is the whole point of the 6h re-check cadence.
     *  Repeat-nagging for the SAME version is suppressed via {@link DISMISS_KEY}. */
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

        this.ipc.on('updater:update-available', (_e: any, version: string, url: string) =>
            this.zone.run(() => void this.onUpdateAvailable(version, url)))
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

    private async onUpdateAvailable (version: string, url: string): Promise<void> {
        // Show once per version — don't re-nag every 6h poll for a version the
        // user already deferred. A newer version later clears this naturally
        // (different value), so it re-notifies exactly once for each new release.
        if (this.prompting || this.getDismissed() === version) {
            return
        }
        this.prompting = true
        try {
            const r = await this.platform.showMessageBox({
                // Tabby's MessageBoxOptions only allows 'warning' | 'error';
                // 'warning' is the non-alarmist choice for an informational nudge.
                type: 'warning',
                message: `GlanceTerm ${version} is available`,
                detail: 'Download opens in your browser. Drag the new app into Applications to update — no admin password needed.',
                buttons: ['Download', 'Later'],
                defaultId: 0,
                cancelId: 1,
            })
            // Remember we surfaced THIS version regardless of choice; clicking
            // Download opens the page but the user may not actually install, and
            // the next genuinely-newer release will notify again (different key).
            this.setDismissed(version)
            if (r.response === 0 && url) {
                void this.platform.openExternal(url)
            }
        } finally {
            this.prompting = false
        }
    }

    private getDismissed (): string | null {
        try {
            return localStorage.getItem(DISMISS_KEY)
        } catch {
            return null
        }
    }

    private setDismissed (version: string): void {
        try {
            localStorage.setItem(DISMISS_KEY, version)
        } catch {
            /* private mode / quota — non-fatal, we may just re-notify */
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
