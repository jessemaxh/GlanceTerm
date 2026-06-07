import { Injectable } from '@angular/core'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

import { ChannelBinding } from '../binding/types'
import { TabIdentity } from '../tab-identity.service'
import { TelegramClientService, TelegramApiError } from './client.service'

/** Persisted cache entry: which thread_id we created for a given tab,
 *  plus the title we last pushed so we can detect renames. */
interface TopicEntry {
    threadId: number
    lastTitle: string
}

/**
 * Per-tab Forum Topic lifecycle, keyed by `(bindingId, tabUuid)`.
 *
 * The Telegram Bot API has no "list topics" endpoint — once you create
 * a topic, you only know its thread_id by remembering it. So we persist
 * the (bindingId, tabUuid) → thread_id map to disk. Lose the cache,
 * lose the linkage: subsequent events would create *new* topics and
 * the old ones become orphans (still visible in the supergroup, just
 * not receiving messages). That's annoying but not data-loss; v0 wears it.
 *
 * Topic title format (per docs/todo-mobile-bridge.md):
 *     #<displayIndex> · <tab-name> · <uuid-suffix>
 * where uuid-suffix is the last 4 chars of the UUID for disambiguation
 * when two tabs share a name. We rebuild on every sync — if the user
 * reorders tabs, displayIndex drifts and we re-edit.
 *
 * Lazy-create: `ensureTopic` only creates a topic the first time we
 * actually need to send a message to that tab. Tabs that never emit
 * an event don't spam the supergroup with empty topics.
 */
@Injectable()
export class TopicService {
    private static readonly FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge-topics.json')

    private cache = new Map<string, TopicEntry>()
    private loaded = false
    private loadPromise: Promise<void> | null = null
    private saveTimer: ReturnType<typeof setTimeout> | null = null

    constructor (private telegram: TelegramClientService) {}

    /**
     * Resolve the thread_id for `(binding, identity)`, creating the
     * Forum Topic on Telegram if we've never seen this tab before.
     *
     * Concurrency note: if two callers race for the same (bindingId,
     * tabUuid), both could end up calling createForumTopic — we'd
     * leak one orphan topic per race. v0 accepts this; in practice
     * event sources are serialized through a single RxJS subscription.
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
        const name = this.formatTitle(identity)
        const created = await this.telegram.createForumTopic(Number(binding.chatId), name)
        this.cache.set(key, { threadId: created.message_thread_id, lastTitle: name })
        this.scheduleSave()
        return created.message_thread_id
    }

    /**
     * Update the topic title if the formatted title has changed since
     * we last sent one. Safe to call eagerly — it's a no-op when
     * nothing changed.
     *
     * Failure modes:
     *   - Cache miss → no topic exists yet; do nothing (ensureTopic
     *     will create with the current title next call).
     *   - Telegram rejects the edit → log and clear the lastTitle so
     *     we retry on next call.
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

    private key (bindingId: string, tabUuid: string): string {
        return `${bindingId}|${tabUuid}`
    }

    private formatTitle (identity: TabIdentity): string {
        const suffix = identity.uuid.slice(-4)
        return `#${identity.displayIndex} · ${identity.name} · ${suffix}`
    }

    private async load (): Promise<void> {
        if (this.loaded) return
        if (this.loadPromise) return this.loadPromise
        this.loadPromise = (async () => {
            try {
                const raw = await fs.readFile(TopicService.FILE, 'utf8')
                const parsed = JSON.parse(raw) as Record<string, TopicEntry>
                this.cache = new Map(Object.entries(parsed))
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
