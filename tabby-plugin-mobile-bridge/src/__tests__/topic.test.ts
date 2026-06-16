import { describe, expect, it, vi } from 'vitest'
import * as os from 'os'

import {
    TopicService,
    TopicEntry,
    FORCED_CLOSE_COOLDOWN_MS,
} from '../topic.service'
import { ChannelBinding } from '../binding/types'
import { TabIdentity } from '../tab-identity.service'
import { MessagingBackend } from '../backends/types'

/**
 * Minimal MessagingBackend stub. Records every method call as a tuple
 * so the test can assert "call count" / "called with X" without pulling
 * in vitest's spy machinery for what's a 4-method surface.
 */
function makeBackendStub () {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const record = (method: string) => (...args: unknown[]) => {
        calls.push({ method, args })
        return Promise.resolve(method === 'createThread' ? 't1' : undefined)
    }
    const backend: MessagingBackend = {
        platform: 'telegram',
        sendText: record('sendText'),
        sendInteractive: record('sendInteractive'),
        editMessage: record('editMessage'),
        sendPhoto: record('sendPhoto'),
        createThread: record('createThread'),
        renameThread: record('renameThread'),
        closeThread: record('closeThread'),
        reopenThread: record('reopenThread'),
        ackCallback: record('ackCallback'),
        inbound$: { subscribe: () => ({ unsubscribe: () => {} }) } as any,
        callbacks$: { subscribe: () => ({ unsubscribe: () => {} }) } as any,
        lastError$: { subscribe: () => ({ unsubscribe: () => {} }) } as any,
    } as unknown as MessagingBackend
    return { backend, calls }
}

function makeRegistry (backend: MessagingBackend): any {
    return { forPlatform: () => backend }
}

/**
 * Mark the TopicService as loaded with an empty cache, bypassing the
 * fs.readFile that load() would otherwise do against the user's real
 * `~/.glanceterm/mobile-bridge-topics.json`. Without this, a test
 * running on a machine with existing topic state would observe
 * pre-seeded entries (and would mutate them on save, if save fires).
 */
function bypassLoad (svc: TopicService): void {
    ;(svc as any).cache = new Map()
    ;(svc as any).loaded = true
    ;(svc as any).loadPromise = null
    // Neutralize the disk-save side effect so syncCloseTopic doesn't
    // schedule a writeback to the user's real
    // `~/.glanceterm/mobile-bridge-topics.json` after the test tears down.
    ;(svc as any).scheduleSave = () => {}
}

const IDENTITY: TabIdentity = {
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee1234',
    displayIndex: 3,
    name: 'my-tab',
    cwd: '/Users/me/work/repo',
}

const BINDING: ChannelBinding = {
    id: 'bind-1',
    platform: 'telegram',
    label: 'work',
    credentials: { platform: 'telegram', botToken: { ref: 's' }, chatId: '100' } as any,
    chatId: '100',
    ownerUserId: 'u1',
    approvedSenders: ['u1'],
    enabled: true,
    eventFilter: [],
    createdAt: 0,
}

const KEY = (tabUuid: string) => `${BINDING.id}|${tabUuid}`

/**
 * Tests for the close-side hardening shipped to fix Critical #1+#2 from
 * the 2026-06-09 review:
 *   - syncCloseTopic honours FORCED_CLOSE_COOLDOWN_MS even with force=true
 *   - peekEntry exposes a synchronous read for the inbound-router
 *     cooldown gate without paying for `await load()` per message
 *   - formatTitle bakes the ✓ marker into the closed-state title so
 *     follow-up retitles don't strip it
 */

describe('TopicService.formatTitle', () => {
    // Machine name is baked from os.hostname() at module load; mirror the
    // source's first-label extraction so the assertion is host-independent.
    const MACHINE = os.hostname().split('.')[0] || os.hostname()

    it('open: no marker, "<cwd folder>@<machine>"', () => {
        const svc = new TopicService(makeRegistry(makeBackendStub().backend))
        expect(svc.formatTitle(IDENTITY)).toBe(`repo@${MACHINE}`)
    })

    it('closed: ✓ prefix on the open form', () => {
        const svc = new TopicService(makeRegistry(makeBackendStub().backend))
        expect(svc.formatTitle(IDENTITY, 'closed')).toBe(`✓ repo@${MACHINE}`)
    })

    it('falls back to identity.name when cwd is missing', () => {
        const svc = new TopicService(makeRegistry(makeBackendStub().backend))
        const noCwd: TabIdentity = { ...IDENTITY, cwd: undefined }
        expect(svc.formatTitle(noCwd)).toBe(`my-tab@${MACHINE}`)
    })
})

