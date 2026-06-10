import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression guard for BindingStoreService's degraded (mutation-refuse)
 * mode, sibling of keystore-degraded.test.ts. Three distinct degraded
 * sources are covered because each carries different recovery guidance:
 *
 *   1. bindings file unreadable / corrupt JSON  → "restore or delete it"
 *   2. valid JSON but not an array              → "inspect/fix it"
 *      (the adversarial-review bypass: JSON.parse succeeds, so the old
 *      code stayed writable and the next save destroyed the file)
 *   3. credential migration failure             → keystore is to blame;
 *      the guidance must NOT tell the user to delete the intact
 *      bindings file
 *
 * fs/promises is mocked module-wide — nothing touches the real disk.
 */

const fsMock = vi.hoisted(() => ({
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    appendFile: vi.fn(),
}))

vi.mock('fs/promises', () => ({ ...fsMock, default: fsMock }))

import { BindingStoreService } from '../binding/store.service'
import { BindingDraft } from '../binding/types'
import { KeystoreService } from '../keystore.service'

function enoent (): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory')
    err.code = 'ENOENT'
    return err
}

function makeKeystoreStub () {
    return {
        write: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        read: vi.fn(),
        has: vi.fn(),
    } as unknown as KeystoreService
}

const DRAFT: BindingDraft = {
    platform: 'telegram',
    label: 'phone',
    credentials: { platform: 'telegram', botToken: '123456:ABCDEF' },
    chatId: 'c1',
    ownerUserId: 'u1',
    approvedSenders: ['u1'],
    enabled: true,
    eventFilter: [],
}

/** True iff writeFile ever targeted the bindings file (via its tmp). */
function wroteBindingsFile (): boolean {
    return fsMock.writeFile.mock.calls.some(c => String(c[0]).includes('mobile-bridge-bindings.json'))
}

describe('BindingStoreService degraded mode', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        fsMock.mkdir.mockResolvedValue(undefined)
        fsMock.writeFile.mockResolvedValue(undefined)
        fsMock.rename.mockResolvedValue(undefined)
    })

    it('refuses mutations when the bindings file is corrupt JSON', async () => {
        fsMock.readFile.mockResolvedValue('{ this is not json')
        const keystore = makeKeystoreStub()
        const store = new BindingStoreService(keystore)

        await expect(store.add(DRAFT)).rejects.toThrow(/failed to load/)
        expect(store.current).toEqual([])
        // fail-fast: the doomed add() must not even persist the secret
        expect(keystore.write).not.toHaveBeenCalled()
        expect(wroteBindingsFile()).toBe(false)
    })

    it('refuses mutations when the file is valid JSON but not an array', async () => {
        fsMock.readFile.mockResolvedValue('{"bindings": []}')
        const store = new BindingStoreService(makeKeystoreStub())

        await expect(store.add(DRAFT)).rejects.toThrow(/not an array/)
        expect(store.current).toEqual([])
        expect(wroteBindingsFile()).toBe(false)
    })

    it('blames the keystore — not the bindings file — when migration fails', async () => {
        // healthy legacy file with a plaintext token → migrate() must
        // write it to the keystore, which we make fail like a corrupt
        // secrets file would
        fsMock.readFile.mockResolvedValue(JSON.stringify([{
            id: 'b1',
            platform: 'telegram',
            label: 'phone',
            botToken: '123456:ABCDEF',
            chatId: 'c1',
            ownerUserId: 'u1',
            approvedSenders: ['u1'],
            enabled: true,
            eventFilter: [],
            createdAt: 1,
        }]))
        const keystore = makeKeystoreStub()
        ;(keystore.write as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error('KeystoreService: refusing to write — the existing secrets file failed to load'),
        )
        const store = new BindingStoreService(keystore)

        const err = await store.add(DRAFT).then(() => null, e => e as Error)
        expect(err).not.toBeNull()
        expect(err!.message).toMatch(/credential migration failed/)
        expect(err!.message).toMatch(/do NOT delete/)
        // the bindings file itself is intact — guidance must not carry
        // the corrupt-file recovery text that suggests deleting it
        expect(err!.message).not.toMatch(/delete it\s+to start fresh/)
        expect(wroteBindingsFile()).toBe(false)
        // exactly the one write from the migration attempt; the rejected
        // add() fails fast and never reaches the keystore again
        expect(keystore.write).toHaveBeenCalledTimes(1)
    })

    it('stays writable on a genuinely fresh install (ENOENT)', async () => {
        fsMock.readFile.mockRejectedValue(enoent())
        const keystore = makeKeystoreStub()
        const store = new BindingStoreService(keystore)

        const binding = await store.add(DRAFT)
        expect(binding.id).toBeTruthy()
        expect(store.current).toHaveLength(1)
        expect(keystore.write).toHaveBeenCalledTimes(1)
        expect(wroteBindingsFile()).toBe(true)
        expect(fsMock.rename).toHaveBeenCalled()
    })
})
