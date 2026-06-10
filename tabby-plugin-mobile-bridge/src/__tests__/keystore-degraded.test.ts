import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression guard for the degraded (write-refuse) mode of
 * KeystoreService: a secrets file that EXISTS but fails to load
 * (corrupt JSON, EACCES, truncated sync) must never be overwritten by
 * a subsequent save — that would destroy every secret it still holds.
 * Only ENOENT (genuinely fresh install) may start empty AND writable.
 *
 * fs/promises is mocked module-wide; KeystoreService's file paths live
 * under the real homedir but no call ever reaches the disk.
 */

const fsMock = vi.hoisted(() => ({
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
}))

vi.mock('fs/promises', () => ({ ...fsMock, default: fsMock }))

import { KeystoreService } from '../keystore.service'

function enoent (): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory')
    err.code = 'ENOENT'
    return err
}

describe('KeystoreService degraded mode', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        fsMock.mkdir.mockResolvedValue(undefined)
        fsMock.writeFile.mockResolvedValue(undefined)
        fsMock.rename.mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('refuses write() when the secrets file is corrupt JSON', async () => {
        fsMock.readFile.mockImplementation(async (p: string) => {
            if (String(p).endsWith('.salt')) throw enoent()    // fresh salt is fine
            return '{ this is not json'                        // corrupt secrets file
        })
        const ks = new KeystoreService()

        await expect(ks.write('id1', 'secret')).rejects.toThrow(/refusing to write/)
        // The store file must never be touched — only the freshly created
        // salt file may have been written.
        const writes = fsMock.writeFile.mock.calls.map(c => String(c[0]))
        expect(writes.some(p => p.includes('secrets.enc'))).toBe(false)
        expect(fsMock.rename).not.toHaveBeenCalled()
    })

    it('refuses write() when the secrets file is unreadable (EACCES)', async () => {
        fsMock.readFile.mockImplementation(async (p: string) => {
            if (String(p).endsWith('.salt')) throw enoent()
            const err: NodeJS.ErrnoException = new Error('EACCES: permission denied')
            err.code = 'EACCES'
            throw err
        })
        const ks = new KeystoreService()

        await expect(ks.write('id1', 'secret')).rejects.toThrow(/refusing to write/)
    })

    it('reads behave as "no entry" in degraded mode, without throwing the degraded error', async () => {
        fsMock.readFile.mockImplementation(async (p: string) => {
            if (String(p).endsWith('.salt')) throw enoent()
            return 'not json either'
        })
        const ks = new KeystoreService()

        expect(await ks.has('id1')).toBe(false)
        await expect(ks.read('id1')).rejects.toThrow(/no entry/)
        // delete of a nonexistent id is a no-op and must not save
        await ks.delete('id1')
        expect(fsMock.rename).not.toHaveBeenCalled()
    })

    it('stays writable on a genuinely fresh install (ENOENT)', async () => {
        fsMock.readFile.mockImplementation(async () => { throw enoent() })
        const ks = new KeystoreService()

        await expect(ks.write('id1', 'secret')).resolves.toBeUndefined()
        // atomic write path: tmp file written, then renamed over the real file
        const writes = fsMock.writeFile.mock.calls.map(c => String(c[0]))
        expect(writes.some(p => p.includes('secrets.enc'))).toBe(true)
        expect(fsMock.rename).toHaveBeenCalled()
    })
})
