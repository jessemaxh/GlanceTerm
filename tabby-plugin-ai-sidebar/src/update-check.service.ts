import { Injectable, OnDestroy } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'

import { ConfigService, PlatformService } from 'tabby-core'

import {
    parseUpdateConfig,
    decideUpdateAction,
    pickDownloadUrl,
    toUpdatePlatform,
    UpdateConfig,
} from './update-decision'
import { UpdateForceModalComponent } from './update-force-modal.component'

/**
 * Default poll cadence. The check is cheap (one small JSON GET) but version
 * metadata changes on the order of releases, not minutes — 6h keeps a
 * long-running window reasonably current without hammering the endpoint.
 */
const DEFAULT_INTERVAL_HOURS = 6
/** Delay the FIRST check so it never competes with app-launch work. */
const FIRST_CHECK_DELAY_MS = 8_000
/** Abort a stuck fetch so a hung endpoint can't pin `checking` forever. */
const FETCH_TIMEOUT_MS = 10_000
/** localStorage key holding the last `latest` version the user dismissed with
 *  "Later" — so the soft notify shows once per new version, not every poll. */
const DISMISS_KEY = 'glanceterm.update.dismissedVersion'

/**
 * Remote version-check + update gate (Step 1: notify / force-gate only — the
 * actual in-app download+install lands later via electron-updater, swapped in
 * behind {@link openDownload} without touching this gating logic or its UI).
 *
 * Reads a small JSON config from `ai.updateCheck.configUrl` holding `latest`
 * and `minimum` versions, compares against the running app version, and:
 *   - current < minimum → opens a NON-dismissible modal (force update)
 *   - current < latest  → shows a dismissible "update available" prompt
 *   - otherwise / on ANY error → does nothing (fail-open — see decideUpdateAction)
 *
 * The configUrl ships empty by default; until the user (or a build) sets it,
 * the service is a no-op. This is intentional — no endpoint is wired yet.
 */
@Injectable({ providedIn: 'root' })
export class UpdateCheckService implements OnDestroy {
    private timer?: ReturnType<typeof setInterval>
    private firstCheck?: ReturnType<typeof setTimeout>
    private checking = false
    /** True while the force modal is on screen — prevents stacking a second
     *  copy on the next poll tick while the first is still open. */
    private forceModalOpen = false

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private ngbModal: NgbModal,
    ) {
        this.firstCheck = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
        const hours = this.settings().intervalHours
        this.timer = setInterval(() => void this.check(), hours * 3_600_000)
    }

    ngOnDestroy (): void {
        if (this.timer) clearInterval(this.timer)
        if (this.firstCheck) clearTimeout(this.firstCheck)
    }

    private settings (): { enabled: boolean; configUrl: string; intervalHours: number } {
        const s: any = this.config.store?.ai?.updateCheck ?? {}
        return {
            enabled: s.enabled !== false,
            configUrl: typeof s.configUrl === 'string' ? s.configUrl.trim() : '',
            intervalHours:
                typeof s.intervalHours === 'number' && s.intervalHours > 0
                    ? s.intervalHours
                    : DEFAULT_INTERVAL_HOURS,
        }
    }

    /**
     * Run one check. Safe to call repeatedly — coalesced via `checking`, and
     * every failure path is swallowed (fail-open): a network error, a non-200,
     * malformed JSON, or an unparseable version all resolve to "do nothing"
     * rather than ever blocking the app.
     */
    async check (): Promise<void> {
        if (this.checking) return
        const { enabled, configUrl } = this.settings()
        if (!enabled || !configUrl) return // no endpoint configured yet → no-op
        this.checking = true
        try {
            const config = await this.fetchConfig(configUrl)
            const current = this.platform.getAppVersion()
            const action = decideUpdateAction(current, config)
            if (action === 'force') {
                this.showForce(config!, current)
            } else if (action === 'notify') {
                await this.maybeNotify(config!, current)
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[glanceterm] update check failed (fail-open, ignoring):', e)
        } finally {
            this.checking = false
        }
    }

    private async fetchConfig (url: string): Promise<UpdateConfig | null> {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
        try {
            const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
            if (!res.ok) return null
            return parseUpdateConfig(await res.json())
        } catch {
            return null
        } finally {
            clearTimeout(t)
        }
    }

    /**
     * Phase-2 seam: the ONLY place a download is triggered. Today it opens the
     * platform's download URL in the browser. When electron-updater's feed +
     * signing land, swap this body for the updater IPC
     * (`updater:check-for-updates` → `updater:quit-and-install`) — the gating
     * logic and both UIs above stay untouched.
     */
    private openDownload (config: UpdateConfig): void {
        const url = pickDownloadUrl(config, toUpdatePlatform(process.platform))
        if (url) void this.platform.openExternal(url)
    }

    private showForce (config: UpdateConfig, current: string): void {
        if (this.forceModalOpen) return
        this.forceModalOpen = true
        const ref = this.ngbModal.open(UpdateForceModalComponent, {
            backdrop: 'static',
            keyboard: false,
            centered: true,
            size: 'md',
        })
        const inst = ref.componentInstance as UpdateForceModalComponent
        inst.currentVersion = current
        inst.requiredVersion = config.minimum
        inst.latestVersion = config.latest
        inst.onDownload = () => this.openDownload(config)
        inst.onQuit = () => this.platform.quit()
        ref.result.catch(() => { /* dismissed programmatically */ }).finally(() => {
            this.forceModalOpen = false
        })
    }

    private async maybeNotify (config: UpdateConfig, current: string): Promise<void> {
        // Show once per `latest` — don't re-nag every poll for a version the
        // user already chose to defer.
        if (this.getDismissed() === config.latest) return
        const r = await this.platform.showMessageBox({
            // Tabby's MessageBoxOptions only allows 'warning' | 'error';
            // 'warning' is the non-alarmist choice for an informational nudge.
            type: 'warning',
            message: `GlanceTerm ${config.latest} is available`,
            detail: `You're on ${current}. Update for the latest fixes and features.`,
            buttons: ['Update now', 'Later'],
            defaultId: 0,
            cancelId: 1,
        })
        // Remember we've surfaced THIS version regardless of choice — clicking
        // "Update now" opens the page; if they don't actually update, the next
        // genuinely-newer `latest` will notify again (different dismissed key).
        this.setDismissed(config.latest)
        if (r.response === 0) this.openDownload(config)
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
            /* private mode / quota — non-fatal, we just may re-notify */
        }
    }
}
