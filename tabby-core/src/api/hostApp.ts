import { Observable, Subject } from 'rxjs'
import { Injector } from '@angular/core'
import { Logger, LogService } from '../services/log.service'

export enum Platform {
    Linux = 'Linux',
    macOS = 'macOS',
    Windows = 'Windows',
    Web = 'Web',
}

/**
 * Provides interaction with the main process
 */
export abstract class HostAppService {
    abstract get platform (): Platform
    abstract get configPlatform (): Platform

    protected settingsUIRequest = new Subject<void>()
    protected configChangeBroadcast = new Subject<void>()
    protected openRecoveredTab = new Subject<any>()
    protected hostCommand = new Subject<string>()
    protected logger: Logger

    /**
     * Fired when Preferences is selected in the macOS menu
     */
    get settingsUIRequest$ (): Observable<void> { return this.settingsUIRequest }

    /**
     * Fired when another window modified the config file
     */
    get configChangeBroadcast$ (): Observable<void> { return this.configChangeBroadcast }

    /**
     * Fired when this (newly opened) window is handed a tab recovery token to
     * adopt — the other half of [[moveTabToNewWindow]].
     */
    get openRecoveredTab$ (): Observable<any> { return this.openRecoveredTab }

    /**
     * Fired when the application menu (main process) asks this window to run a
     * renderer-side command — e.g. `'new-tab'` / `'close-tab'` from the File
     * menu. Delivered only to the focused window.
     */
    get hostCommand$ (): Observable<string> { return this.hostCommand }

    constructor (
        injector: Injector,
    ) {
        this.logger = injector.get(LogService).create('hostApp')
    }

    abstract newWindow (): void

    /**
     * Opens a new window and hands it `token` (a full tab recovery token) to
     * adopt. Used to move a tab — including its live session — into a fresh
     * window. The receiving window fires [[openRecoveredTab$]].
     */
    abstract moveTabToNewWindow (token: any): void

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    emitReady (): void { }

    abstract relaunch (): void

    abstract quit (): void
}
