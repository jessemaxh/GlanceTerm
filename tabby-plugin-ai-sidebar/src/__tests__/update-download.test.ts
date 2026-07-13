import { describe, it, expect } from 'vitest'

// The main-process update helpers live in app/lib; app/ has no test runner of
// its own, so we exercise the pure functions from the plugin's vitest suite.
import { macUpdateDownloadUrl, isNewerVersion, releasesLatestUrl } from '../../../app/lib/updateDownload'

describe('macUpdateDownloadUrl', () => {
    // REGRESSION GUARD: this must match electron-builder.yml mac `artifactName`
    // (`GlanceTerm-${version}-macos-${arch}.${ext}`) and the real release asset
    // name (verified: GlanceTerm-0.3.5-macos-arm64.dmg). If the filename template
    // ever changes, this test fails and the "Download" button would 404.
    it('builds the exact release .dmg URL (arm64)', () => {
        expect(macUpdateDownloadUrl('0.3.6', 'arm64')).toBe(
            'https://github.com/jessemaxh/GlanceTerm/releases/download/v0.3.6/GlanceTerm-0.3.6-macos-arm64.dmg',
        )
    })
    it('maps x64 arch', () => {
        expect(macUpdateDownloadUrl('1.2.3', 'x64')).toContain('GlanceTerm-1.2.3-macos-x64.dmg')
    })
    it('treats any non-x64 arch as arm64 (only shipped mac arch)', () => {
        expect(macUpdateDownloadUrl('1.2.3', 'ia32')).toContain('-macos-arm64.dmg')
    })
    it('tags the release with a leading v', () => {
        expect(macUpdateDownloadUrl('9.9.9', 'arm64')).toContain('/releases/download/v9.9.9/')
    })
})

describe('releasesLatestUrl', () => {
    it('points at the releases index (never-404 fallback)', () => {
        expect(releasesLatestUrl()).toBe('https://github.com/jessemaxh/GlanceTerm/releases/latest')
    })
})

describe('isNewerVersion', () => {
    it('true when latest > current', () => {
        expect(isNewerVersion('0.3.6', '0.3.5')).toBe(true)
        expect(isNewerVersion('0.4.0', '0.3.9')).toBe(true)
        expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
        expect(isNewerVersion('0.3.10', '0.3.9')).toBe(true) // numeric, not lexical
    })
    it('false when equal or older (no downgrade nag)', () => {
        expect(isNewerVersion('0.3.5', '0.3.5')).toBe(false)
        expect(isNewerVersion('0.3.4', '0.3.5')).toBe(false)
        expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false)
    })
    it('tolerates a leading v and prerelease/build suffixes', () => {
        expect(isNewerVersion('v0.3.6', '0.3.5')).toBe(true)
        expect(isNewerVersion('0.3.6-beta.1', '0.3.5')).toBe(true)
        expect(isNewerVersion('0.3.6+build.9', '0.3.5')).toBe(true)
    })
    it('fail-safe: a malformed version is never "newer"', () => {
        expect(isNewerVersion('garbage', '0.3.5')).toBe(false)
        expect(isNewerVersion('', '0.3.5')).toBe(false)
        expect(isNewerVersion('0.3.6', 'not-a-version')).toBe(false)
    })
})
