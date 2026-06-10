/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Observable, combineLatest, of } from 'rxjs'
import { map, switchMap } from 'rxjs/operators'
import { SidebarSettingsRegistry, SectionStatus } from 'tabby-plugin-ai-sidebar'

import { ChannelBinding } from './binding/types'

/** Human label for the sidebar status line — matches the settings modal's
 *  own platformLabel(). */
function platformLabel (platform: ChannelBinding['platform']): string {
    switch (platform) {
        case 'telegram': return 'Telegram'
        case 'discord':  return 'Discord'
        default:         return 'Feishu / Lark'
    }
}

import { TabIdentityService } from './tab-identity.service'
import { TelegramBackend } from './backends/telegram/client.service'
import { FeishuBackend } from './backends/feishu/client.service'
import { DiscordBackend } from './backends/discord/client.service'
import { BackendRegistry } from './backends/registry.service'
import { TopicService } from './topic.service'
import { BindingStoreService } from './binding/store.service'
import { PairingService } from './binding/pairing.service'
import { OutboundDispatcherService } from './outbound-dispatcher.service'
import { InboundRouterService } from './inbound-router.service'
import { KeystrokeAdapterRegistry } from './pty-keystroke/registry'
import { TranscriptTailerService } from './transcript/tailer.service'
import { PtyTailerService } from './transcript/pty-tailer.service'
import { PermissionModeService } from './permission-mode.service'
import { PermissionRelayService } from './permission-relay.service'
import { TopicSyncService } from './topic-sync.service'
import { InstanceLockService } from './instance-lock.service'
import { KeystoreService } from './keystore.service'
import { BridgeSettingsComponent } from './settings/settings.component'