describe('TopicService.peekEntry', () => {
    it('returns null before load (sync caller must not get a misleading hit)', () => {
        const svc = new TopicService(makeRegistry(makeBackendStub().backend))
        expect(svc.peekEntry(BINDING.id, IDENTITY.uuid)).toBeNull()
    })

    it('returns null for missing keys after load', async () => {
        const svc = new TopicService(makeRegistry(makeBackendStub().backend))
        // Force load via a public method that calls load(); ensureTopic
        // is the smallest one. Stub createThread so it returns synchronously.
        bypassLoad(svc)
        expect(svc.peekEntry(BINDING.id, IDENTITY.uuid)).toBeNull()
    })

    it('returns the cache entry when present', async () => {
        const svc = new TopicService(makeRegistry(makeBackendStub().backend))
        bypassLoad(svc)
        const entry: TopicEntry = {
            threadId: 't1',
            lastTitle: 'before',
            status: 'open',
        }
        ;(svc as any).cache.set(KEY(IDENTITY.uuid), entry)
        const got = svc.peekEntry(BINDING.id, IDENTITY.uuid)
        expect(got).toEqual(entry)
    })
})

describe('TopicService.syncCloseTopic — cooldown', () => {
    async function primeClosed (svc: TopicService, closedAt: number) {
        bypassLoad(svc)
        ;(svc as any).cache.set(KEY(IDENTITY.uuid), {
            threadId: 't1',
            lastTitle: '✓ #3 · repo · 1234',
            status: 'closed',
            closedAt,
        } as TopicEntry)
    }

    it('force=true is suppressed within FORCED_CLOSE_COOLDOWN_MS of last close', async () => {
        const { backend, calls } = makeBackendStub()
        const svc = new TopicService(makeRegistry(backend))
        const now = 1_780_000_000_000
        vi.spyOn(Date, 'now').mockReturnValue(now)
        await primeClosed(svc, now - 5_000) // 5 s ago, well inside the 30 s window

        await svc.syncCloseTopic(BINDING, IDENTITY.uuid, undefined, true)

        // No backend calls at all — the cooldown short-circuited before any
        // rename / sendText / closeThread fired.
        expect(calls).toHaveLength(0)
        vi.restoreAllMocks()
    })

    it('force=true runs again past the cooldown window', async () => {
        const { backend, calls } = makeBackendStub()
        const svc = new TopicService(makeRegistry(backend))
        const now = 1_780_000_000_000
        vi.spyOn(Date, 'now').mockReturnValue(now)
        await primeClosed(svc, now - (FORCED_CLOSE_COOLDOWN_MS + 1_000))

        await svc.syncCloseTopic(BINDING, IDENTITY.uuid, undefined, true)

        // Expect closeThread (and the archive notice sendText) to have
        // fired exactly once. Rename is skipped because lastTitle already
        // matches the closed form.
        const methods = calls.map(c => c.method)
        expect(methods).toContain('sendText')
        expect(methods).toContain('closeThread')
        expect(methods.filter(m => m === 'closeThread')).toHaveLength(1)
        vi.restoreAllMocks()
    })

    it('non-force on closed entry is suppressed regardless of cooldown', async () => {
        const { backend, calls } = makeBackendStub()
        const svc = new TopicService(makeRegistry(backend))
        const now = 1_780_000_000_000
        vi.spyOn(Date, 'now').mockReturnValue(now)
        await primeClosed(svc, now - 60 * 60 * 1000) // 1 h ago — past cooldown

        await svc.syncCloseTopic(BINDING, IDENTITY.uuid, undefined, false)

        expect(calls).toHaveLength(0)
        vi.restoreAllMocks()
    })
})

/**
 * syncDeleteTopic powers the launch-time orphan purge (TopicSyncService):
 * native delete when the backend supports it, degrade-to-close otherwise.
 */
describe('TopicService.syncDeleteTopic', () => {
    const seedOpen = (svc: TopicService) => {
        ;(svc as any).cache.set(KEY(IDENTITY.uuid), {
            threadId: 't1', lastTitle: 'repo@host', status: 'open',
        } as TopicEntry)
    }

    it('native deleteThread: deletes and drops the cache entry', async () => {
        const { backend, calls } = makeBackendStub()
        ;(backend as any).deleteThread = (...args: unknown[]) => {
            calls.push({ method: 'deleteThread', args })
            return Promise.resolve()
        }
        const svc = new TopicService(makeRegistry(backend))
        bypassLoad(svc)
        seedOpen(svc)

        await svc.syncDeleteTopic(BINDING, IDENTITY.uuid)

        const methods = calls.map(c => c.method)
        expect(methods).toContain('deleteThread')
        expect(methods).not.toContain('closeThread')
        expect((svc as any).cache.has(KEY(IDENTITY.uuid))).toBe(false)
    })

    it('no native delete: degrades to closeThread and keeps the entry (closed)', async () => {
        const { backend, calls } = makeBackendStub() // stub has no deleteThread
        const svc = new TopicService(makeRegistry(backend))
        bypassLoad(svc)
        seedOpen(svc)

        await svc.syncDeleteTopic(BINDING, IDENTITY.uuid)

        const methods = calls.map(c => c.method)
        expect(methods).toContain('closeThread')
        expect(methods).not.toContain('deleteThread')
        expect((svc as any).cache.get(KEY(IDENTITY.uuid))?.status).toBe('closed')
    })

    it('no-op when the tab has no cached topic', async () => {
        const { backend, calls } = makeBackendStub()
        const svc = new TopicService(makeRegistry(backend))
        bypassLoad(svc)

        await svc.syncDeleteTopic(BINDING, IDENTITY.uuid)

        expect(calls).toHaveLength(0)
    })
})
