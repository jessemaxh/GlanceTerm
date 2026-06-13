import { describe, it, expect } from 'vitest'

import {
    parseUpdateConfig,
    decideUpdateAction,
    pickDownloadUrl,
    toUpdatePlatform,
    UpdateConfig,
} from '../update-decision'

describe('decideUpdateAction', () => {
    const cfg: UpdateConfig = { latest: '1.2.0', minimum: '1.1.0' }

    it('forces when current is below minimum', () => {
        expect(decideUpdateAction('1.0.0', cfg)).toBe('force')
    })

    it('notifies when current is >= minimum but < latest', () => {
        expect(decideUpdateAction('1.1.0', cfg)).toBe('notify') // == minimum
        expect(decideUpdateAction('1.1.5', cfg)).toBe('notify') // between
    })

    it('does nothing when current == latest', () => {
        expect(decideUpdateAction('1.2.0', cfg)).toBe('none')
    })

    it('does nothing when current is ahead of latest (dev/nightly)', () => {
        expect(decideUpdateAction('1.3.0', cfg)).toBe('none')
    })

    // Pre-release handling — the running app is 1.0.0-alpha.1.
    it('treats a pre-release as BELOW its release (alpha < 1.0.0 → force)', () => {
        expect(decideUpdateAction('1.0.0-alpha.1', { latest: '1.1.0', minimum: '1.0.0' })).toBe('force')
    })

    it('notifies a pre-release that clears the floor but trails latest', () => {
        expect(decideUpdateAction('1.0.0-alpha.1', { latest: '1.1.0', minimum: '0.9.0' })).toBe('notify')
    })

    // Fail-open guarantees — nothing here may ever return 'force'.
    it('fails open (none) on a null config', () => {
        expect(decideUpdateAction('1.0.0', null)).toBe('none')
    })

    it('fails open (none) on an unparseable current version', () => {
        expect(decideUpdateAction('not-a-version', cfg)).toBe('none')
        expect(decideUpdateAction('', cfg)).toBe('none')
    })
})

describe('parseUpdateConfig', () => {
    it('accepts a well-formed config and keeps optional fields', () => {
        const c = parseUpdateConfig({
            latest: '2.0.0',
            minimum: '1.5.0',
            notes_url: 'https://x/releases',
            downloads: { mac: 'https://x/a.dmg', win: 'https://x/a.exe' },
        })
        expect(c).toEqual({
            latest: '2.0.0',
            minimum: '1.5.0',
            notes_url: 'https://x/releases',
            downloads: { mac: 'https://x/a.dmg', win: 'https://x/a.exe' },
        })
    })

    it('accepts the minimal config (just latest + minimum)', () => {
        expect(parseUpdateConfig({ latest: '2.0.0', minimum: '1.0.0' }))
            .toEqual({ latest: '2.0.0', minimum: '1.0.0' })
    })

    it.each([
        ['not an object', null],
        ['not an object', 'nope'],
        ['missing minimum', { latest: '1.0.0' }],
        ['missing latest', { minimum: '1.0.0' }],
        ['non-string latest', { latest: 1, minimum: '1.0.0' }],
        ['invalid semver latest', { latest: 'banana', minimum: '1.0.0' }],
        ['invalid semver minimum', { latest: '1.0.0', minimum: 'x' }],
    ])('returns null on bad input: %s', (_label, raw) => {
        expect(parseUpdateConfig(raw)).toBeNull()
    })

    it('drops non-string download entries but keeps the valid ones', () => {
        const c = parseUpdateConfig({
            latest: '1.0.0', minimum: '1.0.0',
            downloads: { mac: 'https://x/a.dmg', win: 42, linux: null },
        })
        expect(c?.downloads).toEqual({ mac: 'https://x/a.dmg' })
    })

    it('omits downloads entirely when none are valid', () => {
        const c = parseUpdateConfig({ latest: '1.0.0', minimum: '1.0.0', downloads: { win: 5 } })
        expect(c?.downloads).toBeUndefined()
    })
})

describe('pickDownloadUrl', () => {
    const cfg: UpdateConfig = {
        latest: '1.0.0', minimum: '1.0.0',
        notes_url: 'https://x/releases',
        downloads: { mac: 'https://x/a.dmg' },
    }

    it('prefers the per-platform binary URL', () => {
        expect(pickDownloadUrl(cfg, 'mac')).toBe('https://x/a.dmg')
    })

    it('falls back to notes_url when the platform has no binary', () => {
        expect(pickDownloadUrl(cfg, 'win')).toBe('https://x/releases')
    })

    it('returns null when neither a binary nor notes_url exists', () => {
        expect(pickDownloadUrl({ latest: '1.0.0', minimum: '1.0.0' }, 'linux')).toBeNull()
    })
})

describe('toUpdatePlatform', () => {
    it('maps darwin/win32 and buckets everything else to linux', () => {
        expect(toUpdatePlatform('darwin')).toBe('mac')
        expect(toUpdatePlatform('win32')).toBe('win')
        expect(toUpdatePlatform('linux')).toBe('linux')
        expect(toUpdatePlatform('freebsd' as NodeJS.Platform)).toBe('linux')
    })
})