@NgModule({
    imports: [CommonModule, FormsModule],
    declarations: [BridgeSettingsComponent],
    providers: [
        TabIdentityService,
        TelegramBackend,
        FeishuBackend,
        DiscordBackend,
        BackendRegistry,
        TopicService,
        BindingStoreService,
        PairingService,
        OutboundDispatcherService,
        InboundRouterService,
        KeystrokeAdapterRegistry,
        TranscriptTailerService,
        PtyTailerService,
        PermissionModeService,
        PermissionRelayService,
        TopicSyncService,
        InstanceLockService,
        KeystoreService,
    ],
})
export default class MobileBridgeModule {
    constructor (
        // Eager-inject so the service subscribes to AppService.tabOpened$ /
        // tabsChanged$ at startup. Without this, identities only start
        // being tracked the first time a downstream consumer reads the
        // service — by then tabs that opened before that read have no UUID.
        _identity: TabIdentityService,
        // TelegramBackend is lazy by design — start() is called when a
        // binding becomes active. Inject here only for DI-graph
        // reachability in tooling.
        _telegram: TelegramBackend,
        // BackendRegistry routes per-binding platform → backend. Used
        // (not just DI-reachability) to derive the sidebar row's live
        // status from the active backend's running$/identity$.
        backends: BackendRegistry,
        // PairingService listens to inbound Telegram messages and watches
        // for `/bind <code>` — must be alive at app launch so a pending
        // pairing started by the UI doesn't miss the user's confirmation.
        _pairing: PairingService,
        // OutboundDispatcher subscribes to TabMonitor.states$ at construct
        // time. Eager-inject so transitions are observed from launch — a
        // permission prompt that fires before the first sidebar read
        // wouldn't notify otherwise.
        _dispatcher: OutboundDispatcherService,
        // InboundRouter subscribes to TelegramClient.inboundMessages$ at
        // construct time. Eager-inject so a reply that arrives before
        // anything else reads the service still routes to the PTY.
        _router: InboundRouterService,
        // TranscriptTailer subscribes to HookWatcher.snapshots$ at construct
        // time and drives the 2s poll timer. Eager-inject so the tail
        // window starts capturing the very first assistant turn after
        // GlanceTerm launch, not the first one after a sidebar render.
        _transcript: TranscriptTailerService,
        // PtyTailer subscribes to TabMonitor.states$ at construct time
        // and lazy-subscribes to each non-Claude tab's session.output$.
        // Eager so a non-Claude tab opened in the first second of launch
        // (before any sidebar render) still has its output mirrored to
        // the bridge.
        _ptyTailer: PtyTailerService,
        // PermissionModeService writes ~/.glanceterm/permission-relay.flag
        // and reflects the on-disk byte in the settings toggle. Eager so
        // a stale flag from a prior session is reconciled at launch
        // (initial read happens in the service constructor).
        _permissionMode: PermissionModeService,
        // PermissionRelayService starts the fs.watch on
        // ~/.glanceterm/permissions/ at construct time. Eager so a .req
        // written by the hook handler in the first 100 ms after launch
        // (rare but possible during quick agent restart) still reaches
        // the phone.
        _permissionRelay: PermissionRelayService,
        // TopicSyncService subscribes to identities$ + bindings$ at
        // construct time. Eager so a tab opened in the first second of
        // launch (before any sidebar render) still ends up mirrored to a
        // Forum Topic on the phone.
        _topicSync: TopicSyncService,
        // InstanceLockService runs its tryAcquire() in the constructor.
        // Eager so the lock decision is in flight before any side-effecting
        // service awaits isPrimary(). All gating callers await the same
        // promise so order-of-injection doesn't matter for correctness.
        _instanceLock: InstanceLockService,
        // BindingStoreService backs the sidebar row's status$ / enabled$ /
        // toggle. Also already an eager provider elsewhere; injecting here
        // doesn't change its lifecycle.
        store: BindingStoreService,
        // Contribute the Mobile Bridge settings panel into the AI sidebar's
        // gear modal (rather than Tabby's global Settings dialog) so the
        // bridge lives next to the other AI-tab settings the user already
        // looks for it under.
        sidebarSettings: SidebarSettingsRegistry,
    ) {
        // v0 caps bindings at one per platform and the settings UI only
        // shows bindings[0], so the row reflects that single binding.
        const binding$ = store.bindings$.pipe(map(bs => bs[0] as ChannelBinding | undefined))

        // Live one-liner + tone for the row — mirrors the logic
        // BridgeSettingsComponent renders inside the modal, surfaced here so
        // the user sees "connected / disabled / error" without opening it.
        const status$: Observable<SectionStatus | null> = binding$.pipe(
            switchMap(binding => {
                if (!binding) {
                    return of<SectionStatus>({ label: 'Not connected', tone: 'idle' })
                }
                const name = platformLabel(binding.platform)
                if (!binding.enabled) {
                    return of<SectionStatus>({ label: `${name} · disabled`, tone: 'disabled' })
                }
                const backend = backends.forPlatform(binding.platform)
                return combineLatest([backend.running$, backend.identity$, backend.lastError$]).pipe(
                    map(([running, identity, lastError]): SectionStatus => {
                        if (lastError) {
                            return { label: `${name} · auth error — reconfigure`, tone: 'error' }
                        }
                        if (running) {
                            return { label: `${identity?.displayName ?? name} · connected`, tone: 'connected' }
                        }
                        return { label: `${name} · connecting…`, tone: 'idle' }
                    }),
                )
            }),
        )

        // null when there's no binding → the host hides the inline switch.
        const enabled$: Observable<boolean | null> = binding$.pipe(
            map(binding => binding ? binding.enabled : null),
        )

        const setEnabled = (value: boolean): void => {
            const binding = store.current[0]
            if (binding) void store.update(binding.id, { enabled: value })
        }

        sidebarSettings.register({
            id: 'mobile-bridge',
            title: 'Mobile Bridge',
            description: 'Push permission prompts and completion notices to Telegram (and reply back to the agent from your phone).',
            component: BridgeSettingsComponent,
            status$,
            enabled$,
            setEnabled,
        })
        // eslint-disable-next-line no-console
        console.log('[glanceterm:mobile-bridge] plugin loaded')
    }
}
