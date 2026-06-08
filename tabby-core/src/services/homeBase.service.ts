import { Injectable, Inject } from '@angular/core'
import { ConfigService } from './config.service'
import { PlatformService, BOOTSTRAP_DATA, BootstrapData, HostAppService } from '../api'

@Injectable({ providedIn: 'root' })
export class HomeBaseService {
    appVersion: string

    /** @hidden */
    private constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private hostApp: HostAppService,
        @Inject(BOOTSTRAP_DATA) private bootstrapData: BootstrapData,
    ) {
        this.appVersion = platform.getAppVersion()
        // Upstream Tabby auto-fired `enableAnalytics()` here when the
        // user had previously enabled the toggle and was past the
        // welcome screen. Now that enableAnalytics is a no-op (no
        // telemetry backend) the auto-fire is dead code; the call is
        // dropped so a future re-enable has to be deliberate.
    }

    openGitHub (): void {
        this.platform.openExternal('https://github.com/jessemaxh/glanceterm')
    }

    openDiscord (): void {
        this.platform.openExternal('https://discord.gg/pEjhUPtxTG')
    }

    // openTranslations() removed: the "Help translate" link in the
    // settings UI was hidden when GlanceTerm dropped its tie to the
    // upstream Tabby Weblate portal. Restore the method (and the
    // settings link in settingsTab.component.pug) when a translation
    // portal is set up.

    reportBug (): void {
        let body = `Version: ${this.appVersion}\n`
        body += `Platform: ${this.hostApp.platform} ${process.arch} ${this.platform.getOSRelease()}\n`
        const plugins = this.bootstrapData.installedPlugins.filter(x => !x.isBuiltin).map(x => x.name)
        body += `Plugins: ${plugins.join(', ') || 'none'}\n`
        body += `Frontend: ${this.config.store.terminal?.frontend}\n\n`
        this.platform.openExternal(`https://github.com/jessemaxh/glanceterm/issues/new?body=${encodeURIComponent(body)}`)
    }

    enableAnalytics (): void {
        // No-op for GlanceTerm. Kept on the public surface because
        // upstream Tabby still references the method shape (and a future
        // GlanceTerm telemetry pipeline would re-implement it here). The
        // settings + welcome tabs no longer expose a toggle that calls
        // it, and the auto-fire from this service's constructor was
        // dropped — so today nothing reaches this body, intentionally.
        //
        // The upstream implementation initialised a Mixpanel client
        // against `bb4638b0860eef14c04d4fbc5eb365fa` (Tabby's API key)
        // and tracked `freshInstall` + `launch` events with
        // distinct_id / platform / os / version. Reproduce that shape
        // when wiring up our own backend.
    }
}
