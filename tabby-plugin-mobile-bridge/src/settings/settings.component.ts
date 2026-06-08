import { Component, NgZone, OnDestroy } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { Observable, Subscription, combineLatest, of } from 'rxjs'
import { map, switchMap } from 'rxjs/operators'

import { BindingStoreService } from '../binding/store.service'
import { PairingService } from '../binding/pairing.service'
import { BackendRegistry } from '../backends/registry.service'
import { TopicService } from '../topic.service'
import { InstanceLockService } from '../instance-lock.service'
import { ChannelBinding, PendingPairing } from '../binding/types'
import { BackendLastError, BotIdentity } from '../backends/types'

type Platform = 'telegram' | 'feishu'

/**
 * Settings panel for the Mobile Bridge plugin. Opened from the AI
 * sidebar's gear modal as an NgbModal — the plugin registers itself with
 * SidebarSettingsRegistry at module construct time (see index.ts).
 *
 * Three render states, mutually exclusive:
 *   - Not connected: platform picker + per-platform pairing form
 *   - Connected: bot identity + enabled toggle + disconnect + stats
 *   - Secondary instance: warning banner (lock held by another process)
 *
 * Per-platform pairing UX:
 *   - Telegram: paste bot token → /bind in supergroup with Forum Topics
 *   - Feishu: paste App ID + Secret + pick region → /bind in 话题模式 group
 */
