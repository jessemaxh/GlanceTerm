import { Component, NgZone, OnDestroy } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { Observable, Subscription, combineLatest, of } from 'rxjs'
import { map, switchMap } from 'rxjs/operators'

import { BindingStoreService } from '../binding/store.service'
import { PairingDiagnostic, PairingService } from '../binding/pairing.service'
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
                        <!-- Setup checklist — collapsible, expanded by
                             default for first-time users. -->
                        <div class="border rounded p-2 mb-3 bg-dark small">
                            <a class="text-decoration-none d-block fw-bold"
                               href="javascript:void(0)"
                               (click)="showSetupSteps = !showSetupSteps">
                                {{ showSetupSteps ? '▼' : '▶' }} Telegram setup checklist
                            </a>
                            <ol *ngIf="showSetupSteps" class="mb-0 mt-2 ps-3">
                                <li>
                                    Open <strong>&#64;BotFather</strong> on Telegram.
                                    Send <code>/newbot</code>; pick a name + handle.
                                    BotFather replies with an <strong>HTTP API token</strong>
                                    (e.g. <code>1234:ABC...</code>). Copy it.
                                </li>
                                <li>
                                    Create a <strong>supergroup</strong> on Telegram
                                    (regular group ↛ "Convert to supergroup" in
                                    group settings). Forum Topics only work on
                                    supergroups.
                                </li>
                                <li>
                                    Group settings → <strong>Topics</strong> → enable.
                                    Group is now a forum with a "General" topic.
                                </li>
                                <li>
                                    Add your bot to the group + promote to
                                    <strong>admin</strong> with at least the
                                    <em>Manage Topics</em> permission.
                                </li>
                                <li>
                                    Paste the bot token below and click
                                    <strong>Generate pairing code</strong>.
                                </li>
                                <li>
                                    Back in Telegram → General topic → send
                                    <code>/bind XXXXXX</code> (the code shown
                                    after step 5). Binding completes automatically.
                                </li>
                            </ol>
                        </div>

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
                    </ng-container>

                    <!-- Feishu / Lark form -->
                    <ng-container *ngIf="platform === 'feishu'">
                        <div class="border rounded p-2 mb-3 bg-dark small">
                            <a class="text-decoration-none d-block fw-bold"
                               href="javascript:void(0)"
                               (click)="showSetupSteps = !showSetupSteps">
                                {{ showSetupSteps ? '▼' : '▶' }} Feishu / Lark setup checklist
                            </a>
                            <ol *ngIf="showSetupSteps" class="mb-0 mt-2 ps-3">
                                <li>
                                    Visit
                                    <strong>open.feishu.cn/app</strong>
                                    (or <strong>open.larksuite.com</strong> for
                                    international) → 创建企业自建应用.
                                </li>
                                <li>
                                    <strong>应用能力</strong> → 添加 <em>机器人</em>
                                    能力. Save.
                                </li>
                                <li>
                                    <strong>事件订阅</strong> → choose
                                    <em>WebSocket / 长连接</em> mode.
                                    <span class="text-warning">
                                        (Don't pick webhook — the bridge runs
                                        behind your local NAT and can't host one.)
                                    </span>
                                </li>
                                <li>
                                    In the same panel, subscribe to events:
                                    <code>im.message.receive_v1</code> and
                                    <code>card.action.trigger</code> at minimum.
                                </li>
                                <li>
                                    <strong>权限管理</strong> → 申请 the scopes:
                                    <code>im:message</code>,
                                    <code>im:message:send_as_bot</code>,
                                    <code>im:resource</code>. Save + publish
                                    a version of the app (the panel will guide
                                    you through the review / approval flow if
                                    your tenant requires admin approval).
                                </li>
                                <li>
                                    <strong>凭证与基础信息</strong> → copy
                                    <strong>App ID</strong> (starts with
                                    <code>cli_</code>) and <strong>App Secret</strong>.
                                </li>
                                <li>
                                    In the Feishu / Lark app, create a new group.
                                    Open group settings → enable
                                    <strong>话题模式 (Topic mode)</strong>.
                                </li>
                                <li>
                                    Add the bot to the group: tap +
                                    → 添加机器人 → pick your app.
                                </li>
                                <li>
                                    Paste credentials below, pick region,
                                    <strong>Generate pairing code</strong>.
                                </li>
                                <li>
                                    In the group → General topic → send
                                    <code>/bind XXXXXX</code> from your own
                                    account.
                                </li>
                            </ol>
                        </div>

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

                    <!-- Recent inbound activity. Shows the user that the
                         bot is actually receiving messages from their
                         group. If this stays empty, the bot probably
                         isn't in the right chat or its event
                         subscription isn't enabled. -->
                    <div class="border rounded p-2 mb-2 small">
                        <strong>Recent activity</strong>
                        <span *ngIf="recentActivity.length === 0" class="text-muted ms-2">
                            (no inbound messages yet — waiting for /bind…)
                        </span>
                        <ul *ngIf="recentActivity.length > 0" class="list-unstyled mb-0 mt-1">
                            <li *ngFor="let d of recentActivity"
                                class="border-bottom border-secondary py-1">
                                <span class="text-muted">{{ formatActivityTime(d.ts) }}</span>
                                <span class="ms-2">
                                    {{ d.senderName ? '@' + d.senderName : 'sender ' + d.senderId }}
                                </span>:
                                <span class="text-monospace">{{ d.textPreview }}</span>
                                <br/>
                                <span class="small"
                                      [class.text-success]="d.result === 'matched'"
                                      [class.text-warning]="d.result === 'malformed-bind' || d.result === 'expired'"
                                      [class.text-danger]="d.result === 'code-not-pending'"
                                      [class.text-muted]="d.result === 'not-bind'">
                                    {{ formatActivityResult(d) }}
                                </span>
                            </li>
                        </ul>
                    </div>

                    <!-- Why isn't /bind working? — expand by default if
                         the recent-activity list is empty for too long. -->
                    <div class="mb-2">
                        <a class="text-decoration-none small fw-bold"
                           href="javascript:void(0)"
                           (click)="showTroubleshooting = !showTroubleshooting">
                            {{ (showTroubleshooting || shouldHighlightTroubleshoot) ? '▼' : '▶' }}
                            Why isn't /bind working?
                        </a>
                        <ul *ngIf="showTroubleshooting || shouldHighlightTroubleshoot"
                            class="small mb-0 mt-1 ps-3">
                            <li>
                                Send the /bind <em>from your own account</em>
                                (not from the bot) in the group.
                                <strong>The exact code is case-sensitive.</strong>
                            </li>
                            <li *ngIf="pairing.platform === 'telegram'">
                                On Telegram, make sure the supergroup has
                                <strong>Forum Topics</strong> enabled and the
                                bot is admin with the
                                <em>Manage Topics</em> permission.
                            </li>
                            <li *ngIf="pairing.platform === 'feishu'">
                                On Feishu / Lark, your app's
                                <strong>事件订阅</strong> must be set to
                                <em>WebSocket / 长连接</em> mode (not webhook),
                                and the app version must be published /
                                approved by your tenant.
                            </li>
                            <li *ngIf="pairing.platform === 'feishu'">
                                Confirm the <strong>App ID + Secret</strong>
                                pasted above match the app the bot belongs to.
                                A typo on App Secret shows up as
                                <em>no inbound messages</em> here (the WS
                                handshake silently fails).
                            </li>
                            <li>
                                Codes expire in 5 min. If you waited too long
                                Cancel and start over.
                            </li>
                            <li>
                                Still nothing in <em>Recent activity</em> after
                                a minute? The bot isn't receiving anything.
                                Check the bot is actually a member of the
                                group, and that the group is the one you're
                                typing in.
                            </li>
                        </ul>
                    </div>

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

    /** Toggles for the collapsible setup-walkthrough sections. Default
     *  EXPANDED so the user sees the steps on the first visit; once they
     *  collapse it the setting only sticks for this dialog session. */
    showSetupSteps = true
    /** Pairing modal's "Why isn't /bind working?" troubleshooting fold. */
    showTroubleshooting = false
    /** Rolling buffer of the last few inbound messages observed during a
     *  pairing window — populated by PairingService.diagnostics$. UI
     *  shows newest first; capped at 8 so the modal doesn't grow without
     *  bound on a chatty group. */
    recentActivity: PairingDiagnostic[] = []

    private completedSub: Subscription
    private diagnosticsSub: Subscription | null = null
    private tickHandle: ReturnType<typeof setInterval> | null = null
    /** Set in ngOnDestroy. Async paths (startPair awaits beginXxxPairing)
     *  check this after their await before touching component state — if
     *  the modal closed during the round-trip we'd otherwise install a
     *  setInterval / Subscription that no consumer ever tears down. */
    private destroyed = false

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
                this.recentActivity = []
                this.stopTicking()
                this.stopDiagnostics()
            })
        })
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.completedSub.unsubscribe()
        this.stopDiagnostics()
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
            this.recentActivity = []
            this.stopDiagnostics()
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
            let result: PendingPairing
            if (this.platform === 'telegram') {
                result = await this.pairingSvc.beginTelegramPairing(
                    this.botToken,
                    this.label || undefined,
                )
            } else {
                result = await this.pairingSvc.beginFeishuPairing(
                    this.appId,
                    this.appSecret,
                    this.region,
                    this.label || undefined,
                )
            }
            // Re-check after the await — the user may have clicked the
            // modal's X between the start of beginXxxPairing and now,
            // which would have triggered ngOnDestroy. Installing a
            // setInterval and diagnostics subscription on a destroyed
            // component leaks both for up to 5 minutes (the pairing
            // expiry) or forever (no inbound emission to close the sub).
            // The pairing itself is fine to leave running — PairingService
            // owns it and sweepExpired will clear it.
            if (this.destroyed) {
                this.pairingSvc.cancelPending(result.code)
                return
            }
            this.pairing = result
            this.tickRemaining()
            this.tickHandle = setInterval(() => this.tickRemaining(), 30_000)
            this.startDiagnostics()
        } catch (err: unknown) {
            this.error = err instanceof Error ? err.message : String(err)
        } finally {
            this.busy = false
        }
    }

    /** Subscribe to the pairing service's diagnostics stream so the modal
     *  shows recent inbound activity. Newest first, capped to 8 rows.
     *  Filters to the platform we're currently pairing on. */
    private startDiagnostics (): void {
        this.stopDiagnostics()
        this.recentActivity = []
        this.diagnosticsSub = this.pairingSvc.diagnostics$.subscribe(d => {
            if (!this.pairing) return
            if (d.platform !== this.pairing.platform) return
            this.zone.run(() => {
                // O(1) prepend + truncate to 8. Newest first feels right
                // for a debug log — the user just sent something and
                // wants to see it appear at the top.
                this.recentActivity = [d, ...this.recentActivity].slice(0, 8)
            })
        })
    }

    private stopDiagnostics (): void {
        this.diagnosticsSub?.unsubscribe()
        this.diagnosticsSub = null
    }

    formatActivityTime (ts: number): string {
        const d = new Date(ts)
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        const ss = String(d.getSeconds()).padStart(2, '0')
        return `${hh}:${mm}:${ss}`
    }

    /** Human label for a diagnostic result code. */
    formatActivityResult (d: PairingDiagnostic): string {
        switch (d.result) {
            case 'matched':         return '✓ Matched — binding created'
            case 'code-not-pending': return '✗ Code not recognised (typo? expired earlier?)'
            case 'expired':         return '⏰ Code expired (generate a new one)'
            case 'malformed-bind':  return '✗ "/bind" without valid 6-char code'
            case 'not-bind':        return 'ℹ Not a /bind command (regular chat)'
        }
    }

    /** Returns true once we've shown the spinner long enough without a
     *  match to surface the "Why isn't it working?" hint by default. */
    get shouldHighlightTroubleshoot (): boolean {
        if (!this.pairing) return false
        // 30 s + nothing recent → highlight (this isn't a real timer; the
        // tickRemaining 30 s cadence drives change detection on the
        // modal so the getter is re-evaluated).
        return Date.now() - (this.pairing.expiresAt - 5 * 60_000) > 30_000
            && this.recentActivity.length === 0
    }

    cancelPair (): void {
        if (!this.pairing) return
        this.pairingSvc.cancelPending(this.pairing.code)
        this.pairing = null
        this.recentActivity = []
        this.stopDiagnostics()
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
