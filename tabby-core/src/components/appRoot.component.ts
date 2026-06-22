/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, HostListener, HostBinding, ViewChildren, ViewChild, Inject, Optional } from '@angular/core'
import { trigger, style, animate, transition, state } from '@angular/animations'
import { NgbDropdown, NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop'

import { HostAppService, Platform } from '../api/hostApp'
import { HotkeysService } from '../services/hotkeys.service'
import { Logger, LogService } from '../services/log.service'
import { ConfigService } from '../services/config.service'
import { ThemesService } from '../services/themes.service'
import { UpdaterService } from '../services/updater.service'
import { CommandService } from '../services/commands.service'
import { ProfilesService } from '../services/profiles.service'

import { BaseTabComponent } from './baseTab.component'
import { SafeModeModalComponent } from './safeModeModal.component'
import { TabBodyComponent } from './tabBody.component'
import { SplitTabComponent } from './splitTab.component'
import { AppService, Command, CommandLocation, FileTransfer, HostWindowService, PlatformService } from '../api'
import { SidebarProvider, SidebarContribution } from '../api/sidebarProvider'
import { SidebarService } from '../services/sidebar.service'

function makeTabAnimation (dimension: string, size: number) {
    return [
        state('in', style({
            'flex-basis': '{{size}}',
            [dimension]: '{{size}}',
        }), {
            params: { size: `${size}px` },
        }),
        transition(':enter', [
            style({
                'flex-basis': '1px',
                [dimension]: '1px',
            }),
            animate('250ms ease-out', style({
                'flex-basis': '{{size}}',
                [dimension]: '{{size}}',
            })),
        ]),
        transition(':leave', [
            style({
                'flex-basis': 'auto',
                'padding-left': '*',
                'padding-right': '*',
                [dimension]: '*',
            }),
            animate('250ms ease-in-out', style({
                'padding-left': 0,
                'padding-right': 0,
                [dimension]: '0',
            })),
        ]),
    ]
}

/** @hidden */
@Component({
    selector: 'app-root',
    templateUrl: './appRoot.component.pug',
    styleUrls: ['./appRoot.component.scss'],
    animations: [
        trigger('animateTab', makeTabAnimation('width', 200)),
    ],
})
export class AppRootComponent {
    Platform = Platform
    @Input() ready = false
    @Input() leftToolbarButtons: Command[]
    @Input() rightToolbarButtons: Command[]
    @HostBinding('class.platform-win32') platformClassWindows = process.platform === 'win32'
    @HostBinding('class.platform-darwin') platformClassMacOS = process.platform === 'darwin'
    @HostBinding('class.platform-linux') platformClassLinux = process.platform === 'linux'
    @HostBinding('class.no-tabs') noTabs = true
    @ViewChildren(TabBodyComponent) tabBodies: TabBodyComponent[]
    @ViewChild('activeTransfersDropdown') activeTransfersDropdown: NgbDropdown
    unsortedTabs: BaseTabComponent[] = []
    updatesAvailable = false
    activeTransfers: FileTransfer[] = []
    private logger: Logger
    /** All sidebar contributions discovered from SidebarProvider multi-providers. */
    sidebars: SidebarContribution[] = []
    /** Bumped whenever the sidebar service emits a change — triggers re-render. */
    sidebarRevision = 0
    /** Currently-dragged sidebar id (during resize), or null. */
    private draggingSidebarId: string | null = null
    private dragStartX = 0
    private dragStartWidth = 0
    private dragSide: 'left' | 'right' = 'left'

    constructor (
        private hotkeys: HotkeysService,
        private commands: CommandService,
        public updater: UpdaterService,
        public hostWindow: HostWindowService,
        public hostApp: HostAppService,
        public config: ConfigService,
        public app: AppService,
        public sidebarService: SidebarService,
        private profilesService: ProfilesService,
        platform: PlatformService,
        log: LogService,
        ngbModal: NgbModal,
        _themes: ThemesService,
        @Optional() @Inject(SidebarProvider) sidebarProviders: SidebarProvider[] | null,
    ) {
        // Collect every sidebar contribution from every registered SidebarProvider.
        this.sidebars = (sidebarProviders ?? [])
            .flatMap(p => {
                try { return p.provide() } catch { return [] }
            })
        // Seed the service with each contribution's defaults.
        for (const s of this.sidebars) {
            this.sidebarService.setVisible(s.id, s.defaultVisible !== false)
            if (s.defaultWidth) this.sidebarService.setWidth(s.id, s.defaultWidth)
        }
        this.sidebarService.changes$.subscribe(n => { this.sidebarRevision = n })
        // document.querySelector('app-root')?.remove()
        this.logger = log.create('main')
        this.logger.info('v', platform.getAppVersion())

        this.hotkeys.hotkey$.subscribe((hotkey: string) => {
            if (hotkey.startsWith('tab-')) {
                const index = parseInt(hotkey.split('-')[1])
                if (index <= this.app.tabs.length) {
                    this.app.selectTab(this.app.tabs[index - 1])
                }
            }
            if (this.app.activeTab) {
                if (hotkey === 'close-tab') {
                    this.app.closeTab(this.app.activeTab, true)
                }
                if (hotkey === 'toggle-last-tab') {
                    this.app.toggleLastTab()
                }
                if (hotkey === 'next-tab') {
                    this.app.nextTab()
                }
                if (hotkey === 'previous-tab') {
                    this.app.previousTab()
                }
                if (hotkey === 'move-tab-left') {
                    this.app.moveSelectedTabLeft()
                }
                if (hotkey === 'move-tab-right') {
                    this.app.moveSelectedTabRight()
                }
                if (hotkey === 'duplicate-tab') {
                    this.app.duplicateTab(this.app.activeTab)
                }
                if (hotkey === 'restart-tab') {
                    this.app.duplicateTab(this.app.activeTab)
                    this.app.closeTab(this.app.activeTab, true)
                }
                if (hotkey === 'explode-tab' && this.app.activeTab instanceof SplitTabComponent) {
                    this.app.explodeTab(this.app.activeTab)
                }
                if (hotkey === 'combine-tabs' && this.app.activeTab instanceof SplitTabComponent) {
                    this.app.combineTabsInto(this.app.activeTab)
                }
            }
            if (hotkey === 'reopen-tab') {
                this.app.reopenLastTab()
            }
            if (hotkey === 'toggle-fullscreen') {
                hostWindow.toggleFullscreen()
            }
        })

        this.hostWindow.windowCloseRequest$.subscribe(async () => {
            this.app.closeWindow()
        })

        // File-menu commands routed from the main process to the focused window.
        // new-tab mirrors the "+" toolbar action (profile selector → launch);
        // close-tab mirrors the close-tab hotkey.
        this.hostApp.hostCommand$.subscribe(async command => {
            if (command === 'new-tab') {
                const profile = await this.profilesService.showProfileSelector().catch(() => null)
                if (profile) {
                    this.profilesService.launchProfile(profile)
                }
            }
            if (command === 'close-tab' && this.app.activeTab) {
                this.app.closeTab(this.app.activeTab, true)
            }
        })

        if (window['safeModeReason']) {
            ngbModal.open(SafeModeModalComponent)
        }

        this.app.tabOpened$.subscribe(tab => {
            this.unsortedTabs.push(tab)
            this.noTabs = false
            this.app.emitTabDragEnded()
        })

        this.app.tabRemoved$.subscribe(tab => {
            for (const tabBody of this.tabBodies) {
                if (tabBody.tab === tab) {
                    tabBody.detach()
                }
            }
            this.unsortedTabs = this.unsortedTabs.filter(x => x !== tab)
            this.noTabs = app.tabs.length === 0
            this.app.emitTabDragEnded()
        })

        platform.fileTransferStarted$.subscribe(transfer => {
            this.activeTransfers.push(transfer)
            this.activeTransfersDropdown.open()
        })

        config.ready$.toPromise().then(async () => {
            this.leftToolbarButtons = await this.getToolbarButtons(false)
            this.rightToolbarButtons = await this.getToolbarButtons(true)

            setInterval(() => {
                if (this.config.store.enableAutomaticUpdates) {
                    this.updater.check().then(available => {
                        this.updatesAvailable = available
                    })
                }
            }, 3600 * 12 * 1000)
        })
    }

    async ngOnInit () {
        this.config.ready$.toPromise().then(() => {
            this.ready = true
            this.app.emitReady()
        })
    }

    @HostListener('dragover')
    onDragOver () {
        return false
    }

    @HostListener('drop')
    onDrop () {
        return false
    }

    hasVerticalTabs () {
        return this.config.store.appearance.tabsLocation === 'left' || this.config.store.appearance.tabsLocation === 'right'
    }

    get targetTabSize (): any {
        if (this.hasVerticalTabs()) {
            return '*'
        }
        return this.config.store.appearance.flexTabs ? '*' : '200px'
    }

    onTabsReordered (event: CdkDragDrop<BaseTabComponent[]>) {
        const tab: BaseTabComponent = event.item.data
        if (!this.app.tabs.includes(tab)) {
            if (tab.parent instanceof SplitTabComponent) {
                tab.parent.removeTab(tab)
                this.app.wrapAndAddTab(tab)
            }
        }
        moveItemInArray(this.app.tabs, event.previousIndex, event.currentIndex)
        this.app.emitTabsChanged()
    }

    onTransfersChange () {
        if (this.activeTransfers.length === 0) {
            this.activeTransfersDropdown.close()
        }
    }

    @HostBinding('class.vibrant') get isVibrant () {
        return this.config.store?.appearance.vibrancy
    }

    // ── Sidebar helpers (used by template) ──────────────────────────────────

    get leftSidebars (): SidebarContribution[] {
        // sidebarRevision is read so Angular recomputes when service emits.
        void this.sidebarRevision
        return this.sidebars.filter(s => (s.side ?? 'left') === 'left' && this.sidebarService.isVisible(s.id))
    }

    get rightSidebars (): SidebarContribution[] {
        void this.sidebarRevision
        return this.sidebars.filter(s => s.side === 'right' && this.sidebarService.isVisible(s.id))
    }

    sidebarWidth (s: SidebarContribution): number {
        return this.sidebarService.getWidth(s.id, s.defaultWidth ?? 280)
    }

    /** trackBy for *ngFor — keeps the dynamic component from re-instantiating. */
    sidebarTrackById = (_: number, s: SidebarContribution): string => s.id

    onSidebarResizeStart (event: MouseEvent, s: SidebarContribution, side: 'left' | 'right'): void {
        event.preventDefault()
        this.draggingSidebarId = s.id
        this.dragStartX = event.clientX
        this.dragStartWidth = this.sidebarWidth(s)
        this.dragSide = side
        document.body.style.cursor = 'col-resize'
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.draggingSidebarId) return
        const contrib = this.sidebars.find(s => s.id === this.draggingSidebarId)
        if (!contrib) return
        const dx = event.clientX - this.dragStartX
        const signedDx = this.dragSide === 'left' ? dx : -dx
        const next = Math.min(
            contrib.maxWidth ?? 600,
            Math.max(contrib.minWidth ?? 180, this.dragStartWidth + signedDx),
        )
        this.sidebarService.setWidth(this.draggingSidebarId, next)
    }

    @HostListener('document:mouseup')
    onMouseUp (): void {
        if (this.draggingSidebarId) {
            this.draggingSidebarId = null
            document.body.style.cursor = ''
        }
    }

    private async getToolbarButtons (aboveZero: boolean): Promise<Command[]> {
        return (await this.commands.getCommands({ tab: this.app.activeTab ?? undefined }))
            .filter(x => x.locations?.includes(aboveZero ? CommandLocation.RightToolbar : CommandLocation.LeftToolbar))
    }

    toggleMaximize (): void {
        this.hostWindow.toggleMaximize()
    }

    protected isTitleBarNeeded (): boolean {
        return (
            this.config.store.appearance.frame === 'full'
            ||
                this.hostApp.platform !== Platform.macOS
                && this.config.store.appearance.frame === 'thin'
                && this.config.store.appearance.tabsLocation !== 'top'
                && this.config.store.appearance.tabsLocation !== 'bottom'
        )
    }
}