@Component({
    selector: 'bridge-settings',
    template: `
        <div class="content-box p-3">
            <div class="d-flex align-items-center mb-3">
                <h3 class="m-0">Mobile Bridge</h3>
                <button type="button" class="btn-close btn-close-white ms-auto"
                        aria-label="Close" (click)="dismiss()"></button>
            </div>

            <p class="text-muted small mb-3">
                Every GlanceTerm tab mirrors to a topic / thread on your
                phone. Reply in the topic → injects into the tab. Closing
                a tab archives its topic (history kept).
            </p>

            <!-- Secondary-instance warning supersedes everything else -->
            <div *ngIf="!(isPrimary$ | async)" class="alert alert-warning small mb-3">
                ⚠ Another GlanceTerm instance holds the bridge lock. This
                window is silent. Quit the other GlanceTerm to re-enable
                here.
            </div>

            <!-- Connected state -->
            <ng-container *ngIf="binding$ | async as binding; else notConnected">
                <div class="border rounded p-3 mb-3">
                    <div class="d-flex align-items-center mb-2">
                        <strong>{{ statusLine$ | async }}</strong>
                    </div>
                    <!-- Actionable error line. Surfaces auth failures
                         (revoked token, hostname drift breaking keystore,
                         Feishu secret rotated) instead of leaving the user
                         staring at "Idle" with no recovery hint. -->
                    <div *ngIf="lastErrorLine$ | async as errorLine"
                         class="alert alert-danger small py-2 mb-2">
                        {{ errorLine }}
                    </div>
                    <div class="small text-muted mb-3">
                        {{ platformLabel(binding.platform) }} · chat: {{ binding.chatId }} · {{ statsLine }}
                    </div>
                    <div class="d-flex align-items-center">
                        <label class="form-check-label me-3">
                            <input type="checkbox" class="form-check-input me-1"
                                   [checked]="binding.enabled"
                                   (change)="toggleEnabled(binding)"/>
                            Enabled
                        </label>
                        <button class="btn btn-sm btn-outline-danger ms-auto"
                                (click)="disconnect(binding)">
                            Disconnect
                        </button>
                    </div>
                </div>
            </ng-container>

            <!-- Not connected: pairing flow -->
            <ng-template #notConnected>
                <div *ngIf="!pairing" class="border rounded p-3 mb-3">
                    <div class="form-group mb-3">
                        <label class="small d-block mb-1">Platform:</label>
                        <div class="btn-group" role="group">
                            <button type="button" class="btn btn-sm"
                                    [class.btn-primary]="platform === 'telegram'"
                                    [class.btn-outline-secondary]="platform !== 'telegram'"
                                    (click)="platform = 'telegram'">
                                Telegram
                            </button>
                            <button type="button" class="btn btn-sm"
                                    [class.btn-primary]="platform === 'feishu'"
                                    [class.btn-outline-secondary]="platform !== 'feishu'"
                                    (click)="platform = 'feishu'">
                                Feishu / Lark
                            </button>
                        </div>
                    </div>

                    <!-- Telegram form -->
                    <ng-container *ngIf="platform === 'telegram'">
                        <div class="form-group mb-2">
                            <label class="small">Bot token (from &#64;BotFather):</label>
                            <input type="password" class="form-control" [(ngModel)]="botToken"
                                   placeholder="123456789:ABC..."/>
                        </div>
                        <div class="form-group mb-3">
                            <label class="small">Label (optional):</label>
                            <input type="text" class="form-control" [(ngModel)]="label"
                                   placeholder="My Telegram"/>
                        </div>
                        <button class="btn btn-primary" (click)="startPair()"
                                [disabled]="!canPair() || busy || !(isPrimary$ | async)">
                            Generate pairing code
                        </button>
                        <div class="text-muted small mt-3">
                            ⓘ The bot must be admin in a supergroup with
                            <strong>Forum Topics</strong> enabled
                            (group settings → Topics).
                        </div>
                    </ng-container>

                    <!-- Feishu / Lark form -->
                    <ng-container *ngIf="platform === 'feishu'">
                        <div class="form-group mb-2">
                            <label class="small">Region:</label>
                            <div class="btn-group btn-group-sm" role="group">
                                <button type="button" class="btn"
                                        [class.btn-primary]="region === 'feishu'"
                                        [class.btn-outline-secondary]="region !== 'feishu'"
                                        (click)="region = 'feishu'">
                                    飞书 (CN)
                                </button>
                                <button type="button" class="btn"
                                        [class.btn-primary]="region === 'lark'"
                                        [class.btn-outline-secondary]="region !== 'lark'"
                                        (click)="region = 'lark'">
                                    Lark (Intl)
                                </button>
                            </div>
                        </div>
                        <div class="form-group mb-2">
                            <label class="small">App ID:</label>
                            <input type="text" class="form-control" [(ngModel)]="appId"
                                   placeholder="cli_xxxxxxxxxxxx"/>
                        </div>
                        <div class="form-group mb-2">
                            <label class="small">App Secret:</label>
                            <input type="password" class="form-control" [(ngModel)]="appSecret"
                                   placeholder="(from app settings)"/>
                        </div>
                        <div class="form-group mb-3">
                            <label class="small">Label (optional):</label>
                            <input type="text" class="form-control" [(ngModel)]="label"
                                   placeholder="My Feishu"/>
                        </div>
                        <button class="btn btn-primary" (click)="startPair()"
                                [disabled]="!canPair() || busy || !(isPrimary$ | async)">
                            Generate pairing code
                        </button>
                        <div class="text-muted small mt-3">
                            ⓘ Create a self-built app at
                            <strong>open.feishu.cn</strong> (or
                            <strong>open.larksuite.com</strong>), add the bot
                            to a group, and switch that group to
                            <strong>话题模式 (Topic mode)</strong>.
                        </div>
                    </ng-container>

                    <div *ngIf="error" class="text-danger small mt-2">{{ error }}</div>
                </div>

                <div *ngIf="pairing" class="alert alert-info">
                    <p class="mb-2">
                        In the {{ platformLabel(pairing.platform) }} group's
                        General topic, send:
                    </p>
                    <pre class="bg-dark text-white p-2 rounded mb-2">/bind {{ pairing.code }}</pre>
                    <p class="small text-muted mb-2">
                        Expires in {{ remainingMin }} min.
                    </p>
                    <button class="btn btn-sm btn-secondary" (click)="cancelPair()">
                        Cancel
                    </button>
                </div>
            </ng-template>
        </div>
    `,
})
export class BridgeSettingsComponent implements OnDestroy {
    binding$: Observable<ChannelBinding | undefined>
    isPrimary$: Observable<boolean>
    /** Renders as e.g. "@MyBot · connected" or "Idle". Reactive — derived
     *  from the connected binding's platform-specific backend. */
    statusLine$: Observable<string>
    /** When the connected backend has a recent auth-shaped failure, this
     *  emits an actionable single-line string. null otherwise — the alert
     *  banner is hidden via *ngIf. */
    lastErrorLine$: Observable<string | null>

