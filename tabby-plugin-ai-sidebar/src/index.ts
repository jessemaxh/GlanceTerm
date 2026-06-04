/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule, Injectable } from '@angular/core'
import { CommonModule } from '@angular/common'
import {
    ConfigProvider,
    HotkeyProvider,
    SidebarProvider,
    SidebarContribution,
    SidebarService,
    ToolbarButtonProvider,
    ToolbarButton,
} from 'tabby-core'

import { AiSidebarComponent } from './sidebar.component'
import { AiSidebarConfigProvider } from './ai-config-provider'
import { AiSidebarHotkeyProvider } from './ai-hotkey-provider'
import { AttentionJumperService } from './attention-jumper.service'
import { AttentionNotifierService } from './attention-notifier.service'
import { TabMonitor } from './tab-monitor'

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <rect x="1" y="2" width="5" height="12" rx="1" fill="currentColor" opacity="0.85"/>
  <rect x="7" y="2" width="8" height="3" rx="1" fill="currentColor" opacity="0.55"/>
  <rect x="7" y="6" width="8" height="3" rx="1" fill="currentColor" opacity="0.55"/>
  <rect x="7" y="10" width="8" height="4" rx="1" fill="currentColor" opacity="0.55"/>
</svg>`

@Injectable()
class AiSidebarContribProvider extends SidebarProvider {
    provide (): SidebarContribution[] {
        return [{
            id: 'ai-sidebar',
            title: 'AI Tabs',
            component: AiSidebarComponent,
            side: 'left',
            defaultWidth: 300,
            minWidth: 260,
            maxWidth: 500,
            defaultVisible: true,
        }]
    }
}

@Injectable()
class ToggleAiSidebarButtonProvider extends ToolbarButtonProvider {
    constructor (private sidebar: SidebarService) {
        super()
    }
    provide (): ToolbarButton[] {
        return [{
            icon: ICON_SVG,
            title: 'Toggle AI Tabs sidebar',
            weight: 5,
            click: () => this.sidebar.toggle('ai-sidebar'),
        }]
    }
}

@NgModule({
    imports: [CommonModule],
    declarations: [AiSidebarComponent],
    providers: [
        TabMonitor,
        AttentionJumperService,
        AttentionNotifierService,
        { provide: SidebarProvider,       useClass: AiSidebarContribProvider,      multi: true },
        { provide: ToolbarButtonProvider, useClass: ToggleAiSidebarButtonProvider, multi: true },
        { provide: HotkeyProvider,        useClass: AiSidebarHotkeyProvider,       multi: true },
        { provide: ConfigProvider,        useClass: AiSidebarConfigProvider,       multi: true },
    ],
})
export default class AiSidebarModule {
    /** Eagerly inject the jumper + notifier services so they subscribe at startup. */
    constructor (_j: AttentionJumperService, _n: AttentionNotifierService) {
        // eslint-disable-next-line no-console
        console.log('[ai-sidebar] plugin loaded')
    }
}
