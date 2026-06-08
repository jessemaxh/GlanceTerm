import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

import { ChannelBinding } from './binding/types'
import { TabIdentity } from './tab-identity.service'
import { BackendRegistry } from './backends/registry.service'
import { MessagingError, ThreadRef } from './backends/types'

/**
 * Persisted cache entry: which thread we created for a given tab, the
 * title we last pushed (rename detection), and the open/closed status
 * mirror so we can tell "tab still alive" from "tab was closed, topic is
 * archived."
 */
export interface TopicEntry {
    threadId: ThreadRef
    lastTitle: string
    status: 'open' | 'closed'
    closedAt?: number
}

/**
 * Per-tab thread lifecycle cache, keyed by `(bindingId, tabUuid)`.
 *
 * Two writers:
 *   - TopicSyncService — proactive create/close/reopen driven by diffs
 *     between TabIdentityService.identities$ and this cache.
 *   - Outbound dispatcher (via {@link ensureTopic}) — last-resort lazy
 *     create + read-only lookup on the send path, for the early-launch
 *     race window where sync hasn't reconciled yet.
 *
 * Cross-platform note: this service is messaging-platform agnostic. The
 * actual thread create/close/edit calls go through {@link BackendRegistry}
 * → {@link MessagingBackend}, dispatched per `binding.platform`. Telegram
 * Forum Topics, Feishu threads, and Discord forum posts all map to the
 * same `TopicEntry` shape — the differences (Feishu's "edit anchor to
 * mark closed" vs Telegram's native closeForumTopic) live inside the
 * backend implementation, not here.
 *
 * Title format:
 *     #<displayIndex> · <tab-name> · <uuid-suffix>
 * where uuid-suffix is the last 4 chars of the UUID. We rebuild on every
 * sync — if the user reorders tabs, displayIndex drifts and we re-edit.
 */
@Injectable()
export class TopicService {
    private static readonly FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge-topics.json')

    private cache = new Map<string, TopicEntry>()
    private loaded = false
    private loadPromise: Promise<void> | null = null
    private saveTimer: ReturnType<typeof setTimeout> | null = null
    /** In-flight create dedup keyed on `(bindingId, tabUuid)`. */
    private inFlight = new Map<string, Promise<ThreadRef>>()

    constructor (private backends: BackendRegistry) {}

