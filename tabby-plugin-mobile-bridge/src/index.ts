/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'

import { TabIdentityService } from './tab-identity.service'
import { TelegramClientService } from './telegram/client.service'
import { BindingStoreService } from './binding/store.service'
import { PairingService } from './binding/pairing.service'

@NgModule({
    imports: [CommonModule],
    providers: [
        TabIdentityService,
        TelegramClientService,
        BindingStoreService,
        PairingService,
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
    ) {
        // eslint-disable-next-line no-console
        console.log('[glanceterm:mobile-bridge] plugin loaded')
    }
}
