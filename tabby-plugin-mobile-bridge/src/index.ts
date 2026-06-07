/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'

@NgModule({
    imports: [CommonModule],
    providers: [],
})
export default class MobileBridgeModule {
    constructor () {
        // eslint-disable-next-line no-console
        console.log('[glanceterm:mobile-bridge] plugin loaded')
    }
}
