import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Component, Input, Injector, Inject, Optional } from '@angular/core'
import { BaseTabProcess, WIN_BUILD_CONPTY_SUPPORTED, isWindowsBuild, GetRecoveryTokenOptions } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { LocalProfile, SessionOptions, UACService } from '../api'
import { Session } from '../session'

/** @hidden */
@Component({
    selector: 'terminalTab',
    template: BaseTerminalTabComponent.template,
    styles: BaseTerminalTabComponent.styles,
    animations: BaseTerminalTabComponent.animations,
})
export class TerminalTabComponent extends BaseTerminalTabComponent<LocalProfile> {
    @Input() sessionOptions: SessionOptions // Deprecated
    session: Session|null = null

    /**
     * GlanceTerm — the re-runnable AI agent command (e.g. `claude --resume foo`)
     * last observed alive in THIS terminal, written by the ai-sidebar plugin's
     * AutoResumeService on each capture tick and cleared when the agent exits.
     * Serialized into the recovery token (see getRecoveryToken) and restored
     * onto the recovered instance (see RecoveryProvider.recover) so the auto-
     * resume replay is keyed per-tab — two tabs sharing a cwd but running
     * different agents each get their own command back, instead of collapsing
     * onto a single cwd-keyed entry. Undefined when no agent is/was running.
     */
    glancetermResumeCommand?: string

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        injector: Injector,
        @Optional() @Inject(UACService) private uac: UACService|undefined,
    ) {
        super(injector)
    }

    ngOnInit (): void {
        this.sessionOptions = this.profile.options

        this.logger = this.log.create('terminalTab')

        const isConPTY = isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED) && this.config.store.terminal.useConPTY

        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput(isConPTY ? '\x1b[H' : '\x1bOH')
                    break
                case 'end':
                    this.sendInput(isConPTY ? '\x1b[F' : '\x1bOF')
                    break
            }
        })

        super.ngOnInit()
    }

    protected onFrontendReady (): void {
        this.initializeSession(this.size.columns, this.size.rows)
        this.savedStateIsLive = this.profile.options.restoreFromPTYID === this.session?.getID()
        super.onFrontendReady()
    }

    initializeSession (columns: number, rows: number): void {

        const session = new Session(this.injector)

        if (this.profile.options.runAsAdministrator && this.uac?.isAvailable) {
            this.profile = {
                ...this.profile,
                options: this.uac.patchSessionOptionsForUAC(this.profile.options),
            }
        }

        session.start({
            ...this.profile.options,
            width: columns,
            height: rows,
        })

        this.setSession(session)
        this.recoveryStateChangedHint.next()
    }

    async getRecoveryToken (options?: GetRecoveryTokenOptions): Promise<any> {
        const cwd = this.session ? await this.session.getWorkingDirectory() : null
        return {
            type: 'app:local-tab',
            profile: {
                ...this.profile,
                options: {
                    ...this.profile.options,
                    cwd: cwd ?? this.profile.options.cwd,
                    restoreFromPTYID: options?.includeState && this.session?.getID(),
                },
            },
            savedState: options?.includeState && this.frontend?.saveState(),
            // Only carried on the state-bearing recovery path (app restart /
            // close-tab stack), not on profile duplication (includeState
            // false) — duplicating a tab running claude shouldn't auto-launch
            // claude in the copy. `|| undefined` so JSON.stringify drops the
            // key entirely when there's no pending command.
            glancetermResumeCommand: options?.includeState
                ? (this.glancetermResumeCommand || undefined)
                : undefined,
        }
    }

    async getCurrentProcess (): Promise<BaseTabProcess|null> {
        const children = await this.session?.getChildProcesses()
        if (!children?.length) {
            return null
        }
        return {
            name: children[0].command,
        }
    }

    async canClose (): Promise<boolean> {
        const children = await this.session?.getChildProcesses()
        if (!children?.length) {
            return true
        }
        return (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant(
                    _('"{command}" is still running. Close?'),
                    children[0],
                ),
                buttons: [
                    this.translate.instant(_('Kill')),
                    this.translate.instant(_('Cancel')),
                ],
                defaultId: 0,
                cancelId: 1,
            },
        )).response === 0
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        this.session?.destroy()
    }

    /**
     * Return true if the user explicitly exit the session.
     * Always return true for terminalTab as the session can only be ended by the user
     */
    protected isSessionExplicitlyTerminated (): boolean {
        return true
    }
}