    /**
     * Resolve the threadId for `(binding, identity)`, creating the thread
     * on the platform side if we've never seen this tab before. Fallback
     * path — TopicSyncService normally creates proactively when a tab
     * appears, but a send arriving in the early-launch race window calls
     * ensureTopic to bootstrap. Doesn't auto-reopen a closed entry; that
     * decision is delegated to the caller (dispatcher handles
     * {@link MessagingError} kind=thread_closed explicitly).
     */
    async ensureTopic (binding: ChannelBinding, identity: TabIdentity): Promise<ThreadRef> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const cached = this.cache.get(key)
        if (cached) {
            void this.syncTitle(binding, identity).catch(err => {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:topic] title sync failed:', err)
            })
            return cached.threadId
        }
        const inFlight = this.inFlight.get(key)
        if (inFlight) return inFlight

        const promise = (async () => {
            try {
                const name = this.formatTitle(identity)
                const threadId = await this.backends.forPlatform(binding.platform)
                    .createThread(binding.chatId, name)
                this.cache.set(key, {
                    threadId,
                    lastTitle: name,
                    status: 'open',
                })
                this.scheduleSave()
                return threadId
            } finally {
                this.inFlight.delete(key)
            }
        })()
        this.inFlight.set(key, promise)
        return promise
    }

    /** Update the thread title if it's drifted. Idempotent. */
    async syncTitle (binding: ChannelBinding, identity: TabIdentity): Promise<void> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const entry = this.cache.get(key)
        if (!entry) return
        const expected = this.formatTitle(identity)
        if (entry.lastTitle === expected) return
        try {
            await this.backends.forPlatform(binding.platform)
                .renameThread(binding.chatId, entry.threadId, expected)
            entry.lastTitle = expected
            this.scheduleSave()
        } catch (err: unknown) {
            // Thread deleted on the platform side — drop the cache entry
            // so ensureTopic re-creates next call.
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
            }
            throw err
        }
    }

    // ── TopicSyncService surface ─────────────────────────────────────────

    async snapshotForBinding (bindingId: string): Promise<Array<{ tabUuid: string; entry: TopicEntry }>> {
        await this.load()
        const prefix = `${bindingId}|`
        const out: Array<{ tabUuid: string; entry: TopicEntry }> = []
        for (const [k, v] of this.cache) {
            if (!k.startsWith(prefix)) continue
            out.push({ tabUuid: k.substring(prefix.length), entry: { ...v } })
        }
        return out
    }

    async syncCreateTopic (binding: ChannelBinding, identity: TabIdentity): Promise<ThreadRef> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const cached = this.cache.get(key)
        if (cached) return cached.threadId
        const inFlight = this.inFlight.get(key)
        if (inFlight) return inFlight

        const promise = (async () => {
            try {
                const name = this.formatTitle(identity)
                const threadId = await this.backends.forPlatform(binding.platform)
                    .createThread(binding.chatId, name)
                this.cache.set(key, {
                    threadId,
                    lastTitle: name,
                    status: 'open',
                })
                this.scheduleSave()
                return threadId
            } finally {
                this.inFlight.delete(key)
            }
        })()
        this.inFlight.set(key, promise)
        return promise
    }

    async syncCloseTopic (binding: ChannelBinding, tabUuid: string): Promise<void> {
        await this.load()
        const key = this.key(binding.id, tabUuid)
        const entry = this.cache.get(key)
        if (!entry) return
        if (entry.status === 'closed') return
        try {
            // Pass the last-known title so backends that emulate close
            // via title-prefix (Feishu) can preserve the original. TG
            // ignores the param.
            await this.backends.forPlatform(binding.platform)
                .closeThread(binding.chatId, entry.threadId, entry.lastTitle)
        } catch (err: unknown) {
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
                return
            }
            throw err
        }
        entry.status = 'closed'
        entry.closedAt = Date.now()
        this.scheduleSave()
    }

    async syncReopenTopic (binding: ChannelBinding, tabUuid: string): Promise<void> {
        await this.load()
        const key = this.key(binding.id, tabUuid)
        const entry = this.cache.get(key)
        if (!entry) return
        if (entry.status === 'open') return
        try {
            // Restore the pre-close title so Feishu can strip its
            // closed-marker prefix in one edit instead of waiting for
            // syncRetitleTopic to overwrite with '(reopening)'.
            await this.backends.forPlatform(binding.platform)
                .reopenThread(binding.chatId, entry.threadId, entry.lastTitle)
        } catch (err: unknown) {
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
                return
            }
            throw err
        }
        entry.status = 'open'
        entry.closedAt = undefined
        this.scheduleSave()
    }

    async syncRetitleTopic (binding: ChannelBinding, identity: TabIdentity): Promise<void> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const entry = this.cache.get(key)
        if (!entry) return
        const expected = this.formatTitle(identity)
        if (entry.lastTitle === expected) return
        try {
            await this.backends.forPlatform(binding.platform)
                .renameThread(binding.chatId, entry.threadId, expected)
        } catch (err: unknown) {
            if (err instanceof MessagingError && err.kind === 'thread_not_found') {
                this.cache.delete(key)
                this.scheduleSave()
                return
            }
            throw err
        }
        entry.lastTitle = expected
        this.scheduleSave()
    }

    forgetBinding (bindingId: string): Promise<void> {
        const prefix = `${bindingId}|`
        let changed = false
        for (const k of [...this.cache.keys()]) {
            if (k.startsWith(prefix)) {
                this.cache.delete(k)
                changed = true
            }
        }
        if (changed) this.scheduleSave()
        return Promise.resolve()
    }

    getThreadId (bindingId: string, tabUuid: string): ThreadRef | undefined {
        return this.cache.get(this.key(bindingId, tabUuid))?.threadId
    }

    getEntry (bindingId: string, tabUuid: string): TopicEntry | undefined {
        const e = this.cache.get(this.key(bindingId, tabUuid))
        return e ? { ...e } : undefined
    }

    getStatsForBinding (bindingId: string): { open: number; closed: number } {
        const prefix = `${bindingId}|`
        let open = 0
        let closed = 0
        for (const [k, v] of this.cache) {
            if (!k.startsWith(prefix)) continue
            if (v.status === 'closed') closed++
            else open++
        }
        return { open, closed }
    }

    async findByThread (bindingId: string, threadId: ThreadRef): Promise<string | undefined> {
        await this.load()
        const prefix = `${bindingId}|`
        for (const [k, v] of this.cache) {
            if (v.threadId === threadId && k.startsWith(prefix)) {
                return k.substring(prefix.length)
            }
        }
        return undefined
    }

    private key (bindingId: string, tabUuid: string): string {
        return `${bindingId}|${tabUuid}`
    }

    /** Public so TopicSyncService can diff against entry.lastTitle. */
    formatTitle (identity: TabIdentity): string {
        const suffix = identity.uuid.slice(-4)
        return `#${identity.displayIndex} · ${identity.name} · ${suffix}`
    }

    private async load (): Promise<void> {
        if (this.loaded) return
        if (this.loadPromise) return this.loadPromise
        this.loadPromise = (async () => {
            try {
                const raw = await fs.readFile(TopicService.FILE, 'utf8')
                const parsed = JSON.parse(raw) as Record<string, Partial<TopicEntry> & { threadId?: number | string }>
                this.cache = new Map()
                for (const [k, v] of Object.entries(parsed)) {
                    const migrated = this.migrate(v)
                    // Drop unsalvageable entries (missing/empty threadId,
                    // hand-edited corruption) rather than poison the cache
                    // with a value that survives migrate but fails every
                    // backend call — Number('') is 0, not NaN, so a fallback
                    // empty-string threadId would silently route every send
                    // for that tab to a phantom thread_id=0.
                    if (!migrated) {
                        // eslint-disable-next-line no-console
                        console.warn('[mobile-bridge:topic] dropping corrupt cache entry:', k)
                        continue
                    }
                    this.cache.set(k, migrated)
                }
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    // eslint-disable-next-line no-console
                    console.warn('[mobile-bridge:topic] load failed, starting empty:', err)
                }
                this.cache = new Map()
            } finally {
                this.loaded = true
            }
        })()
        return this.loadPromise
    }

    /**
     * Schema migration. Old entries (pre-Phase-1) stored threadId as a
     * number — stringify on load. Pre-sync builds didn't have `status`
     * — assume open. Forward-only: next save writes the migrated shape.
     *
     * Returns null for entries with missing / empty threadId. The caller
     * drops those rather than persist a poisoned cache row that would
     * fail every subsequent backend call.
     */
    private migrate (raw: Partial<TopicEntry> & { threadId?: number | string }): TopicEntry | null {
        const threadIdRaw = raw.threadId
        if (threadIdRaw === undefined || threadIdRaw === null || threadIdRaw === '') {
            return null
        }
        const threadId = typeof threadIdRaw === 'number'
            ? String(threadIdRaw)
            : threadIdRaw
        return {
            threadId,
            lastTitle: raw.lastTitle ?? '',
            status: raw.status ?? 'open',
            closedAt: raw.closedAt,
        }
    }

    private scheduleSave (): void {
        if (this.saveTimer) clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null
            void this.flush().catch(err => {
                // eslint-disable-next-line no-console
                console.warn('[mobile-bridge:topic] save failed:', err)
            })
        }, 200)
    }

    private async flush (): Promise<void> {
        const dir = path.dirname(TopicService.FILE)
        await fs.mkdir(dir, { recursive: true })
        const obj: Record<string, TopicEntry> = {}
        for (const [k, v] of this.cache) obj[k] = v
        await fs.writeFile(TopicService.FILE, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 })
    }
}
