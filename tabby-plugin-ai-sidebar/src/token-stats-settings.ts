import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { TranslateService } from 'tabby-core'

import { TokenStatsTabComponent } from './token-stats-tab.component'

/** Registers the standalone "Token Usage" page in Tabby Settings. @hidden */
@Injectable()
export class TokenStatsSettingsTabProvider extends SettingsTabProvider {
    id = 'glanceterm-token-usage'
    icon = 'chart-bar'
    title = this.translate.instant('Token Usage')

    constructor (private translate: TranslateService) { super() }

    getComponentType (): any {
        return TokenStatsTabComponent
    }
}
