/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'

import { TabIdentityService } from './tab-identity.service'
import { TelegramClientService } from './telegram/client.service'
import { TopicService } from './telegram/topic.service'
import { BindingStoreService } from './binding/store.service'
import { PairingService } from './binding/pairing.service'
import { OutboundDispatcherService } from './outbound-dispatcher.service'

@NgModule({
    imports: [CommonModule],
    providers: [
        TabIdentityService,
        TelegramClientService,
        TopicService,
        BindingStoreService,
        PairingService,
        OutboundDispatcherService,
    ],
})
export default class MobileBridgeModule {
    constructor (
        // Eager-inject so the service subscribes to AppService.tabOpened$ /
        // tabsChanged$ at startup. Without this, identities only start
        // being tracked the first time a downstream consumer reads the
        // service — by then tabs that opened before that read have no UUID.
        _identity: TabIdentityService,
        // TelegramClientService is lazy by design — bindings call start()
        // with a token when configured. Inject it here only to keep DI
        // graph reachability obvious in tooling.
        _telegram: TelegramClientService,
        // PairingService listens to inbound Telegram messages and watches
        // for `/bind <code>` — must be alive at app launch so a pending
        // pairing started by the UI doesn't miss the user's confirmation.
        _pairing: PairingService,
        // OutboundDispatcher subscribes to TabMonitor.states$ at construct
        // time. Eager-inject so transitions are observed from launch — a
        // permission prompt that fires before the first sidebar read
        // wouldn't notify otherwise.
        _dispatcher: OutboundDispatcherService,
    ) {
        // eslint-disable-next-line no-console
        console.log('[glanceterm:mobile-bridge] plugin loaded')
    }
}
