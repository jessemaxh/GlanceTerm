import * as semver from 'semver'

/**
 * Pure version-gating logic for the remote update check. Kept free of Angular /
 * Electron / fetch so the whole decision can be unit-tested in isolation — the
 * service (update-check.service.ts) is a thin shell that fetches the config,
 * reads the running version, calls in here, and renders the result.
 *
 * Fail-open is encoded HERE, not just at the network layer: every parse/compare
 * path that can't be fully trusted resolves to `none` (do nothing). A force
 * gate is a remote kill-switch; a malformed config, an unparseable version, or
 * a missing field must NEVER escalate to "block the app".
 */

export type UpdateAction = 'force' | 'notify' | 'none'
export type UpdatePlatform = 'mac' | 'win' | 'linux'

export interface UpdateConfig {
    /** Newest published version. current < latest → soft notify. */
    latest: string
    /** Oldest still-supported version. current < minimum → force update. */
    minimum: string
    /** Fallback URL (release notes / downloads page) when no per-platform
     *  binary URL is provided. */
    notes_url?: string
    /** Direct download URLs per platform. */
    downloads?: Partial<Record<UpdatePlatform, string>>
}

/**
 * Validate + normalize a raw fetched JSON blob into an UpdateConfig, or null if
 * it can't be trusted. Null is the fail-open signal — the caller does nothing.
 *
 * Requirements: `latest` and `minimum` must both be present, string-typed, and
 * valid version strings (`semver.valid`, which accepts SemVer including
 * pre-release tags like `1.0.0-alpha.1`). Everything else is optional and
 * silently dropped if the wrong type, so a partially-malformed config still
 * yields a usable core rather than nuking the whole check.
 */
export function parseUpdateConfig (raw: unknown): UpdateConfig | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    const { latest, minimum } = o
    if (typeof latest !== 'string' || typeof minimum !== 'string') return null
    if (semver.valid(latest) === null || semver.valid(minimum) === null) return null

    const config: UpdateConfig = { latest, minimum }
    if (typeof o.notes_url === 'string') config.notes_url = o.notes_url
    if (o.downloads && typeof o.downloads === 'object') {
        const d = o.downloads as Record<string, unknown>
        const downloads: Partial<Record<UpdatePlatform, string>> = {}
        for (const k of ['mac', 'win', 'linux'] as UpdatePlatform[]) {
            if (typeof d[k] === 'string') downloads[k] = d[k] as string
        }
        if (Object.keys(downloads).length > 0) config.downloads = downloads
    }
    return config
}

/**
 * Decide what to surface given the running version and a parsed config.
 *
 *   current < minimum → 'force'   (below the support floor — block + must update)
 *   current < latest  → 'notify'  (newer exists — dismissible nudge)
 *   otherwise         → 'none'    (up to date)
 *
 * Fail-open: a null config, or a version string semver can't parse on EITHER
 * side, collapses to 'none'. `semver.lt` throws on bad input, so the try/catch
 * is the last-line guarantee that no parse failure can ever escalate to
 * 'force'.
 */
export function decideUpdateAction (current: string, config: UpdateConfig | null): UpdateAction {
    if (!config) return 'none'
    try {
        if (semver.lt(current, config.minimum)) return 'force'
        if (semver.lt(current, config.latest)) return 'notify'
        return 'none'
    } catch {
        return 'none'
    }
}

/** Best download URL for a platform: the per-platform binary, else the shared
 *  notes/downloads page, else null (caller should then no-op the button). */
export function pickDownloadUrl (config: UpdateConfig, platform: UpdatePlatform): string | null {
    return config.downloads?.[platform] ?? config.notes_url ?? null
}

/** Map Node's `process.platform` to our 3-way platform key. Everything that
 *  isn't macOS/Windows (linux, *bsd, …) buckets to 'linux'. */
export function toUpdatePlatform (p: NodeJS.Platform): UpdatePlatform {
    if (p === 'darwin') return 'mac'
    if (p === 'win32') return 'win'
    return 'linux'
}
