/**
 * macOS update = NOTIFY + browser DMG download, never in-process install.
 *
 * electron-updater's mac install path runs Squirrel's ShipIt, which on macOS
 * 15/26 pops an "add a new helper tool" admin-password prompt — and Cancel
 * aborts the whole update, so users who won't type an admin password are stuck
 * (see fix/mac-update-no-helper-prompt). A drag-installed .dmg touches no
 * launchd helper and so never prompts. We keep electron-updater ONLY to detect
 * a newer version (the GitHub feed already tells us that); the "install" action
 * everywhere just opens the .dmg URL below in the browser.
 */

/** The GitHub repo hosting GlanceTerm releases. Keep in sync with the publish
 *  target in scripts/build-macos.mjs and the feed repo in
 *  tabby-electron/src/services/updater.service.ts — the auto-update FEED and
 *  this manual-download URL MUST resolve to the same releases, or a "Download"
 *  button would fetch a different version than the feed advertised. */
export const RELEASES_REPO = 'jessemaxh/GlanceTerm'

/** Direct .dmg download URL for `version`. The filename mirrors electron-builder's
 *  mac `artifactName` in electron-builder.yml (`GlanceTerm-${version}-macos-${arch}.${ext}`),
 *  so this must be updated in lockstep if that template changes. `arch` maps
 *  Node's `process.arch`; anything that isn't x64 is treated as arm64 (the only
 *  shipped mac arch today). */
export function macUpdateDownloadUrl (version: string, arch: string = process.arch): string {
    const a = arch === 'x64' ? 'x64' : 'arm64'
    return `https://github.com/${RELEASES_REPO}/releases/download/v${version}/GlanceTerm-${version}-macos-${a}.dmg`
}

/** The releases index — a never-404 fallback when a specific version's asset URL
 *  can't be built (e.g. a stray "install" trigger with no known version). */
export function releasesLatestUrl (): string {
    return `https://github.com/${RELEASES_REPO}/releases/latest`
}

/** True iff `latest` is a strictly newer x.y.z than `current`. Dependency-free
 *  numeric dotted compare: leading `v` and any `-prerelease`/`+build` suffix are
 *  stripped, then each numeric field is compared. A field that isn't a number
 *  makes the whole compare return false — a malformed version must never be
 *  treated as "newer" (which would nag the user toward a bogus download). */
export function isNewerVersion (latest: string, current: string): boolean {
    const parse = (v: string): number[] =>
        v.trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10))
    const a = parse(latest)
    const b = parse(current)
    if (a.length === 0 || a.some(Number.isNaN) || b.some(Number.isNaN)) {
        return false
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0
        const y = b[i] ?? 0
        if (x !== y) {
            return x > y
        }
    }
    return false
}
