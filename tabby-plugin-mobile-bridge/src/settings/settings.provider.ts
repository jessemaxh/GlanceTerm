import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { BridgeSettingsComponent } from './settings.component'

/** Registers a "Mobile Bridge" tab in Tabby's Settings dialog. */
@Injectable()
export class BridgeSettingsTabProvider extends SettingsTabProvider {
    id = 'mobile-bridge'
    icon = 'fas fa-mobile-alt'
    title = 'Mobile Bridge'
    /** Just before tabby-plugin-manager so it sits with the bridge family. */
    weight = 10

    getComponentType (): any { return BridgeSettingsComponent }
}
