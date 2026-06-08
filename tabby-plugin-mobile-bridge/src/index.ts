/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { SidebarSettingsRegistry } from 'tabby-plugin-ai-sidebar'

import { TabIdentityService } from './tab-identity.service'
import { TelegramBackend } from './backends/telegram/client.service'
import { FeishuBackend } from './backends/feishu/client.service'
import { BackendRegistry } from './backends/registry.service'
import { TopicService } from './topic.service'
import { BindingStoreService } from './binding/store.service'
import { PairingService } from './binding/pairing.service'
import { OutboundDispatcherService } from './outbound-dispatcher.service'
import { InboundRouterService } from './inbound-router.service'
import { KeystrokeAdapterRegistry } from './pty-keystroke/registry'
import { TranscriptTailerService } from './transcript/tailer.service'
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
        BackendRegistry,
        TopicService,
        BindingStoreService,
        PairingService,
        OutboundDispatcherService,
        InboundRouterService,
        KeystrokeAdapterRegistry,
        TranscriptTailerService,
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
        // BackendRegistry routes per-binding platform → backend.
        _backends: BackendRegistry,
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
        // Contribute the Mobile Bridge settings panel into the AI sidebar's
        // gear modal (rather than Tabby's global Settings dialog) so the
        // bridge lives next to the other AI-tab settings the user already
        // looks for it under.
        sidebarSettings: SidebarSettingsRegistry,
    ) {
        sidebarSettings.register({
            id: 'mobile-bridge',
            title: 'Mobile Bridge',
            description: 'Push permission prompts and completion notices to Telegram (and reply back to the agent from your phone).',
            component: BridgeSettingsComponent,
        })
        // eslint-disable-next-line no-console
        console.log('[glanceterm:mobile-bridge] plugin loaded')
    }
}