    platform: Platform = 'telegram'
    botToken = ''
    appId = ''
    appSecret = ''
    region: 'feishu' | 'lark' = 'feishu'
    label = ''
    pairing: PendingPairing | null = null
    remainingMin = 0
    error = ''
    busy = false

    private completedSub: Subscription
    private tickHandle: ReturnType<typeof setInterval> | null = null

    constructor (
        private store: BindingStoreService,
        private pairingSvc: PairingService,
        private backends: BackendRegistry,
        private topics: TopicService,
        private lock: InstanceLockService,
        private zone: NgZone,
        public modal: NgbActiveModal,
    ) {
        // The first (and only, given v0 single-binding cap) configured
        // binding from either platform. undefined → "not connected"
        // template branch.
        this.binding$ = this.store.bindings$.pipe(
            map(bindings => bindings[0]),
        )
        this.isPrimary$ = this.lock.isPrimary$
        // statusLine pulls from whichever backend the current binding
        // points to. switchMap so the inner observable rebinds when the
        // binding's platform changes (rare with one-binding cap but
        // correct if the user disconnects and re-pairs on a different
        // platform).
        this.statusLine$ = this.binding$.pipe(
            switchMap(binding => {
                if (!binding) return of('Idle')
                // Disabled is a user-driven state (toggle off) that's
                // distinct from "backend not running" (which on a
                // disabled binding is the syncTransport-driven
                // consequence, not the cause). Showing "Idle" alongside
                // an Enabled-unchecked checkbox makes the card look
                // wrong; "Disabled" makes the cause explicit.
                if (!binding.enabled) return of('Disabled')
                const backend = this.backends.forPlatform(binding.platform)
                return combineLatest([backend.running$, backend.identity$]).pipe(
                    map(([running, identity]) => this.formatStatus(running, identity)),
                )
            }),
        )
        this.lastErrorLine$ = this.binding$.pipe(
            switchMap(binding => {
                if (!binding) return of(null)
                // Disabled = user explicitly toggled off. The backend
                // wasn't asked to be running, so a previous-session error
                // is irrelevant to the user. Hide the banner.
                if (!binding.enabled) return of(null)
                const backend = this.backends.forPlatform(binding.platform)
                return backend.lastError$.pipe(
                    map(err => this.formatLastError(err)),
                )
            }),
        )
        void this.store.load()

        this.completedSub = this.pairingSvc.completedPairing$.subscribe(_b => {
            this.zone.run(() => {
                this.pairing = null
                this.botToken = ''
                this.appId = ''
                this.appSecret = ''
                this.label = ''
                this.stopTicking()
            })
        })
    }

    ngOnDestroy (): void {
        this.completedSub.unsubscribe()
        this.stopTicking()
    }

    /** Modal-close handler. If a pairing is mid-flight, cancel it so the
     *  backend doesn't keep running after the user clicked X — the previous
     *  build left the bot polling for ~5 minutes waiting on a /bind code
     *  the user already navigated away from. */
    dismiss (): void {
        if (this.pairing) {
            this.pairingSvc.cancelPending(this.pairing.code)
            this.pairing = null
            this.stopTicking()
        }
        this.modal.dismiss()
    }

