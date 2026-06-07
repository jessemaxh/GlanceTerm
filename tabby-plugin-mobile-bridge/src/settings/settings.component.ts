import { Component, NgZone, OnDestroy } from '@angular/core'
import { Observable, Subscription } from 'rxjs'

import { BindingStoreService } from '../binding/store.service'
import { PairingService } from '../binding/pairing.service'
import { ChannelBinding, PendingPairing } from '../binding/types'
import type { BridgeEventType } from '../outbound-dispatcher.service'

/**
 * Minimal settings panel for the Mobile Bridge plugin. Renders inside
 * Tabby's Settings dialog as a tab provided by BridgeSettingsTabProvider.
 *
 * v0 scope: enough to add/remove a Telegram binding, toggle enabled,
 * edit approvedSenders, and pick event-type filters. Inline template +
 * raw inputs — no fancy styling. Polish lives downstream of dogfood
 * feedback.
 */
@Component({
    selector: 'bridge-settings',
    template: `
        <div class="content-box">
            <h3>Mobile Bridge</h3>

            <p class="text-muted small">
                Bidirectional bridge to Telegram (and soon 飞书). Phone gets
                permission prompts &amp; completion notices per tab; replies
                in the Forum Topic inject into the same tab's PTY.
            </p>

            <h4 class="mt-4">Bindings</h4>
            <div *ngIf="(bindings$ | async)?.length === 0" class="text-muted">
                No bindings yet — add one below.
            </div>

            <div *ngFor="let b of bindings$ | async" class="binding-row p-2 mb-2 border rounded">
                <div class="d-flex align-items-center mb-2">
                    <strong>{{ b.label }}</strong>
                    <span class="badge bg-secondary mx-2">{{ b.platform }}</span>
                    <label class="ms-auto me-2">
                        <input type="checkbox" [checked]="b.enabled" (change)="toggleEnabled(b)"/>
                        Enabled
                    </label>
                    <button class="btn btn-sm btn-danger" (click)="remove(b)">Remove</button>
                </div>
                <div class="small text-muted mb-2">chat: {{ b.chatId }} · owner: {{ b.ownerUserId }}</div>

                <div class="form-group mb-2">
                    <label class="small">Approved senders (comma-separated Telegram user ids):</label>
                    <input type="text" class="form-control form-control-sm"
                           [value]="b.approvedSenders.join(', ')"
                           (change)="updateSenders(b, $event)"/>
                </div>

                <div class="form-group">
                    <label class="small d-block">Event filter (empty = defaults):</label>
                    <label *ngFor="let evt of EVENT_TYPES" class="me-3">
                        <input type="checkbox"
                               [checked]="filterChecked(b, evt)"
                               (change)="toggleFilter(b, evt)"/>
                        {{ evt }}
                    </label>
                </div>
            </div>

            <h4 class="mt-4">Add Telegram binding</h4>

            <div *ngIf="!pairing">
                <div class="form-group mb-2">
                    <label class="small">Bot token (from @BotFather):</label>
                    <input type="password" class="form-control" [(ngModel)]="botToken"
                           placeholder="123456789:ABC..."/>
                </div>
                <div class="form-group mb-2">
                    <label class="small">Label (optional):</label>
                    <input type="text" class="form-control" [(ngModel)]="label"
                           placeholder="My Telegram"/>
                </div>
                <button class="btn btn-primary" (click)="startPair()"
                        [disabled]="!botToken || busy">
                    Generate pairing code
                </button>
                <div *ngIf="error" class="text-danger mt-2">{{ error }}</div>
            </div>

            <div *ngIf="pairing" class="alert alert-info">
                <p>Open Telegram, find your bot's supergroup (Forum Topics must be
                enabled), and send <strong>from the chat (not a DM)</strong>:</p>
                <pre class="bg-dark text-white p-2 rounded">/bind {{ pairing.code }}</pre>
                <p class="small text-muted mb-2">Expires in {{ remainingMin }} min.
                The bot must be a member &amp; admin of the chat.</p>
                <button class="btn btn-sm btn-secondary" (click)="cancelPair()">Cancel</button>
            </div>

            <h4 class="mt-4">Audit log</h4>
            <p class="small text-muted">
                Inbound messages from non-whitelisted senders are silently
                dropped and logged to
                <code>~/.glanceterm/mobile-bridge.log</code> (JSONL).
            </p>
        </div>
    `,
})
export class BridgeSettingsComponent implements OnDestroy {
    bindings$: Observable<ChannelBinding[]>
    botToken = ''
    label = ''
    pairing: PendingPairing | null = null
    remainingMin = 0
    error = ''
    busy = false

    readonly EVENT_TYPES: BridgeEventType[] = [
        'needs_permission', 'task_completed', 'task_failed', 'tool_use', 'state_transition',
    ]
    private readonly DEFAULT_ON: BridgeEventType[] = ['needs_permission', 'task_completed', 'task_failed']

    private completedSub: Subscription
    private tickHandle: ReturnType<typeof setInterval> | null = null

    constructor (
        private store: BindingStoreService,
        private pairingSvc: PairingService,
        private zone: NgZone,
    ) {
        this.bindings$ = this.store.bindings$
        void this.store.load()

        this.completedSub = this.pairingSvc.completedPairing$.subscribe(_b => {
            // Plain Subject now (was BehaviorSubject) — no replay on
            // resubscribe, so we don't need to guard against null
            // initial emissions any more.
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

    remove (b: ChannelBinding): void {
        if (!confirm(`Remove binding "${b.label}"? Forum Topics on Telegram stay.`)) return
        void this.store.remove(b.id)
    }

    updateSenders (b: ChannelBinding, event: Event): void {
        const value = (event.target as HTMLInputElement).value
        const senders = value.split(',').map(s => s.trim()).filter(s => s.length > 0)
        // Always keep the owner — accidental removal would lock the owner
        // out of their own binding.
        if (!senders.includes(b.ownerUserId)) senders.unshift(b.ownerUserId)
        void this.store.update(b.id, { approvedSenders: senders })
    }

    filterChecked (b: ChannelBinding, evt: BridgeEventType): boolean {
        if (b.eventFilter.length === 0) return this.DEFAULT_ON.includes(evt)
        return b.eventFilter.includes(evt)
    }

    toggleFilter (b: ChannelBinding, evt: BridgeEventType): void {
        const current = b.eventFilter.length > 0
            ? [...b.eventFilter] as BridgeEventType[]
            : [...this.DEFAULT_ON]
        const idx = current.indexOf(evt)
        if (idx >= 0) current.splice(idx, 1)
        else current.push(evt)
        void this.store.update(b.id, { eventFilter: current })
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
