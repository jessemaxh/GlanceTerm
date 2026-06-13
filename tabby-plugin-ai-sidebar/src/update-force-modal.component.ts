import { Component } from '@angular/core'

/**
 * Blocking "you must update" modal. Opened by UpdateCheckService via
 * NgbModal with `{ backdrop: 'static', keyboard: false }` and NO close
 * affordance in the template, so the user genuinely cannot dismiss it and
 * keep using an unsupported build — they either download the new version or
 * quit. The actual download/quit actions are injected as callbacks by the
 * service (so this component stays free of Electron/Platform deps and the
 * service owns the one place that opens external URLs / quits).
 */
@Component({
    template: `
        <div class="modal-body" style="padding: 2rem 1.75rem; text-align: center;">
            <h4 style="margin: 0 0 .75rem;">Update required</h4>
            <p style="opacity: .8; margin: 0 0 1.25rem; line-height: 1.5;">
                Your version <code>{{ currentVersion }}</code> is no longer supported.
                Update to <code>{{ latestVersion }}</code> to keep using GlanceTerm
                <span style="opacity: .7;">(minimum required: <code>{{ requiredVersion }}</code>)</span>.
            </p>
            <div style="display: flex; gap: .75rem; justify-content: center;">
                <button class="btn btn-primary btn-lg" (click)="onDownload()">Download latest</button>
                <button class="btn btn-secondary btn-lg" (click)="onQuit()">Quit</button>
            </div>
        </div>
    `,
})
export class UpdateForceModalComponent {
    currentVersion = ''
    requiredVersion = ''
    latestVersion = ''
    /** Wired by UpdateCheckService — open the download URL. */
    onDownload: () => void = () => { /* set by opener */ }
    /** Wired by UpdateCheckService — quit the app. */
    onQuit: () => void = () => { /* set by opener */ }
}