    /**
     * Topic stats line. Recomputed on every change-detection pass by
     * touching the TopicService cache — cheap for the dozens-of-topics
     * scale and avoids subscribing to a per-mutation event stream.
     */
    get statsLine (): string {
        const current = this.store.current[0]
        if (!current) return ''
        const { open, closed } = this.topics.getStatsForBinding(current.id)
        if (closed === 0) return `${open} topic${open === 1 ? '' : 's'}`
        return `${open} open · ${closed} archived`
    }

    canPair (): boolean {
        return this.platform === 'telegram'
            ? this.botToken.length > 0
            : this.appId.length > 0 && this.appSecret.length > 0
    }

    async startPair (): Promise<void> {
        if (!this.canPair() || this.busy) return
        this.busy = true
        this.error = ''
        try {
            if (this.platform === 'telegram') {
                this.pairing = await this.pairingSvc.beginTelegramPairing(
                    this.botToken,
                    this.label || undefined,
                )
            } else {
                this.pairing = await this.pairingSvc.beginFeishuPairing(
                    this.appId,
                    this.appSecret,
                    this.region,
                    this.label || undefined,
                )
            }
            this.tickRemaining()
            this.tickHandle = setInterval(() => this.tickRemaining(), 30_000)
        } catch (err: unknown) {
            this.error = err instanceof Error ? err.message : String(err)
        } finally {
            this.busy = false
        }
    }

    cancelPair (): void {
        if (!this.pairing) return
        this.pairingSvc.cancelPending(this.pairing.code)
        this.pairing = null
        this.stopTicking()
    }

    toggleEnabled (b: ChannelBinding): void {
        void this.store.update(b.id, { enabled: !b.enabled })
    }

    /** Hard-disconnect = remove binding entirely. Also clears the
     *  topic cache so an orphan map can't bloat the topics file across
     *  disconnect/reconnect cycles. */
    disconnect (b: ChannelBinding): void {
        if (!confirm(
            `Disconnect "${b.label}"?\n\n`
            + 'Existing topics in the group are not deleted — they '
            + 'become orphans (no new messages, history preserved). '
            + 'Clean them up manually on the platform if you want.',
        )) return
        void this.topics.forgetBinding(b.id)
        void this.store.remove(b.id)
    }

    platformLabel (p: Platform): string {
        return p === 'telegram' ? 'Telegram' : 'Feishu / Lark'
    }

    private formatStatus (running: boolean, identity: BotIdentity | null): string {
        if (!running) return 'Idle'
        if (identity?.displayName) return `${identity.displayName} · connected`
        return 'Connected'
    }

    /** Human-readable single-line action hint for backend errors. The kind
     *  enum is small and stable, so we hand-craft per kind rather than
     *  pass the raw .message through — the SDK / TG error strings are
     *  technical and noisy. */
    private formatLastError (err: BackendLastError | null): string | null {
        if (!err) return null
        switch (err.kind) {
            case 'auth_failed':
                return '⚠ Authentication failed — your token or app secret is invalid. Disconnect and pair again.'
            case 'permission_denied':
                return '⚠ Permission denied. Check the bot has admin / forum-topic permissions in the group.'
            case 'rate_limited':
                return '⏳ Rate limited by the platform — temporary; will retry automatically.'
            case 'chat_not_found':
                return '⚠ The bound chat is no longer reachable (bot removed?). Disconnect and pair again.'
            default:
                return null
        }
    }

    private tickRemaining (): void {
        if (!this.pairing) return
        this.remainingMin = Math.max(0, Math.round((this.pairing.expiresAt - Date.now()) / 60_000))
        if (this.remainingMin <= 0) {
            this.pairing = null
            this.stopTicking()
        }
    }

    private stopTicking (): void {
        if (this.tickHandle) {
            clearInterval(this.tickHandle)
            this.tickHandle = null
        }
    }
}
