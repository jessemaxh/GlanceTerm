import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

import { ChannelBinding } from '../binding/types'
import { TabIdentity } from '../tab-identity.service'
import { TelegramClientService, TelegramApiError } from './client.service'

/**
 * Persisted cache entry: which thread_id we created for a given tab,
 * the title we last pushed (rename detection), and the open/closed
 * state mirror so we can tell "tab still alive" from "tab was closed,
 * topic is archived." `closedAt` doubles as audit + future TTL hook.
 */
export interface TopicEntry {
    threadId: number
    lastTitle: string
    /** 'open' = tab still alive (or freshly created); 'closed' = tab is gone,
     *  topic is archived on Telegram's side. Defaults to 'open' for entries
     *  written by pre-sync builds (see {@link TopicService.migrate}). */
    status: 'open' | 'closed'
    /** Wall-clock ms when we last flipped to 'closed'. Undefined for
     *  entries that have never been closed. */
    closedAt?: number
}

/**
 * Per-tab Forum Topic lifecycle cache, keyed by `(bindingId, tabUuid)`.
 *
 * Two writers:
 *   - TopicSyncService — proactive create/close/reopen driven by diffs
 *     between TabIdentityService.identities$ and this cache.
 *   - Outbound dispatcher (via {@link ensureTopic}) — last-resort lazy
 *     create + read-only lookup on the send path, for the early-launch
 *     race window where sync hasn't reconciled yet.
 *
 * The Telegram Bot API has no "list topics" endpoint — once you create
 * a topic, you only know its thread_id by remembering it. So we persist
 * the (bindingId, tabUuid) → entry map to disk. Lose the cache, lose the
 * linkage: subsequent events create *new* topics and the old ones become
 * orphans (still visible in the supergroup, just not receiving messages).
 *
 * Topic title format:
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
    /**
     * In-flight `createForumTopic` dedup. Two concurrent callers for the
     * same (bindingId, tabUuid) used to both issue createForumTopic to
     * Telegram, leaking orphan topics. Worse: in chats near the 250
     * active-topics ceiling, the second create would 4xx and burn the
     * retryWithBackoff budget. Now the second caller shares the first
     * caller's promise.
     */
    private inFlight = new Map<string, Promise<number>>()

    constructor (private telegram: TelegramClientService) {}

    /**
     * Resolve the thread_id for `(binding, identity)`, creating the
     * Forum Topic on Telegram if we've never seen this tab before.
     *
     * Post-TopicSyncService era this path is a FALLBACK — sync normally
     * creates the topic proactively when the tab appears. ensureTopic
     * still creates as a safety net for the early-launch race where a
     * send arrives before sync has reconciled, and for any path that
     * doesn't go through sync (e.g. PermissionRelayService bypasses
     * sync entirely today).
     *
     * If the cache entry is `closed`, we DON'T auto-reopen here — the
     * caller (typically dispatcher) handles the TOPIC_CLOSED error
     * explicitly so reopen is an informed decision, not a hidden side
     * effect of a cache lookup.
     */
    async ensureTopic (binding: ChannelBinding, identity: TabIdentity): Promise<number> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const cached = this.cache.get(key)
        if (cached) {
            // Title is stale if displayIndex or name changed since last sync.
            // syncTitle is best-effort — failure here doesn't block the
            // caller, who probably wants to send a message regardless.
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
                const created = await this.telegram.createForumTopic(Number(binding.chatId), name)
                this.cache.set(key, {
                    threadId: created.message_thread_id,
                    lastTitle: name,
                    status: 'open',
                })
                this.scheduleSave()
                return created.message_thread_id
            } finally {
                this.inFlight.delete(key)
            }
        })()
        this.inFlight.set(key, promise)
        return promise
    }

    /**
     * Update the topic title if the formatted title has changed since
     * we last sent one. Safe to call eagerly — it's a no-op when
     * nothing changed.
     */
    async syncTitle (binding: ChannelBinding, identity: TabIdentity): Promise<void> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const entry = this.cache.get(key)
        if (!entry) return
        const expected = this.formatTitle(identity)
        if (entry.lastTitle === expected) return
        try {
            await this.telegram.editForumTopic(Number(binding.chatId), entry.threadId, expected)
            entry.lastTitle = expected
            this.scheduleSave()
        } catch (err: unknown) {
            // 400 from Telegram when the topic was deleted user-side. Drop
            // the cache entry so ensureTopic re-creates next call.
            if (err instanceof TelegramApiError && err.code === 400) {
                this.cache.delete(key)
                this.scheduleSave()
            }
            throw err
        }
    }

    // ---- TopicSyncService surface (proactive lifecycle) ----------------

    /**
     * Snapshot of all entries for one binding. Returned as a plain array
     * of `{tabUuid, entry}` pairs so the sync service can diff against
     * the current identities list without exposing the cache Map.
     */
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

    /**
     * Idempotent create from the sync path. If we already have a cache
     * entry (open or closed) we return its threadId without hitting
     * Telegram — sync should call `reopenIfClosed` separately to flip
     * status. If there's no entry, we create the topic and store it.
     *
     * Shares the same in-flight dedup as ensureTopic so a sync call and
     * a parallel dispatch send don't both create.
     */
    async syncCreateTopic (binding: ChannelBinding, identity: TabIdentity): Promise<number> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const cached = this.cache.get(key)
        if (cached) return cached.threadId
        const inFlight = this.inFlight.get(key)
        if (inFlight) return inFlight

        const promise = (async () => {
            try {
                const name = this.formatTitle(identity)
                const created = await this.telegram.createForumTopic(Number(binding.chatId), name)
                this.cache.set(key, {
                    threadId: created.message_thread_id,
                    lastTitle: name,
                    status: 'open',
                })
                this.scheduleSave()
                return created.message_thread_id
            } finally {
                this.inFlight.delete(key)
            }
        })()
        this.inFlight.set(key, promise)
        return promise
    }

    /**
     * Called by sync when the topic's underlying tab vanished. Hits the
     * Telegram closeForumTopic endpoint and flips the cache entry to
     * 'closed' on success. No-op if the entry is already closed or
     * doesn't exist (lost cache, nothing to archive).
     */
    async syncCloseTopic (binding: ChannelBinding, tabUuid: string): Promise<void> {
        await this.load()
        const key = this.key(binding.id, tabUuid)
        const entry = this.cache.get(key)
        if (!entry) return
        if (entry.status === 'closed') return
        try {
            await this.telegram.closeForumTopic(Number(binding.chatId), entry.threadId)
        } catch (err: unknown) {
            // Topic already deleted user-side: drop the cache entry so a
            // future create would mint a fresh thread instead of trying
            // to address the dead one.
            if (err instanceof TelegramApiError && err.code === 400) {
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

    /**
     * Reopen a closed topic. Called by sync when a tab with a closed
     * cache entry comes back (e.g. relaunch + tab restore — though note
     * tab restore mints a NEW uuid in TabIdentityService, so the typical
     * trigger is dispatcher's TOPIC_CLOSED → reopen + retry race).
     */
    async syncReopenTopic (binding: ChannelBinding, tabUuid: string): Promise<void> {
        await this.load()
        const key = this.key(binding.id, tabUuid)
        const entry = this.cache.get(key)
        if (!entry) return
        if (entry.status === 'open') return
        try {
            await this.telegram.reopenForumTopic(Number(binding.chatId), entry.threadId)
        } catch (err: unknown) {
            if (err instanceof TelegramApiError && err.code === 400) {
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

    /** Drop all cached topics for a binding — called when binding is removed. */
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
        // Note: existing topics on the Telegram side stay around — we
        // intentionally don't auto-delete them (the user may want the
        // chat history). They'll be orphans receiving no new messages.
        return Promise.resolve()
    }

    /** Lookup without create — for diagnostics / tests. */
    getThreadId (bindingId: string, tabUuid: string): number | undefined {
        return this.cache.get(this.key(bindingId, tabUuid))?.threadId
    }

    /**
     * Sync count of (open, closed) entries for a binding. Used by the
     * settings UI to show "12 open · 3 archived" without subscribing to
     * a per-mutation event stream. Returns zeros if load() hasn't run
     * yet — the UI tolerates the early-render gap (settings panel is
     * usually opened well after launch).
     */
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

    /** Lookup full entry (status-aware callers). */
    getEntry (bindingId: string, tabUuid: string): TopicEntry | undefined {
        const e = this.cache.get(this.key(bindingId, tabUuid))
        return e ? { ...e } : undefined
    }

    /**
     * Reverse lookup: given a Telegram thread_id seen on an inbound
     * message, find the originating tab UUID for that binding. Linear
     * scan of the cache — fine for v0 (cache size = # of tabs ever
     * messaged, expected dozens at most). Promote to a reverse map if
     * the scan ever shows up in a profile.
     */
    async findByThread (bindingId: string, threadId: number): Promise<string | undefined> {
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

    /** Public so TopicSyncService can compare against entry.lastTitle. */
    formatTitle (identity: TabIdentity): string {
        const suffix = identity.uuid.slice(-4)
        return `#${identity.displayIndex} · ${identity.name} · ${suffix}`
    }

    /**
     * Push a new title to Telegram for an existing topic and update the
     * cache. Used by sync to react to displayIndex / name changes. Returns
     * silently if the entry is gone or the title is already current.
     */
    async syncRetitleTopic (binding: ChannelBinding, identity: TabIdentity): Promise<void> {
        await this.load()
        const key = this.key(binding.id, identity.uuid)
        const entry = this.cache.get(key)
        if (!entry) return
        const expected = this.formatTitle(identity)
        if (entry.lastTitle === expected) return
        try {
            await this.telegram.editForumTopic(Number(binding.chatId), entry.threadId, expected)
        } catch (err: unknown) {
            if (err instanceof TelegramApiError && err.code === 400) {
                // Topic deleted user-side. Drop the entry so the next
                // sync tick re-creates from scratch.
                this.cache.delete(key)
                this.scheduleSave()
                return
            }
            throw err
        }
        entry.lastTitle = expected
        this.scheduleSave()
    }

    private async load (): Promise<void> {
        if (this.loaded) return
        if (this.loadPromise) return this.loadPromise
        this.loadPromise = (async () => {
            try {
                const raw = await fs.readFile(TopicService.FILE, 'utf8')
                const parsed = JSON.parse(raw) as Record<string, Partial<TopicEntry>>
                this.cache = new Map()
                for (const [k, v] of Object.entries(parsed)) {
                    this.cache.set(k, this.migrate(v))
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
     * Schema migration for entries persisted by pre-sync builds. The
     * status field didn't exist there — every persisted entry was
     * implicitly "open" since closing wasn't possible. closedAt stays
     * undefined; closing reopened topics is harmless.
     *
     * We tolerate Partial<TopicEntry> on the way in so a future hand-
     * edit of the JSON file that drops a field doesn't crash load.
     */
    private migrate (raw: Partial<TopicEntry>): TopicEntry {
        return {
            threadId: raw.threadId ?? 0,
            lastTitle: raw.lastTitle ?? '',
            status: raw.status ?? 'open',
            closedAt: raw.closedAt,
        }
    }

    /**
     * Coalesce writes — title syncs can fire in bursts on app launch
     * as identities$ replays the current tab list. 200 ms is short
     * enough that we don't lose more than one burst to a crash and
     * long enough to absorb a typical startup flurry into one fsync.
     */
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
