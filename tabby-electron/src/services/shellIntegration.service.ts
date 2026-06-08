import * as path from 'path'
import * as fs from 'mz/fs'
import { exec } from 'mz/child_process'
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

/* eslint-disable block-scoped-var */

try {
    var wnr = require('windows-native-registry') // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch (_) { }

@Injectable({ providedIn: 'root' })
export class ShellIntegrationService {
    private automatorWorkflows = ['Open GlanceTerm here.workflow', 'Paste path into GlanceTerm.workflow']
    private automatorWorkflowsLocation: string
    private automatorWorkflowsDestination: string
    private registryKeys = [
        {
            path: 'Software\\Classes\\Directory\\Background\\shell\\GlanceTerm',
            value: 'Open GlanceTerm here',
            command: 'open "%V"',
        },
        {
            path: 'SOFTWARE\\Classes\\Directory\\shell\\GlanceTerm',
            value: 'Open GlanceTerm here',
            command: 'open "%V"',
        },
        {
            path: 'Software\\Classes\\*\\shell\\GlanceTerm',
            value: 'Paste path into GlanceTerm',
            command: 'paste "%V"',
        },
    ]
    /** Legacy registry / Services keys carried over from the upstream Tabby
     *  shell-integration. Cleaned up on each install() so a user who had
     *  Tabby installed before GlanceTerm doesn't end up with two parallel
     *  "Open here" entries in their context menu. */
    private legacyRegistryPaths = [
        'Software\\Classes\\Directory\\Background\\shell\\Tabby',
        'SOFTWARE\\Classes\\Directory\\shell\\Tabby',
        'Software\\Classes\\*\\shell\\Tabby',
        'Software\\Classes\\Directory\\Background\\shell\\Open Tabby here',
        'Software\\Classes\\*\\shell\\Paste path into Tabby',
    ]
    private legacyAutomatorWorkflows = ['Open Tabby here.workflow', 'Paste path into Tabby.workflow']

    private constructor (
        private electron: ElectronService,
        private hostApp: HostAppService,
    ) {
        if (this.hostApp.platform === Platform.macOS) {
            this.automatorWorkflowsLocation = path.join(
                path.dirname(path.dirname(this.electron.app.getPath('exe'))),
                'Resources',
                'extras',
                'automator-workflows',
            )
            this.automatorWorkflowsDestination = path.join(process.env.HOME!, 'Library', 'Services')
        }
        this.updatePaths()
    }

    async isInstalled (): Promise<boolean> {
        if (this.hostApp.platform === Platform.macOS) {
            return fs.exists(path.join(this.automatorWorkflowsDestination, this.automatorWorkflows[0]))
        } else if (this.hostApp.platform === Platform.Windows) {
            return !!wnr.getRegistryKey(wnr.HK.CU, this.registryKeys[0].path)
        }
        return true
    }

    async install (): Promise<void> {
        const exe: string = process.env.PORTABLE_EXECUTABLE_FILE ?? this.electron.app.getPath('exe')
        if (this.hostApp.platform === Platform.macOS) {
            // Sweep legacy upstream-Tabby workflow files first so a user
            // who had Tabby's Services entries doesn't end up with two
            // parallel "Open … here" items in their Finder right-click.
            for (const wf of this.legacyAutomatorWorkflows) {
                await exec(`rm -rf "${this.automatorWorkflowsDestination}/${wf}"`).catch(() => { /* ignore */ })
            }
            for (const wf of this.automatorWorkflows) {
                await exec(`cp -r "${this.automatorWorkflowsLocation}/${wf}" "${this.automatorWorkflowsDestination}"`)
            }
        } else if (this.hostApp.platform === Platform.Windows) {
            for (const registryKey of this.registryKeys) {
                wnr.createRegistryKey(wnr.HK.CU, registryKey.path)
                wnr.createRegistryKey(wnr.HK.CU, registryKey.path + '\\command')
                wnr.setRegistryValue(wnr.HK.CU, registryKey.path, '', wnr.REG.SZ, registryKey.value)
                wnr.setRegistryValue(wnr.HK.CU, registryKey.path, 'Icon', wnr.REG.SZ, exe)
                wnr.setRegistryValue(wnr.HK.CU, registryKey.path + '\\command', '', wnr.REG.SZ, exe + ' ' + registryKey.command)
            }

            // Sweep legacy upstream-Tabby registry entries for the same
            // reason — avoid a duplicate "Open Tabby here" sitting next to
            // our "Open GlanceTerm here" in Windows Explorer's context menu.
            for (const legacy of this.legacyRegistryPaths) {
                if (wnr.getRegistryKey(wnr.HK.CU, legacy)) {
                    wnr.deleteRegistryKey(wnr.HK.CU, legacy)
                }
            }
        }
    }

    async remove (): Promise<void> {
        if (this.hostApp.platform === Platform.macOS) {
            for (const wf of this.automatorWorkflows) {
                await exec(`rm -rf "${this.automatorWorkflowsDestination}/${wf}"`)
            }
        } else if (this.hostApp.platform === Platform.Windows) {
            for (const registryKey of this.registryKeys) {
                wnr.deleteRegistryKey(wnr.HK.CU, registryKey.path)
            }
        }
    }

    private async updatePaths (): Promise<void> {
        // Update paths in case of an update
        if (this.hostApp.platform === Platform.Windows) {
            if (await this.isInstalled()) {
                await this.install()
            }
        }
    }
}
