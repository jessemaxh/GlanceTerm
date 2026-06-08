import { Component, NgZone, OnDestroy } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { Observable, Subscription, combineLatest } from 'rxjs'
import { map } from 'rxjs/operators'

import { BindingStoreService } from '../binding/store.service'
import { PairingService } from '../binding/pairing.service'
import { TelegramClientService } from '../telegram/client.service'
import { TopicService } from '../telegram/topic.service'
import { InstanceLockService } from '../instance-lock.service'
import { ChannelBinding, PendingPairing } from '../binding/types'
import { TgUser } from '../telegram/types'

/**
 * Settings panel for the Mobile Bridge plugin. Opened from the AI
 * sidebar's gear modal as an NgbModal — the plugin registers itself with
 * SidebarSettingsRegistry at module construct time (see index.ts).
 *
 * Post-rewrite scope (deliberately minimal): one bot, on/off, status.
 * The previous version exposed an event-type filter, an approved-senders
 * editor, and a separate permission-relay toggle — all artefacts of the
 * v0 "push per event type" model. With topic-sync (every tab mirrors as
 * a Forum Topic, permission requests always relay), those knobs collapsed
 * to a single concept: "is the bridge on or off."
 *
 * Three render states, mutually exclusive:
 *   - Not connected: bot token entry + pairing flow
 *   - Connected: bot identity + enabled toggle + disconnect button + stats
 *   - Secondary instance: warning banner (lock held by another process)
 */
@Component({
    selector: 'bridge-settings',
    template: `
        <div class="content-box p-3">
            <div class="d-flex align-items-center mb-3">
                <h3 class="m-0">Mobile Bridge</h3>
                <button type="button" class="btn-close btn-close-white ms-auto"
                        aria-label="Close" (click)="modal.dismiss()"></button>
            </div>

            <p class="text-muted small mb-3">
                Every GlanceTerm tab mirrors to a Telegram Forum Topic on
                your phone. Reply in the topic → injects into the tab.
                Closing a tab archives its topic (history kept).
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
                    <div class="small text-muted mb-3">
                        chat: {{ binding.chatId }} · {{ statsLine }}
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
                    <div class="form-group mb-2">
                        <label class="small">Bot token (from @BotFather):</label>
                        <input type="password" class="form-control" [(ngModel)]="botToken"
                               placeholder="123456789:ABC..."/>
                    </div>
                    <div class="form-group mb-3">
                        <label class="small">Label (optional):</label>
                        <input type="text" class="form-control" [(ngModel)]="label"
                               placeholder="My Telegram"/>
                    </div>
                    <button class="btn btn-primary" (click)="startPair()"
                            [disabled]="!botToken || busy">
                        Generate pairing code
                    </button>
                    <div *ngIf="error" class="text-danger small mt-2">{{ error }}</div>
                    <div class="text-muted small mt-3">
                        ⓘ The bot must be an admin in a supergroup with
                        <strong>Forum Topics enabled</strong> (group settings →
                        Topics).
                    </div>
                </div>

                <div *ngIf="pairing" class="alert alert-info">
                    <p class="mb-2">In the supergroup's General topic, send:</p>
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
    /** Renders as e.g. "@MyBot · connected" or "Idle". */
    statusLine$: Observable<string>

    botToken = ''
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
        private telegram: TelegramClientService,
        private topics: TopicService,
        private lock: InstanceLockService,
        private zone: NgZone,
        public modal: NgbActiveModal,
    ) {
        // First (and only, given v0 single-binding cap) telegram binding.
        // undefined → "not connected" template branch.
        this.binding$ = this.store.bindings$.pipe(
            map(bindings => bindings.find(b => b.platform === 'telegram')),
        )
        this.isPrimary$ = this.lock.isPrimary$
        this.statusLine$ = combineLatest([this.telegram.running$, this.telegram.identity$]).pipe(
            map(([running, identity]) => this.formatStatus(running, identity)),
        )
        void this.store.load()

        this.completedSub = this.pairingSvc.completedPairing$.subscribe(_b => {
            // PairingService.completedPairing$ is a plain Subject (no replay)
            // so guarding against null initial emissions isn't required.
            this.zone.run(() => {
                this.pairing = null
                this.botToken = ''
                this.label = ''
                this.stopTicking()
            })
        })
    }

    ngOnDestroy (): void {
        this.completedSub.unsubscribe()
        this.stopTicking()
    }

    /**
     * Topic stats line. Recomputed on every change-detection pass by
     * touching the TopicService cache — cheap (Map iteration over dozens
     * of entries) and avoids subscribing to a per-mutation event stream
     * we don't otherwise need. Empty string when no binding exists.
     */
    get statsLine (): string {
        const current = this.store.current.find(b => b.platform === 'telegram')
        if (!current) return ''
        const { open, closed } = this.topics.getStatsForBinding(current.id)
        if (closed === 0) return `${open} topic${open === 1 ? '' : 's'}`
        return `${open} open · ${closed} archived`
    }

    async startPair (): Promise<void> {
        if (!this.botToken || this.busy) return
        this.busy = true
        this.error = ''
        try {
            this.pairing = await this.pairingSvc.beginTelegramPairing(
                this.botToken,
                this.label || undefined,
            )
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

    /** Hard-disconnect = remove binding entirely. The previous UI separated
     *  "disable" (binding stays, no traffic) from "remove" (binding deleted);
     *  the simplified UI keeps both because they're different intents — but
     *  surfaces Disconnect as the only destructive action since v0 caps us
     *  at one binding (you'd add a fresh one from scratch).
     *
     *  Topic-cache cleanup: BindingStore.remove only drops the binding
     *  record. Without forgetBinding the per-tab thread_id map under
     *  ~/.glanceterm/mobile-bridge-topics.json grows unbounded across
     *  disconnect/reconnect cycles (entries can't be re-addressed since
     *  the new binding gets a fresh uuid, but they're never deleted
     *  either). Done as fire-and-forget — forgetBinding is in-memory +
     *  schedules a save, can't fail in a way the user can act on. */
    disconnect (b: ChannelBinding): void {
        if (!confirm(
            `Disconnect "${b.label}"?\n\n`
            + 'Existing Forum Topics in the supergroup are not deleted — '
            + 'they become orphans (no new messages, history preserved). '
            + 'Clean them up manually on Telegram if you want.',
        )) return
        void this.topics.forgetBinding(b.id)
        void this.store.remove(b.id)
    }

    private formatStatus (running: boolean, identity: TgUser | null): string {
        if (!running) return 'Idle'
        if (identity?.username) return `@${identity.username} · connected`
        return 'Connected'
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
